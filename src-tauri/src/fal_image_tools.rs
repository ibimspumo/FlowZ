use crate::{
    fal_provider::{self, FalProviderState},
    persistence::{ImportBlobRequest, Persistence},
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::Utc;
use futures_util::StreamExt;
use reqwest::{header, Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    fs::OpenOptions,
    io::Cursor,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const SEEDVR: &str = "fal-ai/seedvr/upscale/image";
const TOPAZ: &str = "fal-ai/topaz/upscale/image";
const BRIA: &str = "fal-ai/bria/background/remove";
const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone)]
pub struct FalImageToolState {
    root: Arc<PathBuf>,
    active: Arc<Mutex<HashMap<String, CancellationToken>>>,
}
impl FalImageToolState {
    pub fn initialize(app_data: &Path) -> Result<Self, String> {
        let root = app_data.join("fal-image-tool-runs");
        std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
        Ok(Self {
            root: Arc::new(root),
            active: Arc::new(Mutex::new(HashMap::new())),
        })
    }
    fn path(&self, run_id: &str) -> Result<PathBuf, String> {
        Uuid::parse_str(run_id).map_err(|_| "Ungültige Bildwerkzeug-Run-ID.".to_string())?;
        Ok(self.root.join(format!("{run_id}.json")))
    }
    fn save(&self, manifest: &ToolRunManifest) -> Result<(), String> {
        let path = self.path(&manifest.request.run_id)?;
        let temporary = path.with_extension("json.tmp");
        let bytes = serde_json::to_vec(manifest).map_err(|error| error.to_string())?;
        if bytes.len() > 512 * 1024 {
            return Err("Bildwerkzeug-Manifest ist unerwartet groß.".into());
        }
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| error.to_string())?;
        std::fs::rename(&temporary, path).map_err(|error| error.to_string())?;
        Ok(())
    }
    fn load(&self, run_id: &str) -> Result<ToolRunManifest, String> {
        let bytes = std::fs::read(self.path(run_id)?)
            .map_err(|_| "Dieser Bildwerkzeug-Run ist lokal nicht mehr vorhanden.".to_string())?;
        if bytes.len() > 512 * 1024 {
            return Err("Bildwerkzeug-Manifest ist beschädigt.".into());
        }
        serde_json::from_slice(&bytes).map_err(|_| "Bildwerkzeug-Manifest ist beschädigt.".into())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageToolRequest {
    run_id: String,
    project_id: String,
    node_id: String,
    endpoint: String,
    schema_hash: String,
    source: String,
    config: Value,
    estimated_cost_microunits: Option<i64>,
    input_fingerprint: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageToolResult {
    run_id: String,
    result_id: String,
    asset_id: String,
    blob_hash: String,
    media_type: String,
    width: u32,
    height: u32,
    has_alpha: bool,
    cost_microunits: Option<i64>,
    billable_units: Option<String>,
    cost_provenance: String,
    target_current: bool,
    contract_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ToolPhase {
    Preparing,
    SubmitUnknown,
    Queued,
    InProgress,
    Finalizing,
    Complete,
    CancelRequested,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolRunManifest {
    request: ImageToolRequest,
    phase: ToolPhase,
    request_id: Option<String>,
    status_url: Option<String>,
    response_url: Option<String>,
    cancel_url: Option<String>,
    output_url: Option<String>,
    billable_units: Option<String>,
    provider_usage: Option<Value>,
    actual_cost_microunits: Option<i64>,
    endpoint_price: Option<Value>,
    result: Option<ImageToolResult>,
    created_at: String,
    updated_at: String,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingImageToolRun {
    run_id: String,
    project_id: String,
    node_id: String,
    endpoint: String,
    phase: ToolPhase,
    created_at: String,
    error: Option<String>,
}

fn schema_for(endpoint: &str) -> Option<&'static str> {
    match endpoint {
        SEEDVR => Some("seedvr-upscale-image-v1-20260711"),
        TOPAZ => Some("topaz-upscale-image-v1-20260711"),
        BRIA => Some("bria-background-remove-v1-20260711"),
        _ => None,
    }
}

fn str_field<'a>(config: &'a Value, key: &str) -> Result<&'a str, String> {
    config
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Bildwerkzeug-Parameter fehlt: {key}."))
}
fn number(config: &Value, key: &str) -> Result<f64, String> {
    config
        .get(key)
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())
        .ok_or_else(|| format!("Bildwerkzeug-Parameter fehlt: {key}."))
}
fn unit(config: &Value, key: &str) -> Result<f64, String> {
    number(config, key).and_then(|n| {
        if (0.0..=1.0).contains(&n) {
            Ok(n)
        } else {
            Err(format!("{key} muss zwischen 0 und 1 liegen."))
        }
    })
}

fn validate_and_build(request: &ImageToolRequest, image_url: &str) -> Result<Value, String> {
    Uuid::parse_str(&request.run_id).map_err(|_| "Ungültige Bildwerkzeug-Run-ID.".to_string())?;
    if request.project_id.is_empty() || request.node_id.is_empty() {
        return Err("Projekt oder Node fehlt.".into());
    }
    if schema_for(&request.endpoint) != Some(request.schema_hash.as_str()) {
        return Err("Der Bildwerkzeug-Adapter ist veraltet.".into());
    }
    let config = &request.config;
    if request.endpoint == BRIA {
        return Ok(json!({"image_url":image_url,"sync_mode":false}));
    }
    if request.endpoint == SEEDVR {
        let mode = str_field(config, "upscaleMode")?;
        if !matches!(mode, "factor" | "target") {
            return Err("SeedVR-Upscale-Modus ist ungültig.".into());
        }
        let format = str_field(config, "outputFormat")?;
        if !matches!(format, "png" | "jpg" | "webp") {
            return Err("SeedVR-Ausgabeformat ist ungültig.".into());
        }
        let noise = unit(config, "noise")?;
        let mut input = Map::from_iter([
            ("image_url".into(), json!(image_url)),
            ("upscale_mode".into(), json!(mode)),
            ("noise_scale".into(), json!(noise)),
            ("output_format".into(), json!(format)),
            ("sync_mode".into(), json!(false)),
        ]);
        if mode == "factor" {
            let factor = number(config, "factor")?;
            if factor.fract() != 0.0 || !(1.0..=10.0).contains(&factor) {
                return Err("SeedVR unterstützt Faktoren von 1 bis 10.".into());
            }
            input.insert("upscale_factor".into(), json!(factor));
        } else {
            let target = str_field(config, "targetResolution")?;
            if !matches!(target, "720p" | "1080p" | "1440p" | "2160p") {
                return Err("SeedVR-Zielauflösung ist ungültig.".into());
            }
            input.insert("target_resolution".into(), json!(target));
        }
        if let Some(seed) = config.get("seed") {
            let seed = seed
                .as_u64()
                .ok_or("Seed muss eine nichtnegative Ganzzahl sein.")?;
            input.insert("seed".into(), json!(seed));
        }
        return Ok(Value::Object(input));
    }
    if request.endpoint == TOPAZ {
        if config.get("premiumConfirmed").and_then(Value::as_bool) != Some(true) {
            return Err(
                "Topaz erfordert für jeden Lauf eine ausdrückliche Premium-Bestätigung.".into(),
            );
        }
        let factor = number(config, "factor")?;
        if !(1.0..=4.0).contains(&factor) {
            return Err("Topaz unterstützt Skalierungsfaktoren von 1 bis 4.".into());
        }
        let model = str_field(config, "topazModel")?;
        const MODELS: &[&str] = &[
            "Low Resolution V2",
            "Standard V2",
            "CGI",
            "High Fidelity V2",
            "Text Refine",
            "Recovery",
            "Redefine",
            "Recovery V2",
            "Standard MAX",
            "Wonder",
            "Wonder 3",
        ];
        if !MODELS.contains(&model) {
            return Err("Topaz-Modell wird nicht unterstützt.".into());
        }
        let format = str_field(config, "outputFormat")?;
        if !matches!(format, "png" | "jpeg") {
            return Err("Topaz-Ausgabeformat ist ungültig.".into());
        }
        let mut input = Map::from_iter([
            ("image_url".into(), json!(image_url)),
            ("upscale_factor".into(), json!(factor)),
            ("model".into(), json!(model)),
            ("output_format".into(), json!(format)),
            (
                "crop_to_fill".into(),
                json!(config
                    .get("cropToFill")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)),
            ),
        ]);
        if matches!(model, "Standard V2" | "Recovery V2") {
            let subject = str_field(config, "subjectDetection")?;
            if !matches!(subject, "All" | "Foreground" | "Background") {
                return Err("Topaz-Subjekterkennung ist ungültig.".into());
            }
            input.insert("subject_detection".into(), json!(subject));
            let face = config
                .get("faceEnhancement")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            input.insert("face_enhancement".into(), json!(face));
            if face {
                input.insert(
                    "face_enhancement_creativity".into(),
                    json!(unit(config, "faceEnhancementCreativity")?),
                );
                input.insert(
                    "face_enhancement_strength".into(),
                    json!(unit(config, "faceEnhancementStrength")?),
                );
            }
        }
        for (key, out) in [("sharpen", "sharpen"), ("denoise", "denoise")] {
            if matches!(
                model,
                "Standard V2"
                    | "Low Resolution V2"
                    | "CGI"
                    | "High Fidelity V2"
                    | "Text Refine"
                    | "Redefine"
            ) {
                input.insert(out.into(), json!(unit(config, key)?));
            }
        }
        if matches!(
            model,
            "Standard V2" | "Low Resolution V2" | "High Fidelity V2" | "Text Refine"
        ) {
            input.insert(
                "fix_compression".into(),
                json!(unit(config, "fixCompression")?),
            );
        }
        if model == "Text Refine" {
            let value = number(config, "strength")?;
            if !(0.01..=1.0).contains(&value) {
                return Err("Text-Refine-Stärke muss zwischen 0.01 und 1 liegen.".into());
            }
            input.insert("strength".into(), json!(value));
        }
        if model == "Redefine" {
            let creativity = number(config, "creativity")?;
            let texture = number(config, "texture")?;
            if creativity.fract() != 0.0
                || !(1.0..=6.0).contains(&creativity)
                || texture.fract() != 0.0
                || !(1.0..=5.0).contains(&texture)
            {
                return Err("Redefine Creativity/Texture ist ungültig.".into());
            }
            let prompt = str_field(config, "redefinePrompt")?;
            if prompt.chars().count() > 1024 {
                return Err("Topaz-Prompt ist länger als 1024 Zeichen.".into());
            }
            input.insert("creativity".into(), json!(creativity));
            input.insert("texture".into(), json!(texture));
            input.insert("prompt".into(), json!(prompt));
            input.insert(
                "autoprompt".into(),
                json!(config
                    .get("autoprompt")
                    .and_then(Value::as_bool)
                    .unwrap_or(true)),
            );
        }
        if model == "Recovery V2" {
            input.insert("detail".into(), json!(unit(config, "detail")?));
        }
        if model == "Wonder 3" {
            if let Some(value) = config.get("enhancementStrength").and_then(Value::as_str) {
                if !matches!(value, "low" | "medium" | "high") {
                    return Err("Wonder-3-Stärke ist ungültig.".into());
                }
                input.insert("enhancement_strength".into(), json!(value));
            }
        }
        return Ok(Value::Object(input));
    }
    Err("Unbekanntes Bildwerkzeug.".into())
}

fn safe_queue_url(raw: &str, request_id: &str) -> Result<String, String> {
    let url = Url::parse(raw)
        .map_err(|_| "fal.ai hat eine ungültige Queue-URL geliefert.".to_string())?;
    let request_path = format!("/requests/{request_id}");
    if url.scheme() != "https"
        || url.host_str() != Some("queue.fal.run")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || !url.path().contains(&request_path)
    {
        return Err("fal.ai hat eine nicht erlaubte Queue-URL geliefert.".into());
    }
    Ok(url.to_string())
}

async fn submit(
    manifest: &mut ToolRunManifest,
    state: &FalImageToolState,
    shared: &FalProviderState,
    persistence: &Persistence,
    client: &Client,
    key: &str,
) -> Result<(), String> {
    validate_and_build(&manifest.request, "https://fal.media/flowz-preflight.png")?;
    let uploaded = fal_provider::fal_upload_original_image(
        client,
        key,
        &manifest.request.source,
        persistence,
        shared,
    )
    .await?;
    let input = validate_and_build(&manifest.request, &uploaded)?;
    manifest.phase = ToolPhase::SubmitUnknown;
    manifest.updated_at = Utc::now().to_rfc3339();
    manifest.error = Some(
        "Submit wird ausgeführt; bei einem Prozessabbruch wird nicht automatisch erneut gesendet."
            .into(),
    );
    state.save(manifest)?;
    let response = client
        .post(fal_provider::fal_queue_url(
            &manifest.request.endpoint,
            None,
            "",
        ))
        .header(header::AUTHORIZATION, format!("Key {key}"))
        .json(&input)
        .send()
        .await
        .map_err(|error| {
            format!(
                "Der Submit-Ausgang ist unbekannt: {error}. FlowZ sendet nicht automatisch erneut."
            )
        })?;
    let (submitted, billable) =
        fal_provider::checked_fal_json(response)
            .await
            .map_err(|error| {
                format!(
                "Der Submit wurde nicht bestätigt: {error}. FlowZ sendet nicht automatisch erneut."
            )
            })?;
    let id = submitted
        .get("request_id")
        .and_then(Value::as_str)
        .ok_or("fal.ai hat keine Request-ID geliefert; der Submit wird nicht wiederholt.")?
        .to_owned();
    let field = |name: &str, suffix: &str| -> Result<String, String> {
        let fallback = fal_provider::fal_queue_url(&manifest.request.endpoint, Some(&id), suffix);
        safe_queue_url(
            submitted
                .get(name)
                .and_then(Value::as_str)
                .unwrap_or(&fallback),
            &id,
        )
    };
    manifest.request_id = Some(id.clone());
    manifest.status_url = Some(field("status_url", "/status")?);
    manifest.response_url = Some(field("response_url", "")?);
    manifest.cancel_url = Some(field("cancel_url", "/cancel")?);
    manifest.billable_units = billable;
    manifest.phase = ToolPhase::Queued;
    manifest.updated_at = Utc::now().to_rfc3339();
    manifest.error = None;
    state.save(manifest)
}

async fn wait_existing(
    manifest: &mut ToolRunManifest,
    state: &FalImageToolState,
    client: &Client,
    key: &str,
    token: &CancellationToken,
) -> Result<Value, String> {
    let status_url = manifest
        .status_url
        .as_ref()
        .ok_or("Gespeicherte fal.ai-Status-URL fehlt.")?
        .clone();
    let response_url = manifest
        .response_url
        .as_ref()
        .ok_or("Gespeicherte fal.ai-Resultat-URL fehlt.")?
        .clone();
    let cancel_url = manifest
        .cancel_url
        .as_ref()
        .ok_or("Gespeicherte fal.ai-Abbruch-URL fehlt.")?
        .clone();
    loop {
        if token.is_cancelled() {
            manifest.phase = ToolPhase::CancelRequested;
            manifest.updated_at = Utc::now().to_rfc3339();
            state.save(manifest)?;
            let _ = client
                .put(&cancel_url)
                .header(header::AUTHORIZATION, format!("Key {key}"))
                .send()
                .await;
            return Err("Bildwerkzeug-Lauf abgebrochen.".into());
        }
        let (status, units) = fal_provider::checked_fal_json(
            client
                .get(&status_url)
                .header(header::AUTHORIZATION, format!("Key {key}"))
                .send()
                .await
                .map_err(|e| e.to_string())?,
        )
        .await?;
        manifest.billable_units = units.or(manifest.billable_units.take());
        match status.get("status").and_then(Value::as_str) {
            Some("COMPLETED") => break,
            Some("IN_QUEUE") => manifest.phase = ToolPhase::Queued,
            Some("IN_PROGRESS") => manifest.phase = ToolPhase::InProgress,
            Some("FAILED") => {
                manifest.phase = ToolPhase::Failed;
                manifest.error =
                    Some("fal.ai hat den Bildwerkzeug-Lauf als fehlgeschlagen markiert.".into());
                manifest.updated_at = Utc::now().to_rfc3339();
                state.save(manifest)?;
                return Err(manifest.error.clone().unwrap());
            }
            _ => return Err("fal.ai meldet einen unbekannten Queue-Status.".into()),
        }
        manifest.updated_at = Utc::now().to_rfc3339();
        state.save(manifest)?;
        tokio::select! { _=token.cancelled()=>{manifest.phase=ToolPhase::CancelRequested;manifest.updated_at=Utc::now().to_rfc3339();state.save(manifest)?;let _=client.put(&cancel_url).header(header::AUTHORIZATION,format!("Key {key}")).send().await;return Err("Bildwerkzeug-Lauf abgebrochen.".into())}, _=tokio::time::sleep(Duration::from_secs(1))=>{} }
    }
    let (result, units) = fal_provider::checked_fal_json(
        client
            .get(response_url)
            .header(header::AUTHORIZATION, format!("Key {key}"))
            .send()
            .await
            .map_err(|e| e.to_string())?,
    )
    .await?;
    manifest.billable_units = units.or(manifest.billable_units.take());
    manifest.actual_cost_microunits = provider_cost(&result);
    manifest.provider_usage = result
        .get("usage")
        .cloned()
        .filter(|usage| serde_json::to_vec(usage).is_ok_and(|bytes| bytes.len() <= 16 * 1024));
    manifest.output_url = result
        .pointer("/image/url")
        .or_else(|| result.pointer("/data/image/url"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    manifest.phase = ToolPhase::Finalizing;
    manifest.updated_at = Utc::now().to_rfc3339();
    state.save(manifest)?;
    Ok(result)
}

async fn download(
    client: &Client,
    raw: &str,
    token: &CancellationToken,
    require_alpha_check: bool,
) -> Result<(Vec<u8>, String, u32, u32, bool), String> {
    let mut url: Url = fal_provider::allowed_download_url(raw)?;
    for _ in 0..=3 {
        let response = client
            .get(url.clone())
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if response.status().is_redirection() {
            let next = response
                .headers()
                .get(header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or("Fal-CDN-Weiterleitung ist ungültig.")?;
            url = fal_provider::allowed_download_url(
                url.join(next)
                    .map_err(|_| "Fal-CDN-Weiterleitung ist ungültig.".to_string())?
                    .as_str(),
            )?;
            continue;
        }
        if response.status() != StatusCode::OK
            || response
                .content_length()
                .is_some_and(|n| n == 0 || n > MAX_IMAGE_BYTES)
        {
            return Err("Fal-Bild konnte nicht sicher geladen werden.".into());
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            if token.is_cancelled() {
                return Err("Bilddownload abgebrochen.".into());
            }
            let chunk = chunk.map_err(|e| e.to_string())?;
            if bytes.len() + chunk.len() > MAX_IMAGE_BYTES as usize {
                return Err("Fal-Bild ist größer als 64 MiB.".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let format = image::guess_format(&bytes)
            .map_err(|_| "Fal-CDN lieferte kein unterstütztes Bild.".to_string())?;
        let media = match format {
            image::ImageFormat::Png => "image/png",
            image::ImageFormat::Jpeg => "image/jpeg",
            image::ImageFormat::WebP => "image/webp",
            _ => return Err("Fal-CDN lieferte kein erlaubtes Bildformat.".into()),
        }
        .to_string();
        let (width, height) = image::ImageReader::new(Cursor::new(&bytes))
            .with_guessed_format()
            .map_err(|_| "Fal-Bildformat ist ungültig.".to_string())?
            .into_dimensions()
            .map_err(|_| "Fal-Bild ist beschädigt.".to_string())?;
        if width == 0
            || height == 0
            || width > 32768
            || height > 32768
            || u64::from(width) * u64::from(height) > 512_000_000
        {
            return Err("Fal-Bildabmessungen liegen außerhalb des sicheren Bereichs.".into());
        }
        let alpha = if require_alpha_check {
            if u64::from(width) * u64::from(height) > 100_000_000 {
                return Err("Bria-Ausgabe ist für eine sichere Transparenzprüfung zu groß.".into());
            }
            let decoded = image::load_from_memory_with_format(&bytes, format)
                .map_err(|_| "Fal-Bild ist beschädigt.".to_string())?;
            decoded.color().has_alpha() && decoded.to_rgba8().pixels().any(|p| p.0[3] < 255)
        } else {
            false
        };
        return Ok((bytes, media, width, height, alpha));
    }
    Err("Fal-CDN hat zu oft weitergeleitet.".into())
}

fn provider_cost(response: &Value) -> Option<i64> {
    let value = response.pointer("/usage/cost")?;
    let decimal = match value {
        Value::String(v) => v.parse::<f64>().ok()?,
        Value::Number(v) => v.as_f64()?,
        _ => return None,
    };
    if !decimal.is_finite() || decimal < 0.0 {
        return None;
    }
    Some((decimal * 1_000_000.0).round() as i64)
}
fn source_dimensions(source: &str, persistence: &Persistence) -> Result<(u32, u32), String> {
    let bytes = if let Some(hash) = source.strip_prefix("flowz-cas:") {
        persistence.blobs.read(hash)?
    } else {
        let payload = source
            .split_once(',')
            .filter(|(head, _)| head.starts_with("data:image/") && head.ends_with(";base64"))
            .map(|(_, payload)| payload)
            .ok_or("Topaz benötigt ein lokales CAS-Bild oder eine gültige Bild-Data-URL.")?;
        if payload.len() > 86 * 1024 * 1024 {
            return Err("Bild-Data-URL ist größer als 64 MiB.".into());
        }
        BASE64
            .decode(payload)
            .map_err(|_| "Bild-Data-URL ist ungültig.".to_string())?
    };
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES as usize {
        return Err("Topaz-Quellbild ist leer oder größer als 64 MiB.".into());
    }
    image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| "Topaz-Quellformat ist ungültig.".to_string())?
        .into_dimensions()
        .map_err(|_| "Topaz-Quellbild ist beschädigt.".to_string())
}
fn topaz_estimate(width: u32, height: u32, factor: f64) -> Result<i64, String> {
    let megapixels = f64::from(width) * f64::from(height) * factor * factor / 1_000_000.0;
    if !megapixels.is_finite() || megapixels <= 0.0 || megapixels > 512.0 {
        return Err("Topaz-Ausgaben über 512 MP sind gesperrt.".into());
    }
    Ok(if megapixels <= 24.0 {
        80_000
    } else if megapixels <= 48.0 {
        160_000
    } else if megapixels <= 96.0 {
        320_000
    } else {
        (320_000 + (((megapixels - 96.0) / 32.0).ceil() as i64) * 80_000).min(1_360_000)
    })
}
fn seedvr_estimate(width: u32, height: u32, config: &Value) -> Result<i64, String> {
    let (output_width, output_height) = if str_field(config, "upscaleMode")? == "target" {
        let target = str_field(config, "targetResolution")?
            .trim_end_matches('p')
            .parse::<u32>()
            .map_err(|_| "SeedVR-Zielauflösung ist ungültig.".to_string())?;
        (
            f64::from(target) * f64::from(width) / f64::from(height),
            f64::from(target),
        )
    } else {
        let factor = number(config, "factor")?;
        (f64::from(width) * factor, f64::from(height) * factor)
    };
    Ok((output_width * output_height / 1_000_000.0 * 1_000.0).ceil() as i64)
}
fn target_current(request: &ImageToolRequest, p: &Persistence) -> bool {
    let module = if request.endpoint == BRIA {
        "image.background-removal"
    } else {
        "image.upscale"
    };
    p.projects
        .open(&request.project_id)
        .ok()
        .and_then(|r| {
            r.project
                .graph
                .nodes
                .into_iter()
                .find(|n| n.id == request.node_id)
        })
        .is_some_and(|n| {
            n.module_id == module
                && n.config.get("model").and_then(Value::as_str) == Some(request.endpoint.as_str())
        })
}

async fn finalize_manifest(
    mut manifest: ToolRunManifest,
    state: &FalImageToolState,
    persistence: &Persistence,
    client: &Client,
    token: &CancellationToken,
) -> Result<ImageToolResult, String> {
    let result = if let Some(result) = manifest.result.clone() {
        result
    } else {
        let url = manifest
            .output_url
            .as_deref()
            .ok_or("Gespeicherte fal.ai-Bild-URL fehlt.")?;
        let (bytes, media, width, height, alpha) =
            download(client, url, token, manifest.request.endpoint == BRIA).await?;
        if manifest.request.endpoint == TOPAZ && u64::from(width) * u64::from(height) > 512_000_000
        {
            return Err("Topaz-Ausgabe über 512 MP wurde verworfen.".into());
        }
        let ext = if media == "image/png" {
            "png"
        } else if media == "image/webp" {
            "webp"
        } else {
            "jpg"
        };
        let temp = std::env::temp_dir().join(format!(
            "flowz-fal-tool-{}.{}",
            manifest.request.run_id, ext
        ));
        std::fs::write(&temp, &bytes).map_err(|error| error.to_string())?;
        let imported = persistence.blobs.import(ImportBlobRequest {
            path: temp.clone(),
            media_type: Some(media.clone()),
            original_name: Some(format!(
                "flowz-{}.{}",
                if manifest.request.endpoint == BRIA {
                    "freigestellt"
                } else {
                    "upscaled"
                },
                ext
            )),
        });
        let _ = std::fs::remove_file(temp);
        let blob = imported?;
        let actual = manifest.actual_cost_microunits;
        let estimated = manifest.request.estimated_cost_microunits;
        let cost = actual.or(estimated);
        let provenance = if actual.is_some() {
            "actual"
        } else if estimated.is_some() {
            "estimated"
        } else {
            "unknown"
        };
        let current = target_current(&manifest.request, persistence);
        let contract_error = if manifest.request.endpoint == BRIA
            && (media != "image/png" || !alpha)
        {
            Some("Bria hat kein PNG mit tatsächlich transparenten Pixeln geliefert. Das Diagnosebild wurde gespeichert; der Lauf gilt als Vertragsfehler.".to_string())
        } else {
            None
        };
        let result = ImageToolResult {
            run_id: manifest.request.run_id.clone(),
            result_id: Uuid::new_v4().to_string(),
            asset_id: Uuid::new_v4().to_string(),
            blob_hash: blob.hash,
            media_type: media,
            width,
            height,
            has_alpha: alpha,
            cost_microunits: cost,
            billable_units: manifest.billable_units.clone(),
            cost_provenance: provenance.into(),
            target_current: current,
            contract_error,
        };
        manifest.result = Some(result.clone());
        manifest.phase = ToolPhase::Finalizing;
        manifest.updated_at = Utc::now().to_rfc3339();
        state.save(&manifest)?;
        result
    };
    let blob = persistence.blobs.metadata(&result.blob_hash)?;
    let make_active = result.target_current && result.contract_error.is_none();
    let parameters = json!({"endpoint":manifest.request.endpoint,"schemaHash":manifest.request.schema_hash,"width":result.width,"height":result.height,"hasAlpha":result.has_alpha,"costProvenance":result.cost_provenance,"estimatedCostMicrounits":manifest.request.estimated_cost_microunits,"actualCostMicrounits":manifest.actual_cost_microunits,"billableUnits":manifest.billable_units,"providerUsage":manifest.provider_usage,"endpointPrice":manifest.endpoint_price,"inputFingerprint":manifest.request.input_fingerprint,"contractError":result.contract_error,"orphaned":!make_active});
    persistence.database.commit_external_image_tool_result(
        &manifest.request.run_id,
        &manifest.request.project_id,
        &manifest.request.node_id,
        &manifest.request.endpoint,
        result.cost_microunits,
        &blob,
        &result.result_id,
        &result.asset_id,
        &parameters,
        &manifest.created_at,
        make_active,
    )?;
    manifest.phase = ToolPhase::Complete;
    manifest.updated_at = Utc::now().to_rfc3339();
    manifest.error = None;
    state.save(&manifest)?;
    Ok(result)
}

async fn run_manifest(
    mut manifest: ToolRunManifest,
    state: &FalImageToolState,
    shared: &FalProviderState,
    persistence: &Persistence,
) -> Result<ImageToolResult, String> {
    if manifest.phase == ToolPhase::Complete {
        return manifest
            .result
            .ok_or("Abgeschlossener Bildwerkzeug-Run enthält kein Ergebnis.".into());
    }
    if manifest.phase == ToolPhase::SubmitUnknown {
        return Err(manifest
            .error
            .unwrap_or("Der Submit-Ausgang ist unbekannt; FlowZ sendet nicht erneut.".into()));
    }
    if matches!(
        manifest.phase,
        ToolPhase::Cancelled | ToolPhase::CancelRequested
    ) {
        return Err("Bildwerkzeug-Lauf wurde abgebrochen.".into());
    }
    if manifest.phase == ToolPhase::Failed {
        return Err(manifest
            .error
            .unwrap_or("Bildwerkzeug-Lauf ist fehlgeschlagen.".into()));
    }
    let run_id = manifest.request.run_id.clone();
    let token = CancellationToken::new();
    {
        let mut active = state
            .active
            .lock()
            .map_err(|_| "Fal-Bildwerkzeuge sind nicht verfügbar.".to_string())?;
        if active.insert(run_id.clone(), token.clone()).is_some() {
            return Err("Dieser Bildwerkzeug-Lauf wird bereits ausgeführt.".into());
        }
    }
    let outcome = async {
        let key = fal_provider::api_key()?;
        let client = fal_provider::api_client()?;
        if manifest.phase == ToolPhase::Preparing {
            submit(&mut manifest, state, shared, persistence, &client, &key).await?
        }
        if matches!(manifest.phase, ToolPhase::Queued | ToolPhase::InProgress) {
            let _ = wait_existing(&mut manifest, state, &client, &key, &token).await?;
        }
        finalize_manifest(manifest, state, persistence, &client, &token).await
    }
    .await;
    if let Ok(mut active) = state.active.lock() {
        active.remove(&run_id);
    }
    outcome
}

#[tauri::command]
pub async fn fal_image_tool_start(
    mut request: ImageToolRequest,
    state: tauri::State<'_, FalImageToolState>,
    shared: tauri::State<'_, FalProviderState>,
    persistence: tauri::State<'_, Persistence>,
) -> Result<ImageToolResult, String> {
    validate_and_build(&request, "https://fal.media/flowz-preflight.png")?;
    if !request.source.starts_with("flowz-cas:") {
        return Err(
            "Bezahlte Bildwerkzeuge benötigen ein vollständig lokal gespeichertes Quellbild."
                .into(),
        );
    }
    let (width, height) = source_dimensions(&request.source, &persistence)?;
    request.estimated_cost_microunits = if request.endpoint == TOPAZ {
        Some(topaz_estimate(
            width,
            height,
            number(&request.config, "factor")?,
        )?)
    } else if request.endpoint == SEEDVR {
        Some(seedvr_estimate(width, height, &request.config)?)
    } else if request.endpoint == BRIA {
        Some(18_000)
    } else {
        None
    };
    if state.path(&request.run_id)?.exists() {
        return Err("Diese Bildwerkzeug-Run-ID wurde bereits verwendet.".into());
    }
    let now = Utc::now().to_rfc3339();
    let endpoint_price = Some(if request.endpoint == SEEDVR {
        json!({"basis":"output_megapixel","microunitsPerMegapixel":1000})
    } else if request.endpoint == BRIA {
        json!({"basis":"image","microunits":18000})
    } else {
        json!({"basis":"output_megapixel_tier","estimatedMicrounits":request.estimated_cost_microunits,"tiers":[[24,80000],[48,160000],[96,320000],[512,1360000]]})
    });
    let manifest = ToolRunManifest {
        request,
        phase: ToolPhase::Preparing,
        request_id: None,
        status_url: None,
        response_url: None,
        cancel_url: None,
        output_url: None,
        billable_units: None,
        provider_usage: None,
        actual_cost_microunits: None,
        endpoint_price,
        result: None,
        created_at: now.clone(),
        updated_at: now,
        error: None,
    };
    state.save(&manifest)?;
    run_manifest(manifest, &state, &shared, &persistence).await
}

#[tauri::command]
pub async fn fal_image_tool_resume(
    run_id: String,
    state: tauri::State<'_, FalImageToolState>,
    shared: tauri::State<'_, FalProviderState>,
    persistence: tauri::State<'_, Persistence>,
) -> Result<ImageToolResult, String> {
    let manifest = state.load(&run_id)?;
    if manifest.phase == ToolPhase::SubmitUnknown {
        return Err(manifest
            .error
            .unwrap_or("Der Submit-Ausgang ist unbekannt; FlowZ sendet nicht erneut.".into()));
    }
    run_manifest(manifest, &state, &shared, &persistence).await
}

#[tauri::command]
pub async fn fal_image_tool_cancel(
    run_id: String,
    state: tauri::State<'_, FalImageToolState>,
) -> Result<bool, String> {
    Uuid::parse_str(&run_id).map_err(|_| "Ungültige Bildwerkzeug-Run-ID.".to_string())?;
    if let Some(token) = state
        .active
        .lock()
        .map_err(|_| "Fal-Bildwerkzeuge sind nicht verfügbar.".to_string())?
        .get(&run_id)
        .cloned()
    {
        token.cancel();
        return Ok(true);
    }
    let mut manifest = state.load(&run_id)?;
    let Some(cancel_url) = manifest.cancel_url.clone() else {
        return Ok(false);
    };
    manifest.phase = ToolPhase::CancelRequested;
    manifest.updated_at = Utc::now().to_rfc3339();
    state.save(&manifest)?;
    let key = fal_provider::api_key()?;
    let client = fal_provider::api_client()?;
    let response = client
        .put(cancel_url)
        .header(header::AUTHORIZATION, format!("Key {key}"))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if response.status().is_success() {
        manifest.phase = ToolPhase::Cancelled;
        manifest.updated_at = Utc::now().to_rfc3339();
        state.save(&manifest)?;
        Ok(true)
    } else {
        Err(format!(
            "fal.ai konnte den Run nicht abbrechen ({}).",
            response.status()
        ))
    }
}

#[tauri::command]
pub fn fal_image_tool_pending(
    project_id: String,
    node_id: Option<String>,
    state: tauri::State<'_, FalImageToolState>,
) -> Result<Vec<PendingImageToolRun>, String> {
    let mut runs = Vec::new();
    for entry in std::fs::read_dir(state.root.as_ref()).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.extension().and_then(|v| v.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|v| v.to_str()) else {
            continue;
        };
        let Ok(run) = state.load(id) else { continue };
        if run.request.project_id == project_id
            && node_id
                .as_ref()
                .is_none_or(|node| node == &run.request.node_id)
            && !matches!(
                run.phase,
                ToolPhase::Complete | ToolPhase::Cancelled | ToolPhase::Failed
            )
        {
            runs.push(PendingImageToolRun {
                run_id: run.request.run_id,
                project_id: run.request.project_id,
                node_id: run.request.node_id,
                endpoint: run.request.endpoint,
                phase: run.phase,
                created_at: run.created_at,
                error: run.error,
            })
        }
    }
    runs.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(runs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgba};
    #[test]
    fn bria_payload_is_async() {
        let request = ImageToolRequest {
            run_id: Uuid::new_v4().to_string(),
            project_id: "p".into(),
            node_id: "n".into(),
            endpoint: BRIA.into(),
            schema_hash: "bria-background-remove-v1-20260711".into(),
            source: "flowz-cas:x".into(),
            config: json!({}),
            estimated_cost_microunits: Some(18_000),
            input_fingerprint: json!({"test":true}),
        };
        assert_eq!(
            validate_and_build(&request, "https://fal.media/a.png").unwrap(),
            json!({"image_url":"https://fal.media/a.png","sync_mode":false})
        );
    }

    async fn live_smoke(endpoint: &str, schema_hash: &str, config: Value, require_alpha: bool) {
        let root = tempfile::tempdir().unwrap();
        let persistence = Persistence::initialize(root.path()).unwrap();
        let shared = FalProviderState::initialize(root.path()).unwrap();
        let source_path = root.path().join("source.png");
        let mut image = ImageBuffer::from_pixel(512, 512, Rgba([250u8, 250, 250, 255]));
        for y in 96..416 {
            for x in 128..384 {
                image.put_pixel(x, y, Rgba([220, 30, 60, 255]));
            }
        }
        image.save(&source_path).unwrap();
        let source = persistence
            .blobs
            .import(ImportBlobRequest {
                path: source_path,
                media_type: Some("image/png".into()),
                original_name: Some("smoke-source.png".into()),
            })
            .unwrap();
        persistence.database.upsert_blob(&source).unwrap();
        let request = ImageToolRequest {
            run_id: Uuid::new_v4().to_string(),
            project_id: "smoke-project".into(),
            node_id: "smoke-node".into(),
            endpoint: endpoint.into(),
            schema_hash: schema_hash.into(),
            source: format!("flowz-cas:{}", source.hash),
            config,
            estimated_cost_microunits: None,
            input_fingerprint: json!({"source":source.hash}),
        };
        validate_and_build(&request, "https://fal.media/flowz-preflight.png").unwrap();
        let client = fal_provider::api_client().unwrap();
        let key = fal_provider::api_key().unwrap();
        let now = Utc::now().to_rfc3339();
        let state = FalImageToolState::initialize(root.path()).unwrap();
        let mut manifest = ToolRunManifest {
            request,
            phase: ToolPhase::Preparing,
            request_id: None,
            status_url: None,
            response_url: None,
            cancel_url: None,
            output_url: None,
            billable_units: None,
            provider_usage: None,
            actual_cost_microunits: None,
            endpoint_price: None,
            result: None,
            created_at: now.clone(),
            updated_at: now,
            error: None,
        };
        state.save(&manifest).unwrap();
        submit(&mut manifest, &state, &shared, &persistence, &client, &key)
            .await
            .unwrap();
        let token = CancellationToken::new();
        let response = wait_existing(&mut manifest, &state, &client, &key, &token)
            .await
            .unwrap();
        let billable = manifest.billable_units.clone();
        let url = response
            .pointer("/image/url")
            .or_else(|| response.pointer("/data/image/url"))
            .and_then(Value::as_str)
            .unwrap();
        let (bytes, media, width, height, alpha) =
            download(&client, url, &token, require_alpha).await.unwrap();
        let result_path = root.path().join("result.png");
        std::fs::write(&result_path, bytes).unwrap();
        let result = persistence
            .blobs
            .import(ImportBlobRequest {
                path: result_path,
                media_type: Some(media),
                original_name: Some("smoke-result.png".into()),
            })
            .unwrap();
        persistence.database.upsert_blob(&result).unwrap();
        assert!(!result.hash.is_empty() && width > 0 && height > 0);
        if require_alpha {
            assert!(alpha);
        }
        eprintln!("fal smoke endpoint={endpoint} size={width}x{height} actual_cost_microunits={:?} billable_units={billable:?} cas={}", provider_cost(&response), result.hash);
    }

    #[tokio::test]
    #[ignore = "costs money; run only as an explicitly authorized live smoke"]
    async fn live_seedvr_minimum() {
        live_smoke(
            SEEDVR,
            "seedvr-upscale-image-v1-20260711",
            json!({"upscaleMode":"factor","factor":1,"outputFormat":"png","noise":0.1}),
            false,
        )
        .await;
    }

    #[tokio::test]
    #[ignore = "costs money; run only as an explicitly authorized live smoke"]
    async fn live_bria_minimum() {
        live_smoke(BRIA, "bria-background-remove-v1-20260711", json!({}), true).await;
    }

    #[tokio::test]
    #[ignore = "premium and costs money; run only as an explicitly authorized live smoke"]
    async fn live_topaz_minimum() {
        live_smoke(TOPAZ, "topaz-upscale-image-v1-20260711", json!({"factor":1,"outputFormat":"png","topazModel":"Standard V2","premiumConfirmed":true,"subjectDetection":"All","faceEnhancement":false,"sharpen":0,"denoise":0,"fixCompression":0}), false).await;
    }
}
