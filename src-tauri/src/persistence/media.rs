use super::{BlobMetadata, BlobStore, ImportBlobRequest};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};
use wait_timeout::ChildExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaMetadata {
    pub kind: String,
    pub container: String,
    pub codecs: Vec<String>,
    pub duration_seconds: f64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u16>,
    pub playable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub playback_warning: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedMedia {
    #[serde(skip_serializing)]
    pub blob: BlobMetadata,
    pub hash: String,
    pub size_bytes: u64,
    pub media_type: String,
    pub original_name: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub metadata: MediaMetadata,
    pub poster_hash: Option<String>,
    pub start_frame_hash: Option<String>,
    pub end_frame_hash: Option<String>,
    pub result_id: Option<String>,
    pub asset_id: Option<String>,
    pub stage_id: Option<String>,
}

#[cfg(test)]
pub fn import_media(
    store: &BlobStore,
    request: ImportBlobRequest,
    expected: &str,
) -> Result<ImportedMedia, String> {
    let cancelled = AtomicBool::new(false);
    let blob = snapshot_media(store, request, &cancelled)?;
    inspect_media(store, blob, expected, &cancelled)
}

pub fn snapshot_media(
    store: &BlobStore,
    request: ImportBlobRequest,
    cancelled: &AtomicBool,
) -> Result<BlobMetadata, String> {
    let size = std::fs::metadata(&request.path)
        .map_err(|_| "Die Mediendatei existiert nicht.".to_string())?;
    if !size.is_file() || size.len() == 0 || size.len() > 4 * 1024 * 1024 * 1024 {
        return Err("Medienimporte müssen zwischen 1 Byte und 4 GiB groß sein.".into());
    }
    store.import_cancellable(
        ImportBlobRequest {
            path: request.path,
            media_type: Some("application/octet-stream".into()),
            original_name: request.original_name,
        },
        Some(cancelled),
    )
}

pub fn inspect_media(
    store: &BlobStore,
    staged: BlobMetadata,
    expected: &str,
    cancelled: &AtomicBool,
) -> Result<ImportedMedia, String> {
    if expected != "video" && expected != "audio" {
        return Err("Unbekannter Medientyp.".into());
    }
    // Snapshot first: every byte inspected by ffprobe/ffmpeg is the immutable CAS
    // object that downstream nodes will receive, never a mutable source path.
    let cas_path = store.path_for_hash(&staged.hash)?;
    validate_magic(&cas_path, expected)?;
    let metadata = probe(&cas_path, expected, cancelled)?;
    let poster = if expected == "video" {
        Some(create_poster(store, &cas_path, cancelled)?)
    } else {
        None
    };
    let blob =
        store.set_media_type(&staged.hash, &canonical_mime(expected, &metadata.container))?;
    Ok(ImportedMedia {
        hash: blob.hash.clone(),
        size_bytes: blob.size_bytes,
        media_type: blob.media_type.clone(),
        original_name: blob.original_name.clone(),
        created_at: blob.created_at,
        blob,
        metadata,
        poster_hash: poster.map(|item| item.hash),
        start_frame_hash: None,
        end_frame_hash: None,
        result_id: None,
        asset_id: None,
        stage_id: None,
    })
}

fn validate_magic(path: &Path, expected: &str) -> Result<(), String> {
    let mut file = File::open(path).map_err(|_| "Die Mediendatei existiert nicht.".to_string())?;
    let mut head = [0_u8; 16];
    let read = file.read(&mut head).map_err(|error| error.to_string())?;
    let head = &head[..read];
    let mp4 = head.len() >= 12 && &head[4..8] == b"ftyp";
    let webm = head.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]);
    let ogg = head.starts_with(b"OggS");
    let wav = head.starts_with(b"RIFF") && head.get(8..12) == Some(b"WAVE");
    let flac = head.starts_with(b"fLaC");
    let mp3 =
        head.starts_with(b"ID3") || (head.len() >= 2 && head[0] == 0xff && head[1] & 0xe0 == 0xe0);
    let video_magic = mp4 || webm;
    let audio_magic = mp4 || webm || ogg || wav || flac || mp3;
    if (expected == "video" && !video_magic) || (expected == "audio" && !audio_magic) {
        return Err(format!(
            "Die Datei ist anhand ihrer Signatur kein unterstütztes {expected}."
        ));
    }
    Ok(())
}

fn probe(path: &Path, expected: &str, cancelled: &AtomicBool) -> Result<MediaMetadata, String> {
    const PROBE_OUTPUT_LIMIT: usize = 256 * 1024;
    let mut child = Command::new(resolve_media_tool("ffprobe")?)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=format_name,duration:stream=codec_type,codec_name,duration,width,height,r_frame_rate,sample_rate,channels",
            "-of",
            "json",
        ])
        .arg(path)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "ffprobe konnte nicht gestartet werden.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "ffprobe-Ausgabe ist nicht verfügbar.".to_string())?;
    // Drain stdout concurrently, but retain at most limit + 1 bytes. This bounds
    // memory/disk while ffprobe is running instead of checking an unbounded file
    // only after the subprocess has completed.
    let reader = thread::spawn(move || {
        let mut bytes = Vec::with_capacity(PROBE_OUTPUT_LIMIT.min(16 * 1024));
        stdout
            .take((PROBE_OUTPUT_LIMIT + 1) as u64)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let status = wait_with_cancel(&mut child, Duration::from_secs(20), cancelled)?;
    let bytes = reader
        .join()
        .map_err(|_| "ffprobe-Ausgabe wurde unerwartet beendet.".to_string())?
        .map_err(|_| "ffprobe-Ausgabe konnte nicht gelesen werden.".to_string())?;
    if bytes.len() > 256 * 1024 {
        return Err("Decoder-Metadaten überschreiten das sichere Limit.".into());
    }
    if !status.is_some_and(|status| status.success()) {
        return Err("Der Mediendecoder konnte die Datei nicht öffnen.".into());
    }
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| "Ungültige Decoder-Metadaten.".to_string())?;
    parse_probe_metadata(&value, expected)
}

fn parse_probe_metadata(value: &Value, expected: &str) -> Result<MediaMetadata, String> {
    let streams = value["streams"]
        .as_array()
        .ok_or("Die Datei enthält keine decodierbaren Spuren.")?;
    if streams.is_empty() || streams.len() > 16 {
        return Err("Medien dürfen höchstens 16 decodierbare Spuren enthalten.".into());
    }
    if streams.iter().any(|stream| {
        stream
            .get("codec_type")
            .and_then(Value::as_str)
            .is_none_or(|value| value.is_empty() || value.len() > 16)
            || stream
                .get("codec_name")
                .and_then(Value::as_str)
                .is_none_or(|value| value.is_empty() || value.len() > 64)
    }) {
        return Err("Decoder-Spurmetadaten sind ungültig oder zu lang.".into());
    }
    let expected_stream = streams
        .iter()
        .find(|stream| stream["codec_type"] == expected)
        .ok_or_else(|| format!("Die Datei enthält keine decodierbare {expected}-Spur."))?;
    if expected == "audio" && streams.iter().any(|stream| stream["codec_type"] == "video") {
        return Err("Eine Videodatei kann nicht als reiner Audio-Import verwendet werden.".into());
    }
    let duration_seconds = value
        .pointer("/format/duration")
        .and_then(Value::as_str)
        .and_then(|v| v.parse().ok())
        .or_else(|| value.pointer("/format/duration").and_then(Value::as_f64))
        .or_else(|| {
            expected_stream["duration"]
                .as_str()
                .and_then(|v| v.parse().ok())
        })
        .or_else(|| expected_stream["duration"].as_f64())
        .unwrap_or(0.0);
    if !duration_seconds.is_finite() || duration_seconds <= 0.0 || duration_seconds > 604_800.0 {
        return Err("Die Mediendauer ist ungültig oder unbekannt.".into());
    }
    let codecs: Vec<String> = streams
        .iter()
        .filter_map(|stream| stream["codec_name"].as_str().map(str::to_owned))
        .collect();
    let rate = expected_stream["r_frame_rate"]
        .as_str()
        .and_then(parse_rate)
        .filter(|v| v.is_finite() && *v > 0.0 && *v <= 1_000.0);
    let width = expected_stream["width"]
        .as_u64()
        .and_then(|v| u32::try_from(v).ok())
        .filter(|v| *v > 0 && *v <= 32_768);
    let height = expected_stream["height"]
        .as_u64()
        .and_then(|v| u32::try_from(v).ok())
        .filter(|v| *v > 0 && *v <= 32_768);
    let sample_rate = expected_stream["sample_rate"]
        .as_str()
        .and_then(|v| v.parse().ok())
        .filter(|v| *v > 0 && *v <= 768_000);
    let channels = expected_stream["channels"]
        .as_u64()
        .and_then(|v| u16::try_from(v).ok())
        .filter(|v| *v > 0 && *v <= 64);
    if expected == "video" && (width.is_none() || height.is_none() || rate.is_none()) {
        return Err(
            "Der Decoder konnte Auflösung oder Bildrate nicht zuverlässig bestimmen.".into(),
        );
    }
    if expected == "video"
        && u64::from(width.unwrap_or_default()) * u64::from(height.unwrap_or_default())
            > 134_217_728
    {
        return Err("Die Video-Auflösung überschreitet das sichere Pixel-Limit.".into());
    }
    if expected == "audio" && (sample_rate.is_none() || channels.is_none()) {
        return Err(
            "Der Decoder konnte Samplerate oder Kanalzahl nicht zuverlässig bestimmen.".into(),
        );
    }
    let playable_codecs = [
        "h264",
        "hevc",
        "vp8",
        "vp9",
        "av1",
        "aac",
        "opus",
        "vorbis",
        "mp3",
        "flac",
        "alac",
        "pcm_u8",
        "pcm_s16le",
        "pcm_s24le",
        "pcm_f32le",
    ];
    let unsupported: Vec<_> = codecs
        .iter()
        .filter(|codec| !playable_codecs.contains(&codec.as_str()))
        .cloned()
        .collect();
    let container = value
        .pointer("/format/format_name")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_owned();
    if container.is_empty() || container.len() > 120 {
        return Err("Der Containername ist ungültig oder zu lang.".into());
    }
    let webm_mismatch = container.contains("webm")
        && codecs
            .iter()
            .any(|codec| !["vp8", "vp9", "av1", "opus", "vorbis"].contains(&codec.as_str()));
    let playable = unsupported.is_empty() && !webm_mismatch;
    Ok(MediaMetadata {
        kind: expected.into(),
        container,
        codecs,
        duration_seconds,
        width,
        height,
        fps: rate,
        sample_rate,
        channels,
        playable,
        playback_warning: (!playable).then(|| if webm_mismatch { "Container und Codecs sind nicht WebM-kompatibel; das Original bleibt für Verarbeitung erhalten.".into() } else { format!("Keine integrierte Vorschau für Codec: {}", unsupported.join(", ")) }),
    })
}

fn parse_rate(value: &str) -> Option<f64> {
    let (a, b) = value.split_once('/')?;
    let (a, b): (f64, f64) = (a.parse().ok()?, b.parse().ok()?);
    (b != 0.0).then_some(a / b)
}

fn canonical_mime(kind: &str, container: &str) -> String {
    if container.contains("webm") {
        format!("{kind}/webm")
    } else if kind == "audio" && container.contains("wav") {
        "audio/wav".into()
    } else if kind == "audio" && container.contains("flac") {
        "audio/flac".into()
    } else if kind == "audio" && container.contains("mp3") {
        "audio/mpeg".into()
    } else if kind == "audio" && container.contains("ogg") {
        "audio/ogg".into()
    } else {
        format!("{kind}/mp4")
    }
}

fn create_poster(
    store: &BlobStore,
    path: &Path,
    cancelled: &AtomicBool,
) -> Result<BlobMetadata, String> {
    let output_path =
        std::env::temp_dir().join(format!("flowz-poster-{}.jpg", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut child = Command::new(resolve_media_tool("ffmpeg")?)
            .args(["-v", "error", "-ss", "0", "-i"])
            .arg(path)
            .args([
                "-frames:v",
                "1",
                "-vf",
                "scale=min(960\\,iw):-2",
                "-q:v",
                "4",
                "-y",
            ])
            .arg(&output_path)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "ffmpeg fehlt.".to_string())?;
        let status = wait_with_cancel(&mut child, Duration::from_secs(45), cancelled)?;
        if !status.is_some_and(|status| status.success()) {
            return Err("Videoposter konnte nicht erzeugt werden.".into());
        }
        store.import(ImportBlobRequest {
            path: output_path.clone(),
            media_type: Some("image/jpeg".into()),
            original_name: Some("flowz-video-poster.jpg".into()),
        })
    })();
    let _ = std::fs::remove_file(output_path);
    result
}

/// Extracts a real frame from the immutable CAS video and imports the PNG back
/// into CAS. `seconds` is clamped to the final decodable instant by ffmpeg.
pub fn extract_video_frame(
    store: &BlobStore,
    video_hash: &str,
    seconds: f64,
) -> Result<BlobMetadata, String> {
    if !seconds.is_finite() || seconds < 0.0 {
        return Err("Die Frame-Position ist ungültig.".into());
    }
    let source = store.path_for_hash(video_hash)?;
    let target = std::env::temp_dir().join(format!("flowz-frame-{}.png", uuid::Uuid::new_v4()));
    let result = (|| {
        let status = Command::new(resolve_media_tool("ffmpeg")?)
            .args(["-v", "error", "-ss", &format!("{seconds:.6}"), "-i"])
            .arg(&source)
            .args(["-frames:v", "1", "-f", "image2", "-y"])
            .arg(&target)
            .status()
            .map_err(|error| format!("Frame-Extraktion konnte nicht gestartet werden: {error}"))?;
        if !status.success() {
            return Err(
                "Aus diesem Video konnte an der gewählten Position kein Frame extrahiert werden."
                    .into(),
            );
        }
        let bytes = std::fs::read(&target).map_err(|error| error.to_string())?;
        image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
            .map_err(|_| "Der extrahierte Frame ist beschädigt.".to_string())?;
        store.import_bytes(&bytes, "image/png".into(), Some("Video-Frame.png".into()))
    })();
    let _ = std::fs::remove_file(target);
    result
}

fn wait_with_cancel(
    child: &mut Child,
    timeout: Duration,
    cancelled: &AtomicBool,
) -> Result<Option<ExitStatus>, String> {
    let started = Instant::now();
    loop {
        if cancelled.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Medienimport abgebrochen.".into());
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Medienwerkzeug hat das Zeitlimit überschritten.".into());
        }
        if let Some(status) = child
            .wait_timeout(Duration::from_millis(100))
            .map_err(|error| error.to_string())?
        {
            return Ok(Some(status));
        }
    }
}

pub(crate) fn resolve_media_tool(name: &str) -> Result<PathBuf, String> {
    let target = if cfg!(all(target_arch = "aarch64", target_os = "macos")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_arch = "x86_64", target_os = "macos")) {
        "x86_64-apple-darwin"
    } else if cfg!(all(target_arch = "x86_64", target_os = "windows")) {
        "x86_64-pc-windows-msvc.exe"
    } else if cfg!(all(target_arch = "x86_64", target_os = "linux")) {
        "x86_64-unknown-linux-gnu"
    } else {
        return Err("Für diese Architektur ist kein Medien-Sidecar konfiguriert.".into());
    };
    resolve_media_tool_from(
        name,
        std::env::current_exe().ok().as_deref(),
        cfg!(debug_assertions),
        Path::new(env!("CARGO_MANIFEST_DIR")),
        target,
    )
}

fn resolve_media_tool_from(
    name: &str,
    current_executable: Option<&Path>,
    debug: bool,
    manifest_dir: &Path,
    target: &str,
) -> Result<PathBuf, String> {
    if !matches!(name, "ffmpeg" | "ffprobe") {
        return Err("Unbekanntes Medienwerkzeug.".into());
    }
    if let Some(executable) = current_executable {
        if let Some(directory) = executable.parent() {
            let bundled = directory.join(name);
            if bundled.is_file() {
                return Ok(bundled);
            }
        }
    }
    if debug {
        let development = manifest_dir
            .join("binaries")
            .join(format!("{name}-{target}"));
        if development.is_file() {
            return Ok(development);
        }
        return Ok(PathBuf::from(name));
    }
    Err(format!(
        "Das gebündelte Medienwerkzeug {name} fehlt oder passt nicht zur Architektur."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rate_parser_is_safe() {
        assert_eq!(parse_rate("30000/1001").unwrap().round(), 30.0);
        assert_eq!(parse_rate("1/0"), None);
    }

    #[test]
    fn resolver_prefers_bundle_and_release_never_falls_back_to_path() {
        let temp = tempfile::tempdir().unwrap();
        let executable = temp.path().join("FlowZ");
        let bundled = temp.path().join("ffprobe");
        std::fs::write(&executable, b"app").unwrap();
        std::fs::write(&bundled, b"sidecar").unwrap();
        assert_eq!(
            resolve_media_tool_from(
                "ffprobe",
                Some(&executable),
                false,
                temp.path(),
                "aarch64-apple-darwin",
            )
            .unwrap(),
            bundled
        );
        std::fs::remove_file(&bundled).unwrap();
        let error = resolve_media_tool_from(
            "ffprobe",
            Some(&executable),
            false,
            temp.path(),
            "aarch64-apple-darwin",
        )
        .unwrap_err();
        assert!(error.contains("gebündelte Medienwerkzeug"));
        assert!(resolve_media_tool_from(
            "curl",
            Some(&executable),
            true,
            temp.path(),
            "aarch64-apple-darwin",
        )
        .is_err());
    }

    #[test]
    fn probe_metadata_is_bounded_before_derivatives_are_created() {
        let valid = serde_json::json!({
            "format": { "format_name": "mov,mp4", "duration": "2.0" },
            "streams": [{ "codec_type": "video", "codec_name": "h264", "duration": "2.0", "width": 1920, "height": 1080, "r_frame_rate": "25/1" }]
        });
        assert!(parse_probe_metadata(&valid, "video").is_ok());
        for (pointer, invalid) in [
            ("/format/duration", serde_json::json!(604801.0)),
            ("/streams/0/width", serde_json::json!(32769)),
            ("/streams/0/height", serde_json::json!(32769)),
            ("/streams/0/r_frame_rate", serde_json::json!("1001/1")),
            ("/streams/0/codec_name", serde_json::json!("x".repeat(65))),
        ] {
            let mut candidate = valid.clone();
            *candidate.pointer_mut(pointer).unwrap() = invalid;
            assert!(
                parse_probe_metadata(&candidate, "video").is_err(),
                "{pointer}"
            );
        }
        let mut too_many = valid.clone();
        too_many["streams"] = Value::Array(vec![valid["streams"][0].clone(); 17]);
        assert!(parse_probe_metadata(&too_many, "video").is_err());
        let huge_pixels = serde_json::json!({
            "format": { "format_name": "mov,mp4", "duration": "2.0" },
            "streams": [{ "codec_type": "video", "codec_name": "h264", "width": 16384, "height": 16384, "r_frame_rate": "25/1" }]
        });
        assert!(parse_probe_metadata(&huge_pixels, "video").is_err());
        let invalid_audio = serde_json::json!({
            "format": { "format_name": "wav", "duration": "2.0" },
            "streams": [{ "codec_type": "audio", "codec_name": "pcm_s16le", "sample_rate": "768001", "channels": 65 }]
        });
        assert!(parse_probe_metadata(&invalid_audio, "audio").is_err());
    }

    #[test]
    fn real_decoder_validates_and_imports_wav_into_cas() {
        if resolve_media_tool("ffprobe").is_err() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("tone.wav");
        let samples = vec![128_u8; 8_000];
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36_u32 + samples.len() as u32).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16_u32.to_le_bytes());
        wav.extend_from_slice(&1_u16.to_le_bytes());
        wav.extend_from_slice(&1_u16.to_le_bytes());
        wav.extend_from_slice(&8_000_u32.to_le_bytes());
        wav.extend_from_slice(&8_000_u32.to_le_bytes());
        wav.extend_from_slice(&1_u16.to_le_bytes());
        wav.extend_from_slice(&8_u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&(samples.len() as u32).to_le_bytes());
        wav.extend_from_slice(&samples);
        std::fs::write(&path, wav).unwrap();
        let store = BlobStore::new(temp.path().join("cas")).unwrap();
        let imported = import_media(
            &store,
            ImportBlobRequest {
                path,
                media_type: None,
                original_name: Some("tone.wav".into()),
            },
            "audio",
        )
        .unwrap();
        assert_eq!(imported.metadata.sample_rate, Some(8_000));
        assert_eq!(imported.metadata.channels, Some(1));
        assert_eq!(
            store.size(&imported.blob.hash).unwrap(),
            imported.blob.size_bytes
        );
    }

    #[test]
    fn real_video_import_creates_a_decodable_poster() {
        let Ok(ffmpeg) = resolve_media_tool("ffmpeg") else {
            return;
        };
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("clip.mp4");
        let status = Command::new(ffmpeg)
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=blue:s=64x48:d=0.2",
                "-c:v",
                "mpeg4",
                "-pix_fmt",
                "yuv420p",
                "-y",
            ])
            .arg(&path)
            .status();
        if !status.is_ok_and(|status| status.success()) {
            return;
        }
        let store = BlobStore::new(temp.path().join("cas")).unwrap();
        let imported = import_media(
            &store,
            ImportBlobRequest {
                path,
                media_type: None,
                original_name: Some("clip.mp4".into()),
            },
            "video",
        )
        .unwrap();
        let poster = imported.poster_hash.expect("video poster");
        assert_eq!(store.metadata(&poster).unwrap().media_type, "image/jpeg");
        assert!(store.size(&poster).unwrap() > 100);
    }
}
