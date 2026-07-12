use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub const TRANSCRIPTION_CANCELLED: &str = "__FLOWZ_TRANSCRIPTION_CANCELLED__";
pub const MAX_TRANSCRIPTION_BYTES: usize = 25 * 1024 * 1024;
const MAX_TRANSCRIPTION_BASE64_BYTES: usize = MAX_TRANSCRIPTION_BYTES.div_ceil(3) * 4;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTranscription {
    pub text: String,
    pub cost_microunits: Option<i64>,
    pub generation_id: Option<String>,
    pub timestamps: Option<TranscriptionTimestamps>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionTimestamp {
    pub start: f64,
    pub end: f64,
    pub text: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionTimestamps {
    pub segments: Vec<TranscriptionTimestamp>,
    pub words: Vec<TranscriptionTimestamp>,
}

pub fn model_supports_timestamps(model: &str) -> bool {
    // This is deliberately an exact OpenRouter endpoint allowlist, not a family
    // prefix. Each entry must have a successful adapter fixture; whisper-1 also
    // has a live JSON endpoint smoke. New catalog models remain disabled until
    // they pass the same contract checks.
    matches!(
        model,
        "openai/whisper-1" | "openai/whisper-large-v3" | "openai/whisper-large-v3-turbo"
    )
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionRequest {
    pub run_id: String,
    pub project_id: String,
    pub node_id: String,
    pub source_node_id: String,
    pub source_result_id: String,
    pub source_blob_hash: String,
    pub model: String,
    pub language: Option<String>,
    #[serde(default)]
    pub timestamps: bool,
    pub execution_fingerprint: String,
}

pub fn validate_request(request: &TranscriptionRequest) -> Result<(), String> {
    uuid::Uuid::parse_str(&request.run_id).map_err(|_| "Ungültige Run-ID.".to_string())?;
    uuid::Uuid::parse_str(&request.project_id).map_err(|_| "Ungültige Projekt-ID.".to_string())?;
    if request.node_id.is_empty()
        || request.source_node_id.is_empty()
        || request.source_result_id.is_empty()
    {
        return Err("Ziel-Node und Audio-Provenienz werden benötigt.".into());
    }
    if request.source_blob_hash.len() != 64
        || !request
            .source_blob_hash
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err("Ungültige Audio-ID.".into());
    }
    if request.model.trim().is_empty() || request.model.len() > 200 {
        return Err("Ein gültiges Transkriptionsmodell wird benötigt.".into());
    }
    if request.execution_fingerprint.is_empty() || request.execution_fingerprint.len() > 1_000_000 {
        return Err("Ungültiger Ausführungsfingerprint.".into());
    }
    if request.timestamps && !model_supports_timestamps(&request.model) {
        return Err(
            "Für diese STT-Modellfamilie ist kein geprüfter Wort-/Abschnittszeitmarken-Adapter verfügbar.".into(),
        );
    }
    if let Some(language) = normalized_language(request.language.as_deref())? {
        if language.len() != 2
            || !language
                .chars()
                .all(|character| character.is_ascii_lowercase())
        {
            return Err("Sprache muss „Automatisch“ oder ein ISO-639-1-Code sein.".into());
        }
    }
    Ok(())
}

pub fn normalized_language(language: Option<&str>) -> Result<Option<String>, String> {
    let language = language.unwrap_or_default().trim().to_ascii_lowercase();
    if language.is_empty() || language == "auto" {
        return Ok(None);
    }
    if language.len() != 2
        || !language
            .chars()
            .all(|character| character.is_ascii_lowercase())
    {
        return Err("Sprache muss „Automatisch“ oder ein ISO-639-1-Code sein.".into());
    }
    Ok(Some(language))
}

fn format_for_mime(mime_type: &str) -> Result<&'static str, String> {
    match mime_type {
        "audio/wav" => Ok("wav"),
        "audio/mpeg" => Ok("mp3"),
        "audio/flac" => Ok("flac"),
        "audio/ogg" => Ok("ogg"),
        "audio/webm" => Ok("webm"),
        "audio/mp4" => Ok("m4a"),
        _ => Err("Dieses Audioformat wird vom Transkriptions-Upload nicht unterstützt.".into()),
    }
}

fn cost_microunits(data: &Value) -> Option<i64> {
    let raw = data.pointer("/usage/cost")?;
    let text = match raw {
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.clone(),
        _ => return None,
    };
    super::rounded_decimal_to_microunits(&text).ok()
}

fn parse_timestamp_items(
    data: &Value,
    key: &str,
    limit: usize,
) -> Result<Vec<TranscriptionTimestamp>, String> {
    let Some(items) = data.get(key).and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    if items.len() > limit {
        return Err("Die Zeitmarkenantwort überschreitet das sichere Limit.".into());
    }
    items
        .iter()
        .map(|item| {
            let start = item
                .get("start")
                .and_then(Value::as_f64)
                .ok_or_else(|| "Zeitmarke ohne gültigen Start.".to_string())?;
            let end = item
                .get("end")
                .and_then(Value::as_f64)
                .ok_or_else(|| "Zeitmarke ohne gültiges Ende.".to_string())?;
            let text = item
                .get("text")
                .or_else(|| item.get("word"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_owned();
            if !start.is_finite()
                || !end.is_finite()
                || start < 0.0
                || end < start
                || text.is_empty()
                || text.len() > 10_000
            {
                return Err("Ungültige Zeitmarke in der Providerantwort.".into());
            }
            Ok(TranscriptionTimestamp { start, end, text })
        })
        .collect()
}

fn parse_timestamps(data: &Value) -> Result<Option<TranscriptionTimestamps>, String> {
    let segments = parse_timestamp_items(data, "segments", 10_000)?;
    let words = parse_timestamp_items(data, "words", 100_000)?;
    Ok((!segments.is_empty() || !words.is_empty())
        .then_some(TranscriptionTimestamps { segments, words }))
}

fn provider_error(status: StatusCode, body: &[u8], retry_after: Option<&str>) -> String {
    let parsed: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let detail = parsed
        .pointer("/error/message")
        .or_else(|| parsed.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("OpenRouter-Anfrage fehlgeschlagen.");
    let explanation = match status.as_u16() {
        400 => "Die Audiodatei oder die Transkriptionsparameter wurden abgelehnt.",
        402 => "Dein OpenRouter-Guthaben oder das Ausgabenlimit des API-Keys ist ausgeschöpft.",
        413 => "Die Audiodatei überschreitet das Provider-Limit.",
        429 => "Das Transkriptionsmodell hat gerade ein Rate- oder Quota-Limit erreicht.",
        502 | 503 => "Der Transkriptions-Provider ist momentan nicht verfügbar.",
        _ => "OpenRouter konnte die Transkription nicht ausführen.",
    };
    let retry = retry_after
        .map(|value| format!(" Erneut versuchen in etwa {value} Sekunden."))
        .unwrap_or_default();
    format!("{explanation}{retry}\n{detail} ({})", status.as_u16())
}

#[allow(clippy::too_many_arguments)]
pub async fn request_transcription(
    client: &Client,
    endpoint: &str,
    key: &str,
    model: &str,
    audio: Vec<u8>,
    mime_type: &str,
    filename: &str,
    language: Option<&str>,
    timestamps: bool,
    token: &CancellationToken,
) -> Result<ProviderTranscription, String> {
    request_transcription_with_timeout(
        client,
        endpoint,
        key,
        model,
        audio,
        mime_type,
        filename,
        language,
        timestamps,
        token,
        Duration::from_secs(65),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn request_transcription_with_timeout(
    client: &Client,
    endpoint: &str,
    key: &str,
    model: &str,
    audio: Vec<u8>,
    mime_type: &str,
    _filename: &str,
    language: Option<&str>,
    timestamps: bool,
    token: &CancellationToken,
    timeout: Duration,
) -> Result<ProviderTranscription, String> {
    if audio.is_empty() || audio.len() > MAX_TRANSCRIPTION_BYTES {
        return Err("Transkriptionsdateien müssen zwischen 1 Byte und 25 MB groß sein. Teile längere Audios vor der Transkription in kürzere Abschnitte.".into());
    }
    let format = format_for_mime(mime_type)?;
    let encoded_len = audio
        .len()
        .checked_add(2)
        .and_then(|value| value.checked_div(3))
        .and_then(|value| value.checked_mul(4))
        .ok_or_else(|| "Die Audiodatei ist zu groß für die Transkriptionsanfrage.".to_string())?;
    if encoded_len > MAX_TRANSCRIPTION_BASE64_BYTES {
        return Err(
            "Die Base64-kodierte Audiodatei überschreitet das sichere Providerlimit.".into(),
        );
    }
    let encoded = BASE64.encode(audio);
    if encoded.len() != encoded_len {
        return Err("Die Audiodatei konnte nicht sicher kodiert werden.".into());
    }
    let mut body = serde_json::json!({
        "model": model,
        "input_audio": { "data": encoded, "format": format },
    });
    if let Some(language) = normalized_language(language)? {
        body["language"] = Value::String(language);
    }
    if timestamps && !model_supports_timestamps(model) {
        return Err(
            "Für diese STT-Modellfamilie ist kein geprüfter Wort-/Abschnittszeitmarken-Adapter verfügbar.".into(),
        );
    }
    if timestamps {
        body["response_format"] = Value::String("verbose_json".into());
        body["timestamp_granularities"] = serde_json::json!(["word", "segment"]);
    }
    let response = tokio::select! {
        _ = token.cancelled() => return Err(TRANSCRIPTION_CANCELLED.into()),
        response = client
            .post(endpoint)
            .bearer_auth(key)
            .header("HTTP-Referer", "https://flowz.dev")
            .header("X-OpenRouter-Title", "FlowZ")
            .json(&body)
            .timeout(timeout)
            .send() => response.map_err(|error| if error.is_timeout() { "Die Transkription hat das 65-Sekunden-Zeitlimit überschritten.".into() } else { error.to_string() })?,
    };
    let status = response.status();
    let generation_id = response
        .headers()
        .get("x-generation-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let retry_after = response
        .headers()
        .get("retry-after")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let bytes = tokio::select! {
        _ = token.cancelled() => return Err(TRANSCRIPTION_CANCELLED.into()),
        bytes = response.bytes() => bytes.map_err(|error| error.to_string())?,
    };
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("Die Transkriptionsantwort überschreitet das sichere 4-MB-Limit.".into());
    }
    if !status.is_success() {
        return Err(provider_error(status, &bytes, retry_after.as_deref()));
    }
    let data: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "OpenRouter hat keine gültige Transkriptionsantwort geliefert.".to_string())?;
    let text = data
        .get("text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| "Die Transkriptionsantwort enthält keinen Text.".to_string())?
        .to_owned();
    let timestamp_data = parse_timestamps(&data)?;
    Ok(ProviderTranscription {
        text,
        cost_microunits: cost_microunits(&data),
        generation_id: generation_id
            .or_else(|| data.get("id").and_then(Value::as_str).map(str::to_owned)),
        timestamps: timestamp_data,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    async fn mock_once(
        status: u16,
        response_body: &'static str,
        delay: Duration,
    ) -> (String, Arc<Mutex<Vec<u8>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let captured = Arc::new(Mutex::new(Vec::new()));
        let server_capture = captured.clone();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0_u8; 4096];
            loop {
                let read = socket.read(&mut chunk).await.unwrap();
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..read]);
                if let Some(header_end) = request.windows(4).position(|value| value == b"\r\n\r\n")
                {
                    let headers = String::from_utf8_lossy(&request[..header_end]);
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|value| value.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if request.len() >= header_end + 4 + length {
                        break;
                    }
                }
            }
            *server_capture.lock().unwrap() = request;
            tokio::time::sleep(delay).await;
            let reason = if status == 200 { "OK" } else { "Error" };
            let response = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response_body}", response_body.len());
            let _ = socket.write_all(response.as_bytes()).await;
        });
        (format!("http://{address}/audio/transcriptions"), captured)
    }

    #[test]
    fn validates_auto_language_hash_and_limits() {
        assert_eq!(normalized_language(Some(" AUTO ")).unwrap(), None);
        assert_eq!(
            normalized_language(Some("DE")).unwrap().as_deref(),
            Some("de")
        );
        assert!(normalized_language(Some("de-DE")).is_err());
        assert_eq!(format_for_mime("audio/webm").unwrap(), "webm");
        assert!(format_for_mime("video/mp4").is_err());
    }

    #[test]
    fn maps_payment_quota_and_invalid_file_errors() {
        assert!(provider_error(
            StatusCode::PAYMENT_REQUIRED,
            br#"{"error":{"message":"credit"}}"#,
            None
        )
        .contains("Guthaben"));
        assert!(provider_error(
            StatusCode::TOO_MANY_REQUESTS,
            br#"{"error":{"message":"quota"}}"#,
            Some("9")
        )
        .contains("9 Sekunden"));
        assert!(provider_error(
            StatusCode::BAD_REQUEST,
            br#"{"error":{"message":"invalid file"}}"#,
            None
        )
        .contains("Audiodatei"));
    }

    #[test]
    fn exact_cost_uses_integer_microunits() {
        assert_eq!(
            cost_microunits(&serde_json::json!({"usage":{"cost":0.000508}})),
            Some(508)
        );
        assert_eq!(
            cost_microunits(&serde_json::json!({"usage":{"cost":"0.1234567"}})),
            Some(123_457)
        );
    }

    #[test]
    fn timestamps_are_typed_bounded_and_capability_is_honest() {
        assert!(model_supports_timestamps("openai/whisper-1"));
        assert!(model_supports_timestamps("openai/whisper-large-v3"));
        assert!(model_supports_timestamps("openai/whisper-large-v3-turbo"));
        assert!(!model_supports_timestamps("openai/whisper-future"));
        assert!(!model_supports_timestamps("groq/whisper-large-v3"));
        assert!(!model_supports_timestamps("openai/gpt-4o-transcribe"));
        assert!(!model_supports_timestamps("microsoft/mai-transcribe-1.5"));
        let parsed = parse_timestamps(&serde_json::json!({
            "segments":[{"start":0.0,"end":1.25,"text":"Hallo"}],
            "words":[{"start":0.0,"end":0.4,"word":"Hallo"}]
        }))
        .unwrap()
        .unwrap();
        assert_eq!(
            parsed.segments[0],
            TranscriptionTimestamp {
                start: 0.0,
                end: 1.25,
                text: "Hallo".into()
            }
        );
        assert!(parse_timestamps(
            &serde_json::json!({"segments":[{"start":2.0,"end":1.0,"text":"kaputt"}]})
        )
        .is_err());
    }

    #[tokio::test]
    async fn timestamp_adapter_serializes_verbose_request_and_parses_typed_response() {
        let (endpoint, captured) = mock_once(
            200,
            r#"{"text":"Hallo Welt","segments":[{"start":0.0,"end":1.2,"text":"Hallo Welt"}],"words":[{"start":0.0,"end":0.4,"word":"Hallo"},{"start":0.5,"end":1.2,"word":"Welt"}],"usage":{"cost":"0.000002"}}"#,
            Duration::ZERO,
        )
        .await;
        let result = request_transcription_with_timeout(
            &Client::new(),
            &endpoint,
            "secret",
            "openai/whisper-1",
            b"audio-bytes".to_vec(),
            "audio/wav",
            "clip.wav",
            Some("de"),
            true,
            &CancellationToken::new(),
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        let timestamps = result.timestamps.unwrap();
        assert_eq!(timestamps.segments.len(), 1);
        assert_eq!(timestamps.words.len(), 2);
        assert_eq!(timestamps.words[1].text, "Welt");
        let request = captured.lock().unwrap().clone();
        let request = String::from_utf8_lossy(&request);
        let body: Value = serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(body["response_format"], "verbose_json");
        assert_eq!(
            body["timestamp_granularities"],
            serde_json::json!(["word", "segment"])
        );
        assert_eq!(body["language"], "de");
    }

    #[tokio::test]
    async fn json_mock_encodes_audio_and_omits_auto_language() {
        let (endpoint, captured) = mock_once(
            200,
            r#"{"text":"Hallo","usage":{"cost":"0.000001"}}"#,
            Duration::ZERO,
        )
        .await;
        let result = request_transcription_with_timeout(
            &Client::new(),
            &endpoint,
            "secret",
            "openai/whisper-1",
            b"audio-bytes".to_vec(),
            "audio/webm",
            "clip.webm",
            Some("auto"),
            false,
            &CancellationToken::new(),
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        assert_eq!(result.text, "Hallo");
        assert_eq!(result.cost_microunits, Some(1));
        let request = captured.lock().unwrap().clone();
        let request = String::from_utf8_lossy(&request);
        assert!(request.contains("content-type: application/json"));
        let raw_body = request.split("\r\n\r\n").nth(1).unwrap();
        let body: Value = serde_json::from_str(raw_body).unwrap();
        assert_eq!(body["model"], "openai/whisper-1");
        assert_eq!(body["input_audio"]["format"], "webm");
        assert_eq!(body["input_audio"]["data"], BASE64.encode(b"audio-bytes"));
        assert!(body.get("language").is_none());
    }

    #[tokio::test]
    async fn mock_maps_402_429_invalid_file_and_timeout() {
        for (status, needle) in [(402, "Guthaben"), (429, "Quota"), (400, "Audiodatei")] {
            let (endpoint, _) = mock_once(
                status,
                r#"{"error":{"message":"provider detail"}}"#,
                Duration::ZERO,
            )
            .await;
            let error = request_transcription_with_timeout(
                &Client::new(),
                &endpoint,
                "secret",
                "model",
                vec![1],
                "audio/wav",
                "a.wav",
                None,
                false,
                &CancellationToken::new(),
                Duration::from_secs(1),
            )
            .await
            .unwrap_err();
            assert!(error.contains(needle), "{error}");
        }
        let (endpoint, _) = mock_once(200, r#"{"text":"late"}"#, Duration::from_millis(100)).await;
        let error = request_transcription_with_timeout(
            &Client::new(),
            &endpoint,
            "secret",
            "model",
            vec![1],
            "audio/wav",
            "a.wav",
            None,
            false,
            &CancellationToken::new(),
            Duration::from_millis(10),
        )
        .await
        .unwrap_err();
        assert!(error.contains("Zeitlimit"), "{error}");
    }

    #[tokio::test]
    async fn cancellation_interrupts_an_in_flight_upload() {
        let (endpoint, _) = mock_once(200, r#"{"text":"late"}"#, Duration::from_millis(150)).await;
        let token = CancellationToken::new();
        let cancelling = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            cancelling.cancel();
        });
        let error = request_transcription_with_timeout(
            &Client::new(),
            &endpoint,
            "secret",
            "model",
            vec![1],
            "audio/wav",
            "a.wav",
            None,
            false,
            &token,
            Duration::from_secs(1),
        )
        .await
        .unwrap_err();
        assert_eq!(error, TRANSCRIPTION_CANCELLED);
    }
}
