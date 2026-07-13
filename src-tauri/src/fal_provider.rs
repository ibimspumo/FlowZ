use crate::persistence::{
    extract_video_frame, inspect_media, snapshot_media, ImportBlobRequest, MediaMetadata,
    Persistence,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::Utc;
use futures_util::StreamExt;
use image::{GenericImageView, ImageEncoder};
use keyring::Entry;
use reqwest::{header, redirect::Policy, Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const SERVICE: &str = "dev.flowz.app";
const ACCOUNT: &str = "fal-api-key";
const MAX_UPLOAD_BYTES: usize = 64 * 1024 * 1024;
const MAX_VIDEO_BYTES: u64 = 2 * 1024 * 1024 * 1024;

fn key_entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|error| error.to_string())
}
pub(crate) fn api_key() -> Result<String, String> {
    key_entry()?
        .get_password()
        .map_err(|_| "Kein fal.ai-Key gespeichert.".into())
}

#[tauri::command]
pub fn save_fal_key(key: String) -> Result<(), String> {
    let key = key.trim();
    if key.len() < 20 || !key.contains(':') {
        return Err("Das sieht nicht wie ein fal.ai-Key aus.".into());
    }
    key_entry()?
        .set_password(key)
        .map_err(|error| error.to_string())
}
#[tauri::command]
pub fn fal_key_status() -> bool {
    api_key().is_ok()
}
#[tauri::command]
pub fn delete_fal_key() -> Result<(), String> {
    key_entry()?
        .delete_credential()
        .map_err(|error| error.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FalUploadCacheStatus {
    entries: usize,
    next_expiry: Option<String>,
}

#[tauri::command]
pub fn fal_upload_cache_status(
    state: tauri::State<'_, FalProviderState>,
) -> Result<FalUploadCacheStatus, String> {
    let now = Utc::now().timestamp();
    let uploads = state
        .uploads
        .lock()
        .map_err(|_| "Fal-Uploadcache ist nicht verfügbar.".to_string())?;
    let valid = uploads
        .values()
        .filter(|item| item.expires_at > now)
        .collect::<Vec<_>>();
    Ok(FalUploadCacheStatus {
        entries: valid.len(),
        next_expiry: valid
            .iter()
            .map(|item| item.expires_at)
            .min()
            .and_then(|timestamp| chrono::DateTime::from_timestamp(timestamp, 0))
            .map(|value| value.to_rfc3339()),
    })
}

#[tauri::command]
pub fn fal_upload_cache_clear(state: tauri::State<'_, FalProviderState>) -> Result<(), String> {
    state
        .uploads
        .lock()
        .map_err(|_| "Fal-Uploadcache ist nicht verfügbar.".to_string())?
        .clear();
    match std::fs::remove_file(state.root.join("upload-cache.json")) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[derive(Clone)]
pub struct FalProviderState {
    root: Arc<PathBuf>,
    active: Arc<Mutex<HashMap<String, CancellationToken>>>,
    uploads: Arc<Mutex<HashMap<String, CachedUpload>>>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedUpload {
    url: String,
    expires_at: i64,
}
impl FalProviderState {
    pub fn initialize(app_data: &Path) -> Result<Self, String> {
        let root = app_data.join("fal-runs");
        std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
        let uploads = std::fs::read(root.join("upload-cache.json"))
            .ok()
            .filter(|bytes| bytes.len() <= 2 * 1024 * 1024)
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Ok(Self {
            root: Arc::new(root),
            active: Arc::new(Mutex::new(HashMap::new())),
            uploads: Arc::new(Mutex::new(uploads)),
        })
    }
    fn manifest_path(&self, id: &str) -> Result<PathBuf, String> {
        Uuid::parse_str(id).map_err(|_| "Ungültige fal-Run-ID.".to_string())?;
        Ok(self.root.join(format!("{id}.json")))
    }
    fn save(&self, manifest: &FalRunManifest) -> Result<(), String> {
        let path = self.manifest_path(&manifest.run_id)?;
        let temporary = path.with_extension("json.tmp");
        let bytes = serde_json::to_vec(manifest).map_err(|error| error.to_string())?;
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| error.to_string())?;
        std::fs::rename(&temporary, &path).map_err(|error| error.to_string())?;
        Ok(())
    }
    fn load(&self, id: &str) -> Result<FalRunManifest, String> {
        let bytes = std::fs::read(self.manifest_path(id)?)
            .map_err(|_| "Der fal-Run ist lokal nicht mehr vorhanden.".to_string())?;
        if bytes.len() > 256 * 1024 {
            return Err("Fal-Run-Manifest ist beschädigt.".into());
        }
        serde_json::from_slice(&bytes).map_err(|_| "Fal-Run-Manifest ist beschädigt.".into())
    }
    fn cached_upload(&self, key: &str) -> Option<String> {
        self.uploads
            .lock()
            .ok()?
            .get(key)
            .filter(|item| item.expires_at > Utc::now().timestamp())
            .map(|item| item.url.clone())
    }
    fn cache_upload(&self, key: String, url: String) -> Result<(), String> {
        let mut uploads = self
            .uploads
            .lock()
            .map_err(|_| "Fal-Uploadcache ist nicht verfügbar.".to_string())?;
        uploads.retain(|_, item| item.expires_at > Utc::now().timestamp());
        uploads.insert(
            key,
            CachedUpload {
                url,
                expires_at: Utc::now().timestamp() + 23 * 60 * 60,
            },
        );
        let temporary = self.root.join("upload-cache.json.tmp");
        let bytes = serde_json::to_vec(&*uploads).map_err(|error| error.to_string())?;
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| error.to_string())?;
        std::fs::rename(temporary, self.root.join("upload-cache.json"))
            .map_err(|error| error.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum FalRunPhase {
    Preparing,
    SubmitUnknown,
    Queued,
    InProgress,
    CancelRequested,
    Finalizing,
    Complete,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FalRunManifest {
    run_id: String,
    project_id: String,
    node_id: String,
    endpoint: String,
    schema_hash: String,
    phase: FalRunPhase,
    request_id: Option<String>,
    created_at: String,
    updated_at: String,
    error: Option<String>,
    result_id: Option<String>,
    video_hash: Option<String>,
    start_frame_hash: Option<String>,
    end_frame_hash: Option<String>,
    #[serde(default)]
    video_asset_id: Option<String>,
    #[serde(default)]
    start_result_id: Option<String>,
    #[serde(default)]
    start_asset_id: Option<String>,
    #[serde(default)]
    end_result_id: Option<String>,
    #[serde(default)]
    end_asset_id: Option<String>,
    request_snapshot: FalRequestSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FalRequestSnapshot {
    prompt: String,
    duration: Value,
    resolution: String,
    aspect_ratio: String,
    generate_audio: bool,
    seed: Option<u64>,
    bitrate_mode: String,
    input_fingerprint: Value,
    references: Vec<String>,
    estimated_cost_microunits: Option<i64>,
    #[serde(default)]
    cost_estimate: Option<Value>,
    #[serde(default)]
    cost_context: Option<crate::persistence::FalCostContext>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FalVideoRequest {
    pub run_id: String,
    pub project_id: String,
    pub node_id: String,
    pub endpoint: String,
    pub schema_hash: String,
    pub prompt: String,
    pub duration: Value,
    pub resolution: String,
    pub aspect_ratio: String,
    pub generate_audio: bool,
    pub seed: Option<u64>,
    pub bitrate_mode: String,
    pub start_frame: Option<String>,
    pub end_frame: Option<String>,
    pub references: Vec<String>,
    pub input_fingerprint: Value,
    pub estimated_cost_microunits: Option<i64>,
    #[serde(default)]
    pub cost_estimate: Option<Value>,
    #[serde(default)]
    pub cost_context: Option<crate::persistence::FalCostContext>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedFalVideoRequestContract {
    endpoint: String,
    schema_hash: String,
    prompt: String,
    duration: Value,
    resolution: String,
    aspect_ratio: String,
    generate_audio: bool,
    bitrate_mode: String,
    seed: Option<u64>,
    start_frame: Option<String>,
    end_frame: Option<String>,
    references: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FalPendingRun {
    run_id: String,
    project_id: String,
    node_id: String,
    endpoint: String,
    phase: FalRunPhase,
    created_at: String,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FalVideoResult {
    run_id: String,
    result_id: String,
    video_hash: String,
    start_frame_hash: String,
    end_frame_hash: String,
    media_type: String,
    media_metadata: MediaMetadata,
    poster_hash: Option<String>,
    cost_microunits: Option<i64>,
    billable_units: Option<String>,
    cost_provenance: &'static str,
    target_current: bool,
}

#[derive(Clone, Copy, Debug)]
struct EndpointSpec {
    family: &'static str,
    queue_app: &'static str,
    modality: &'static str,
    schema_hash: &'static str,
    reference_max: usize,
    end_frame: bool,
    seed: bool,
}
fn endpoint_spec(endpoint: &str) -> Option<EndpointSpec> {
    match endpoint {
        "bytedance/seedance-2.0/fast/text-to-video" => Some(EndpointSpec {
            family: "bytedance/seedance-2.0/fast",
            queue_app: "bytedance/seedance-2.0",
            modality: "text-to-video",
            schema_hash: "seedance-2-fast-t2v-2026-07",
            reference_max: 0,
            end_frame: false,
            seed: false,
        }),
        "bytedance/seedance-2.0/fast/image-to-video" => Some(EndpointSpec {
            family: "bytedance/seedance-2.0/fast",
            queue_app: "bytedance/seedance-2.0",
            modality: "image-to-video",
            schema_hash: "seedance-2-fast-i2v-2026-07",
            reference_max: 0,
            end_frame: true,
            seed: false,
        }),
        "bytedance/seedance-2.0/fast/reference-to-video" => Some(EndpointSpec {
            family: "bytedance/seedance-2.0/fast",
            queue_app: "bytedance/seedance-2.0",
            modality: "reference-to-video",
            schema_hash: "seedance-2-fast-r2v-2026-07",
            reference_max: 9,
            end_frame: false,
            seed: false,
        }),
        _ => None,
    }
}

fn configured_video_model_matches_endpoint(configured: &str, endpoint: &str) -> bool {
    let Some(requested) = endpoint_spec(endpoint) else {
        return false;
    };
    configured == requested.family
        || endpoint_spec(configured).is_some_and(|candidate| candidate.family == requested.family)
}

fn video_request_contract(request: &FalVideoRequest) -> Value {
    json!({
        "endpoint": request.endpoint,
        "schemaHash": request.schema_hash,
        "prompt": request.prompt,
        "duration": request.duration,
        "resolution": request.resolution,
        "aspectRatio": request.aspect_ratio,
        "generateAudio": request.generate_audio,
        "bitrateMode": request.bitrate_mode,
        "seed": request.seed,
        "startFrame": request.start_frame,
        "endFrame": request.end_frame,
        "references": request.references,
    })
}

fn resume_request_from_manifest(manifest: &FalRunManifest) -> Result<FalVideoRequest, String> {
    let contract_value = manifest
        .request_snapshot
        .input_fingerprint
        .get("requestContract")
        .cloned()
        .ok_or("Dem gespeicherten fal-Run fehlt der unveränderliche Request-Vertrag.")?;
    let contract: PersistedFalVideoRequestContract = serde_json::from_value(contract_value.clone())
        .map_err(|_| "Der gespeicherte fal-Request-Vertrag ist ungültig.".to_string())?;
    let request = FalVideoRequest {
        run_id: manifest.run_id.clone(),
        project_id: manifest.project_id.clone(),
        node_id: manifest.node_id.clone(),
        endpoint: manifest.endpoint.clone(),
        schema_hash: manifest.schema_hash.clone(),
        prompt: manifest.request_snapshot.prompt.clone(),
        duration: manifest.request_snapshot.duration.clone(),
        resolution: manifest.request_snapshot.resolution.clone(),
        aspect_ratio: manifest.request_snapshot.aspect_ratio.clone(),
        generate_audio: manifest.request_snapshot.generate_audio,
        seed: manifest.request_snapshot.seed,
        bitrate_mode: manifest.request_snapshot.bitrate_mode.clone(),
        start_frame: contract.start_frame,
        end_frame: contract.end_frame,
        references: contract.references,
        input_fingerprint: manifest.request_snapshot.input_fingerprint.clone(),
        estimated_cost_microunits: manifest.request_snapshot.estimated_cost_microunits,
        cost_estimate: manifest.request_snapshot.cost_estimate.clone(),
        cost_context: manifest.request_snapshot.cost_context.clone(),
    };
    let contract_matches_snapshot = contract.endpoint == request.endpoint
        && contract.schema_hash == request.schema_hash
        && contract.prompt == request.prompt
        && contract.duration == request.duration
        && contract.resolution == request.resolution
        && contract.aspect_ratio == request.aspect_ratio
        && contract.generate_audio == request.generate_audio
        && contract.bitrate_mode == request.bitrate_mode
        && contract.seed == request.seed
        && contract_value == video_request_contract(&request)
        && manifest.request_snapshot.references
            == request
                .references
                .iter()
                .map(|value| media_fingerprint(value))
                .collect::<Vec<_>>();
    if !contract_matches_snapshot {
        return Err("Der gespeicherte fal-Request-Vertrag passt nicht zum Run-Snapshot.".into());
    }
    validate_request(&request)?;
    Ok(request)
}

fn validate_request(request: &FalVideoRequest) -> Result<EndpointSpec, String> {
    let spec = endpoint_spec(&request.endpoint)
        .ok_or("Dieser fal.ai-Endpoint besitzt keinen geprüften FlowZ-Adapter.")?;
    if request.schema_hash != spec.schema_hash {
        return Err("Der Endpoint-Adapter ist veraltet. Bitte die Node neu öffnen.".into());
    }
    if request.project_id.is_empty()
        || request.node_id.is_empty()
        || request.prompt.trim().is_empty()
        || request.prompt.len() > 20_000
    {
        return Err("Projekt, Node und ein gültiger Prompt werden benötigt.".into());
    }
    let duration_valid = request.duration.as_str() == Some("auto")
        || request
            .duration
            .as_u64()
            .is_some_and(|value| (4..=15).contains(&value));
    if !duration_valid
        || !matches!(request.resolution.as_str(), "480p" | "720p")
        || !matches!(
            request.aspect_ratio.as_str(),
            "auto" | "21:9" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16"
        )
    {
        return Err(
            "Dauer, Auflösung oder Seitenverhältnis wird vom Endpoint nicht unterstützt.".into(),
        );
    }
    if (spec.modality == "image-to-video") != request.start_frame.is_some() {
        return Err(if spec.modality == "image-to-video" {
            "Dieser Endpoint benötigt genau ein Startbild."
        } else {
            "Dieser Endpoint unterstützt kein Startbild."
        }
        .into());
    }
    if request.end_frame.is_some() && !spec.end_frame {
        return Err("Dieser Endpoint unterstützt kein Endbild.".into());
    }
    if request.references.len() > spec.reference_max
        || (spec.modality == "reference-to-video" && request.references.is_empty())
    {
        return Err("Die Anzahl der Referenzbilder passt nicht zum Endpoint.".into());
    }
    if request.seed.is_some() && !spec.seed {
        return Err("Dieser Endpoint unterstützt keinen Seed.".into());
    }
    if !matches!(request.bitrate_mode.as_str(), "standard" | "high") {
        return Err("Dieser Bitratenmodus wird nicht unterstützt.".into());
    }
    if !request.input_fingerprint.is_object() {
        return Err("Der vollständige Input-Fingerprint fehlt.".into());
    }
    if let Some(snapshot) = request.cost_estimate.as_ref() {
        let amount = snapshot.get("amountMicrounits").and_then(Value::as_i64);
        let source = snapshot.get("source").and_then(Value::as_str);
        if serde_json::to_vec(snapshot)
            .map_err(|e| e.to_string())?
            .len()
            > 32_768
            || snapshot.get("schemaVersion").and_then(Value::as_u64) != Some(1)
            || snapshot.get("endpoint").and_then(Value::as_str) != Some(request.endpoint.as_str())
            || snapshot.get("adapterSchemaHash").and_then(Value::as_str)
                != Some(request.schema_hash.as_str())
            || snapshot.get("currency").and_then(Value::as_str) != Some("USD")
            || amount != request.estimated_cost_microunits
            || !amount.is_some_and(|v| (0..=1_000_000_000_000).contains(&v))
            || !(source.is_some_and(|value| value.starts_with("https://fal.ai/"))
                || source == Some("local-actual-history"))
            || (source == Some("local-actual-history")
                && (snapshot.get("provenance").and_then(Value::as_str) != Some("local-actual")
                    || snapshot.get("confidence").and_then(Value::as_str) != Some("empirical")))
        {
            return Err("Der Kosten-Snapshot ist ungültig oder passt nicht zum Endpoint.".into());
        }
    }
    if let Some(context) = request.cost_context.as_ref() {
        context.validate()?;
        let billable = context
            .billable_config
            .as_object()
            .ok_or("Der Fal-Kostenkontext ist ungültig.")?;
        if billable.get("modality").and_then(Value::as_str) != Some(spec.modality)
            || billable.get("duration") != Some(&request.duration)
            || billable.get("resolution").and_then(Value::as_str)
                != Some(request.resolution.as_str())
            || billable.get("generateAudio").and_then(Value::as_bool)
                != Some(request.generate_audio)
            || billable.get("aspectRatio").and_then(Value::as_str)
                != Some(request.aspect_ratio.as_str())
            || billable.get("bitrateMode").and_then(Value::as_str)
                != Some(request.bitrate_mode.as_str())
        {
            return Err("Der Fal-Kostenkontext passt nicht zu den Videoparametern.".into());
        }
    }
    Ok(spec)
}

fn verify_local_cost_estimate(
    request: &FalVideoRequest,
    persistence: &Persistence,
) -> Result<(), String> {
    let Some(snapshot) = request.cost_estimate.as_ref().filter(|value| {
        value.get("source").and_then(Value::as_str) == Some("local-actual-history")
    }) else {
        return Ok(());
    };
    let context = request
        .cost_context
        .as_ref()
        .ok_or("Der lokale Kostenschätzer benötigt einen Kostenkontext.")?;
    if snapshot
        .get("pricingManifestVersion")
        .and_then(Value::as_u64)
        != Some(context.pricing_manifest_version as u64)
        || snapshot.get("billableConfig") != Some(&context.billable_config)
    {
        return Err("Der lokale Kosten-Snapshot passt nicht zur empirischen Kohorte.".into());
    }
    let estimate =
        persistence
            .fal_empirical_costs
            .estimate(&crate::persistence::FalEmpiricalCostQuery {
                endpoint: request.endpoint.clone(),
                adapter_schema_hash: request.schema_hash.clone(),
                pricing_manifest_version: context.pricing_manifest_version,
                billable_config: context.billable_config.clone(),
            })?;
    let empirical = snapshot
        .get("empirical")
        .and_then(Value::as_object)
        .ok_or("Dem lokalen Kosten-Snapshot fehlen die empirischen Kennzahlen.")?;
    if estimate.state != "available"
        || snapshot.get("amountMicrounits").and_then(Value::as_i64) != estimate.median_microunits
        || empirical.get("sampleCount").and_then(Value::as_u64)
            != Some(estimate.sample_count as u64)
        || empirical.get("usedSampleCount").and_then(Value::as_u64)
            != Some(estimate.used_sample_count as u64)
        || empirical.get("rejectedOutliers").and_then(Value::as_u64)
            != Some(estimate.rejected_outliers as u64)
        || empirical.get("p25Microunits").and_then(Value::as_i64) != estimate.p25_microunits
        || empirical.get("p75Microunits").and_then(Value::as_i64) != estimate.p75_microunits
    {
        return Err(
            "Der lokale Kosten-Snapshot entspricht nicht der gespeicherten Actual-Historie.".into(),
        );
    }
    Ok(())
}

fn provider_cost(response: &Value) -> Option<i64> {
    let value = response
        .pointer("/usage/cost")
        .or_else(|| response.pointer("/data/usage/cost"))?;
    let decimal = match value {
        Value::String(value) => value.parse::<f64>().ok()?,
        Value::Number(value) => value.as_f64()?,
        _ => return None,
    };
    (decimal.is_finite() && decimal >= 0.0).then(|| (decimal * 1_000_000.0).round() as i64)
}

fn decode_image_data_url(value: &str) -> Result<(String, Vec<u8>), String> {
    let (header, encoded) = value
        .split_once(',')
        .ok_or("Referenzbild ist keine lokale Data-URL.")?;
    let media_type = header
        .strip_prefix("data:")
        .and_then(|item| item.strip_suffix(";base64"))
        .filter(|item| matches!(*item, "image/png" | "image/jpeg" | "image/webp"))
        .ok_or("Fal-Referenzen müssen PNG, JPEG oder WebP sein.")?;
    let bytes = BASE64
        .decode(encoded)
        .map_err(|_| "Referenzbild ist beschädigt.".to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_UPLOAD_BYTES {
        return Err("Ein Referenzbild darf höchstens 64 MiB groß sein.".into());
    }
    image::load_from_memory(&bytes).map_err(|_| "Referenzbild ist beschädigt.".to_string())?;
    Ok((media_type.into(), bytes))
}

fn prepare_upload_derivative(bytes: &[u8]) -> Result<(String, Vec<u8>), String> {
    let image =
        image::load_from_memory(bytes).map_err(|_| "Referenzbild ist beschädigt.".to_string())?;
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 || width.saturating_mul(height) > 100_000_000 {
        return Err("Das Referenzbild hat ungültige oder zu große Abmessungen.".into());
    }
    let image = if width.max(height) > 2048 {
        image.thumbnail(2048, 2048)
    } else {
        image
    };
    let rgba = image.to_rgba8();
    let has_alpha = rgba.pixels().any(|pixel| pixel.0[3] < 255);
    let mut output = Vec::new();
    if has_alpha {
        image::codecs::png::PngEncoder::new(&mut output)
            .write_image(
                &rgba,
                rgba.width(),
                rgba.height(),
                image::ExtendedColorType::Rgba8,
            )
            .map_err(|error| error.to_string())?;
        Ok(("image/png".into(), output))
    } else {
        let rgb = image::DynamicImage::ImageRgba8(rgba).to_rgb8();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, 88)
            .encode(
                &rgb,
                rgb.width(),
                rgb.height(),
                image::ExtendedColorType::Rgb8,
            )
            .map_err(|error| error.to_string())?;
        Ok(("image/jpeg".into(), output))
    }
}

pub(crate) fn api_client() -> Result<Client, String> {
    Client::builder()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|error| error.to_string())
}

pub(crate) async fn fal_upload(
    client: &Client,
    key: &str,
    source: &str,
    persistence: &Persistence,
    state: &FalProviderState,
) -> Result<String, String> {
    fal_upload_impl(client, key, source, persistence, state, true).await
}

pub(crate) async fn fal_upload_original_image(
    client: &Client,
    key: &str,
    source: &str,
    persistence: &Persistence,
    state: &FalProviderState,
) -> Result<String, String> {
    fal_upload_impl(client, key, source, persistence, state, false).await
}

async fn fal_upload_impl(
    client: &Client,
    key: &str,
    source: &str,
    persistence: &Persistence,
    state: &FalProviderState,
    derive: bool,
) -> Result<String, String> {
    let (_, bytes) = if let Some(hash) = source.strip_prefix("flowz-cas:") {
        let metadata = persistence.blobs.metadata(hash)?;
        if !matches!(
            metadata.media_type.as_str(),
            "image/png" | "image/jpeg" | "image/webp"
        ) {
            return Err("Die CAS-Referenz ist kein unterstütztes Bild.".into());
        }
        (metadata.media_type, persistence.blobs.read(hash)?)
    } else {
        decode_image_data_url(source)?
    };
    let (content_type, bytes) = if derive {
        prepare_upload_derivative(&bytes)?
    } else {
        let image = image::load_from_memory(&bytes)
            .map_err(|_| "Referenzbild ist beschädigt.".to_string())?;
        if image.width() == 0
            || image.height() == 0
            || image.width().saturating_mul(image.height()) > 100_000_000
        {
            return Err("Das Bild hat ungültige oder zu große Abmessungen.".into());
        }
        let media_type = image::guess_format(&bytes)
            .ok()
            .and_then(|format| match format {
                image::ImageFormat::Png => Some("image/png"),
                image::ImageFormat::Jpeg => Some("image/jpeg"),
                image::ImageFormat::WebP => Some("image/webp"),
                _ => None,
            })
            .ok_or("Nur PNG, JPEG und WebP können unverändert zu fal.ai übertragen werden.")?;
        (media_type.into(), bytes)
    };
    if bytes.is_empty() || bytes.len() > MAX_UPLOAD_BYTES {
        return Err("Die fal.ai-Referenzableitung ist leer oder größer als 64 MiB.".into());
    }
    let cache_key = format!("{}:{:x}", content_type, Sha256::digest(&bytes));
    if let Some(url) = state.cached_upload(&cache_key) {
        return Ok(url);
    }
    let response = client.post("https://rest.alpha.fal.ai/storage/upload/initiate")
        .header(header::AUTHORIZATION, format!("Key {key}"))
        .json(&json!({ "file_name": format!("flowz-{}.{}", Uuid::new_v4(), if content_type == "image/png" { "png" } else if content_type == "image/webp" { "webp" } else { "jpg" }), "content_type": content_type }))
        .send().await.map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "fal.ai konnte den privaten Medienupload nicht vorbereiten ({}).",
            response.status()
        ));
    }
    let body: Value = response
        .json()
        .await
        .map_err(|_| "Fal-Upload-Antwort ist ungültig.".to_string())?;
    let upload_url = body
        .get("upload_url")
        .and_then(Value::as_str)
        .ok_or("Fal-Upload-URL fehlt.")?;
    let file_url = body
        .get("file_url")
        .and_then(Value::as_str)
        .ok_or("Fal-Datei-URL fehlt.")?;
    let parsed = Url::parse(upload_url).map_err(|_| "Fal-Upload-URL ist ungültig.".to_string())?;
    if parsed.scheme() != "https" {
        return Err("Fal-Upload muss HTTPS verwenden.".into());
    }
    let put = client
        .put(parsed)
        .header(header::CONTENT_TYPE, &content_type)
        .body(bytes)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !put.status().is_success() {
        return Err(format!(
            "Fal-Referenzupload ist fehlgeschlagen ({}).",
            put.status()
        ));
    }
    let file_url = allowed_download_url(file_url)?.to_string();
    state.cache_upload(cache_key, file_url.clone())?;
    Ok(file_url)
}

pub(crate) async fn checked_fal_json(
    response: reqwest::Response,
) -> Result<(Value, Option<String>), String> {
    let status = response.status();
    let billable = response
        .headers()
        .get("x-fal-billable-units")
        .and_then(|item| item.to_str().ok())
        .map(str::to_owned);
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err(format!("fal.ai-Antwort war unerwartet groß ({status})."));
    }
    let body: Value = serde_json::from_slice(&bytes).map_err(|_| {
        let preview = String::from_utf8_lossy(&bytes)
            .chars()
            .filter(|character| !character.is_control())
            .take(160)
            .collect::<String>();
        format!(
            "fal.ai hat keine gültige JSON-Antwort geliefert ({status}){}",
            if preview.is_empty() {
                String::new()
            } else {
                format!(": {preview}")
            }
        )
    })?;
    if !status.is_success() {
        return Err(format!(
            "fal.ai-Anfrage fehlgeschlagen ({status}): {}",
            body.pointer("/detail")
                .and_then(Value::as_str)
                .or_else(|| body.pointer("/error/message").and_then(Value::as_str))
                .unwrap_or("Unbekannter Providerfehler")
        ));
    }
    Ok((body, billable))
}

/// Generic queue URL builder used by the image adapters, which already pass
/// the audited queue app for control requests. Video endpoints use the stricter
/// helpers below because their model path differs from their queue-control app.
pub(crate) fn fal_queue_url(endpoint: &str, request_id: Option<&str>, suffix: &str) -> String {
    match request_id {
        Some(id) => format!("https://queue.fal.run/{endpoint}/requests/{id}{suffix}"),
        None => format!("https://queue.fal.run/{endpoint}"),
    }
}

fn fal_submit_url(endpoint: &str) -> Result<String, String> {
    endpoint_spec(endpoint)
        .map(|_| format!("https://queue.fal.run/{endpoint}"))
        .ok_or("Dieser fal.ai-Endpoint besitzt keinen geprüften FlowZ-Adapter.".into())
}

#[derive(Clone, Copy)]
enum FalQueueRequestAction {
    Result,
    Status,
    Cancel,
}

fn fal_queue_request_url(
    endpoint: &str,
    request_id: &str,
    action: FalQueueRequestAction,
) -> Result<String, String> {
    let spec = endpoint_spec(endpoint)
        .ok_or("Dieser fal.ai-Endpoint besitzt keinen geprüften FlowZ-Adapter.")?;
    Uuid::parse_str(request_id).map_err(|_| "Fal-Request-ID ist ungültig.".to_string())?;
    let suffix = match action {
        FalQueueRequestAction::Result => "",
        FalQueueRequestAction::Status => "/status",
        FalQueueRequestAction::Cancel => "/cancel",
    };
    Ok(format!(
        "https://queue.fal.run/{}/requests/{request_id}{suffix}",
        spec.queue_app
    ))
}

async fn submit_and_wait(
    request: &FalVideoRequest,
    state: &FalProviderState,
    persistence: &Persistence,
    token: &CancellationToken,
) -> Result<(Value, Option<String>), String> {
    let spec = validate_request(request)?;
    let key = api_key()?;
    let client = api_client()?;
    let mut input = build_video_payload(request);
    if let Some(seed) = request.seed {
        input["seed"] = json!(seed);
    }
    if let Some(image) = &request.start_frame {
        input["image_url"] = json!(fal_upload(&client, &key, image, persistence, state).await?);
    }
    if let Some(image) = &request.end_frame {
        input["end_image_url"] = json!(fal_upload(&client, &key, image, persistence, state).await?);
    }
    if spec.reference_max > 0 {
        input["image_urls"] = json!(
            futures_util::future::try_join_all(request.references.iter().map(|item| fal_upload(
                &client,
                &key,
                item,
                persistence,
                state
            )))
            .await?
        );
    }

    let mut manifest = state.load(&request.run_id)?;
    let response = client
        .post(fal_submit_url(&request.endpoint)?)
        .header(header::AUTHORIZATION, format!("Key {key}"))
        .json(&input)
        .send()
        .await;
    let response = match response {
        Ok(value) => value,
        Err(error) => {
            manifest.phase = FalRunPhase::SubmitUnknown;
            manifest.error = Some(format!("Der Submit-Ausgang ist unbekannt: {error}. FlowZ sendet diesen Run nicht automatisch erneut."));
            manifest.updated_at = Utc::now().to_rfc3339();
            state.save(&manifest)?;
            return Err(manifest.error.unwrap());
        }
    };
    let (submitted, _) = match checked_fal_json(response).await {
        Ok(value) => value,
        Err(error) => {
            manifest.phase = FalRunPhase::Failed;
            manifest.error = Some(error.clone());
            manifest.updated_at = Utc::now().to_rfc3339();
            state.save(&manifest)?;
            return Err(error);
        }
    };
    let request_id = submitted
        .get("request_id")
        .and_then(Value::as_str)
        .ok_or("fal.ai hat keine Request-ID geliefert.")?
        .to_owned();
    manifest.request_id = Some(request_id.clone());
    manifest.phase = FalRunPhase::Queued;
    manifest.updated_at = Utc::now().to_rfc3339();
    state.save(&manifest)?;
    wait_existing(
        &client,
        &key,
        &request.endpoint,
        &request_id,
        &mut manifest,
        state,
        token,
    )
    .await
}

fn build_video_payload(request: &FalVideoRequest) -> Value {
    let mut input = json!({ "prompt": request.prompt, "duration": request.duration, "resolution": request.resolution, "aspect_ratio": request.aspect_ratio, "generate_audio": request.generate_audio, "bitrate_mode": request.bitrate_mode });
    if let Some(seed) = request.seed {
        input["seed"] = json!(seed);
    }
    input
}

async fn wait_existing(
    client: &Client,
    key: &str,
    endpoint: &str,
    request_id: &str,
    manifest: &mut FalRunManifest,
    state: &FalProviderState,
    token: &CancellationToken,
) -> Result<(Value, Option<String>), String> {
    loop {
        if token.is_cancelled() {
            return Err("Videogenerierung abgebrochen.".into());
        }
        let (status, _) = checked_fal_json(
            client
                .get(fal_queue_request_url(
                    endpoint,
                    request_id,
                    FalQueueRequestAction::Status,
                )?)
                .header(header::AUTHORIZATION, format!("Key {key}"))
                .send()
                .await
                .map_err(|error| error.to_string())?,
        )
        .await?;
        match status.get("status").and_then(Value::as_str) {
            Some("COMPLETED") => break,
            Some("IN_PROGRESS") if !matches!(manifest.phase, FalRunPhase::CancelRequested) => manifest.phase = FalRunPhase::InProgress,
            Some("IN_QUEUE") if !matches!(manifest.phase, FalRunPhase::CancelRequested) => manifest.phase = FalRunPhase::Queued,
            Some("IN_PROGRESS" | "IN_QUEUE") => {}
            Some("FAILED" | "CANCELED") => {
                manifest.phase = if matches!(manifest.phase, FalRunPhase::CancelRequested) { FalRunPhase::Cancelled } else { FalRunPhase::Failed };
                manifest.updated_at = Utc::now().to_rfc3339(); state.save(manifest)?;
                return Err("fal.ai hat die Videogenerierung beendet, ohne ein Ergebnis zu liefern.".into());
            }
            _ => return Err("fal.ai meldet einen unbekannten Queue-Status; der Run bleibt zur Wiederaufnahme gespeichert.".into()),
        }
        manifest.updated_at = Utc::now().to_rfc3339();
        state.save(manifest)?;
        tokio::select! { _ = token.cancelled() => return Err("Videogenerierung abgebrochen.".into()), _ = tokio::time::sleep(Duration::from_secs(2)) => {} }
    }
    checked_fal_json(
        client
            .get(fal_queue_request_url(
                endpoint,
                request_id,
                FalQueueRequestAction::Result,
            )?)
            .header(header::AUTHORIZATION, format!("Key {key}"))
            .send()
            .await
            .map_err(|error| error.to_string())?,
    )
    .await
}

pub(crate) fn allowed_download_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|_| "Fal-Ergebnis-URL ist ungültig.".to_string())?;
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if url.scheme() != "https"
        || !(host == "fal.media"
            || host.ends_with(".fal.media")
            || host == "storage.googleapis.com")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Fal-Ergebnis verweist nicht auf den erlaubten fal.media-CDN.".into());
    }
    Ok(url)
}

async fn download_video(
    client: &Client,
    raw: &str,
    target: &Path,
    token: &CancellationToken,
) -> Result<(), String> {
    let mut url = allowed_download_url(raw)?;
    for _ in 0..=3 {
        let response = client
            .get(url.clone())
            .send()
            .await
            .map_err(|error| error.to_string())?;
        if response.status().is_redirection() {
            let next = response
                .headers()
                .get(header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or("Fal-CDN-Weiterleitung ist ungültig.")?;
            url = allowed_download_url(
                url.join(next)
                    .map_err(|_| "Fal-CDN-Weiterleitung ist ungültig.".to_string())?
                    .as_str(),
            )?;
            continue;
        }
        if response.status() != StatusCode::OK {
            return Err(format!(
                "Fal-Video konnte nicht geladen werden ({}).",
                response.status()
            ));
        }
        if response
            .content_length()
            .is_some_and(|size| size == 0 || size > MAX_VIDEO_BYTES)
        {
            return Err("Fal-Video ist leer oder größer als 2 GiB.".into());
        }
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !content_type.starts_with("video/") && content_type != "application/octet-stream" {
            return Err("Fal-CDN lieferte kein Video.".into());
        }
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(target)
            .map_err(|error| error.to_string())?;
        let mut size = 0_u64;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            if token.is_cancelled() {
                let _ = std::fs::remove_file(target);
                return Err("Videodownload abgebrochen.".into());
            }
            let chunk = chunk.map_err(|error| error.to_string())?;
            size += chunk.len() as u64;
            if size > MAX_VIDEO_BYTES {
                let _ = std::fs::remove_file(target);
                return Err("Fal-Video ist größer als 2 GiB.".into());
            }
            file.write_all(&chunk).map_err(|error| error.to_string())?;
        }
        if size == 0 {
            return Err("Fal-CDN lieferte eine leere Datei.".into());
        }
        file.sync_all().map_err(|error| error.to_string())?;
        return Ok(());
    }
    Err("Fal-CDN hat zu oft weitergeleitet.".into())
}

async fn finalize_video(
    request: &FalVideoRequest,
    response: Value,
    billable_units: Option<String>,
    state: &FalProviderState,
    persistence: &Persistence,
    token: &CancellationToken,
) -> Result<FalVideoResult, String> {
    let url = response
        .pointer("/video/url")
        .or_else(|| response.pointer("/data/video/url"))
        .and_then(Value::as_str)
        .ok_or("fal.ai hat kein Video-Ergebnis geliefert.")?;
    let temporary = std::env::temp_dir().join(format!("flowz-fal-{}.video", request.run_id));
    let client = api_client()?;
    let result = async {
        download_video(&client, url, &temporary, token).await?;
        let cancelled = std::sync::atomic::AtomicBool::new(false);
        let snapshot = snapshot_media(&persistence.blobs, ImportBlobRequest { path: temporary.clone(), media_type: None, original_name: Some("fal-video.mp4".into()) }, &cancelled)?;
        let imported = inspect_media(&persistence.blobs, snapshot, "video", &cancelled)?;
        let start = extract_video_frame(&persistence.blobs, &imported.hash, 0.0)?;
        let end = extract_video_frame(&persistence.blobs, &imported.hash, (imported.metadata.duration_seconds - 0.05).max(0.0))?;
        let created_at = Utc::now().to_rfc3339();
        let actual_cost = provider_cost(&response);
        let recorded_cost = actual_cost.or(request.estimated_cost_microunits);
        let mut manifest = state.load(&request.run_id)?;
        let cancelled = matches!(manifest.phase, FalRunPhase::CancelRequested);
        let target_current = !cancelled && target_is_current(request, persistence);
        let result_id = manifest.result_id.get_or_insert_with(|| Uuid::new_v4().to_string()).clone();
        let video_asset = manifest.video_asset_id.get_or_insert_with(|| Uuid::new_v4().to_string()).clone();
        let start_result = manifest.start_result_id.get_or_insert_with(|| Uuid::new_v4().to_string()).clone();
        let start_asset = manifest.start_asset_id.get_or_insert_with(|| Uuid::new_v4().to_string()).clone();
        let end_result = manifest.end_result_id.get_or_insert_with(|| Uuid::new_v4().to_string()).clone();
        let end_asset = manifest.end_asset_id.get_or_insert_with(|| Uuid::new_v4().to_string()).clone();
        state.save(&manifest)?;
        let cost_provenance=if actual_cost.is_some(){"actual"}else if request.estimated_cost_microunits.is_some(){"estimated"}else{"unknown"};
        let parameters = json!({ "endpoint": request.endpoint, "schemaHash": request.schema_hash, "duration": request.duration, "resolution": request.resolution, "aspectRatio": request.aspect_ratio, "generateAudio": request.generate_audio, "bitrateMode": request.bitrate_mode, "startFrameHash": start.hash, "endFrameHash": end.hash, "billableUnits": billable_units, "estimatedCostMicrounits": request.estimated_cost_microunits, "costEstimateSnapshot":request.cost_estimate, "costProvenance":cost_provenance, "inputFingerprint": request.input_fingerprint, "referenceFingerprints": manifest.request_snapshot.references, "durationSeconds": imported.metadata.duration_seconds, "container": imported.metadata.container, "codecs": imported.metadata.codecs.join(" + "), "width": imported.metadata.width, "height": imported.metadata.height, "fps": imported.metadata.fps, "playable": imported.metadata.playable, "posterHash": imported.poster_hash, "orphaned": !target_current });
        persistence.database.record_fal_video_result_atomic(crate::persistence::FalVideoCommit { run_id: &request.run_id, project_id: &request.project_id, node_id: &request.node_id, endpoint: &request.endpoint, result_id: &result_id, video_asset_id: &video_asset, start_result_id: &start_result, start_asset_id: &start_asset, end_result_id: &end_result, end_asset_id: &end_asset, video: &imported.blob, poster: imported.poster_hash.as_deref().map(|hash| persistence.blobs.metadata(hash)).transpose()?.as_ref(), start: &start, end: &end, metadata: &imported.metadata, prompt: &request.prompt, parameters: &parameters, cost_microunits: recorded_cost, activate: target_current, created_at: &created_at })?;
        if let (Some(actual_cost_microunits), Some(context)) = (actual_cost, request.cost_context.as_ref()) {
            if let Err(error) = persistence.fal_empirical_costs.record_actual(crate::persistence::FalActualCostSample { run_id:&request.run_id,endpoint:&request.endpoint,adapter_schema_hash:&request.schema_hash,pricing_manifest_version:context.pricing_manifest_version,billable_config:&context.billable_config,actual_cost_microunits }) { eprintln!("FlowZ konnte die lokale Fal-Kostenprobe nicht speichern: {error}"); }
        }
        Ok(FalVideoResult { run_id: request.run_id.clone(), result_id, video_hash: imported.hash, start_frame_hash: start.hash, end_frame_hash: end.hash, media_type: imported.media_type, media_metadata: imported.metadata, poster_hash: imported.poster_hash, cost_microunits: recorded_cost, billable_units, cost_provenance, target_current })
    }.await;
    let _ = std::fs::remove_file(temporary);
    if let Ok(value) = &result {
        let mut manifest = state.load(&request.run_id)?;
        manifest.phase = FalRunPhase::Complete;
        manifest.result_id = Some(value.result_id.clone());
        manifest.video_hash = Some(value.video_hash.clone());
        manifest.start_frame_hash = Some(value.start_frame_hash.clone());
        manifest.end_frame_hash = Some(value.end_frame_hash.clone());
        manifest.updated_at = Utc::now().to_rfc3339();
        state.save(&manifest)?;
    }
    result
}

fn reconstruct_video_result(
    run_id: &str,
    persistence: &Persistence,
) -> Result<FalVideoResult, String> {
    let stored = persistence
        .database
        .result_for_run(run_id, "video")?
        .ok_or("Der finalisierte fal.ai-Run besitzt kein Videoergebnis.")?;
    let video_hash = stored
        .blob_hash
        .ok_or("Dem finalisierten fal.ai-Run fehlt das Videoobjekt.")?;
    let parameters = stored.parameters.unwrap_or_else(|| json!({}));
    let start_frame_hash = parameters
        .get("startFrameHash")
        .and_then(Value::as_str)
        .ok_or("Dem Video fehlt die Startframe-Abhängigkeit.")?
        .to_owned();
    let end_frame_hash = parameters
        .get("endFrameHash")
        .and_then(Value::as_str)
        .ok_or("Dem Video fehlt die Endframe-Abhängigkeit.")?
        .to_owned();
    persistence.blobs.metadata(&start_frame_hash)?;
    persistence.blobs.metadata(&end_frame_hash)?;
    let (media_metadata, poster_hash) = persistence.database.media_metadata(&video_hash)?;
    let estimate = parameters
        .get("estimatedCostMicrounits")
        .and_then(Value::as_i64);
    Ok(FalVideoResult {
        run_id: run_id.into(),
        result_id: stored.result_id,
        video_hash,
        start_frame_hash,
        end_frame_hash,
        media_type: stored.media_type.unwrap_or_else(|| "video/mp4".into()),
        media_metadata,
        poster_hash,
        cost_microunits: stored.cost_microunits.or(estimate),
        billable_units: parameters
            .get("billableUnits")
            .and_then(Value::as_str)
            .map(str::to_owned),
        cost_provenance: match parameters.get("costProvenance").and_then(Value::as_str) {
            Some("estimated") => "estimated",
            Some("unknown") => "unknown",
            Some("actual") => "actual",
            _ if stored.cost_microunits.is_some() => "actual",
            _ if estimate.is_some() => "estimated",
            _ => "unknown",
        },
        target_current: stored.active,
    })
}

#[tauri::command]
pub async fn fal_video_start(
    request: FalVideoRequest,
    state: tauri::State<'_, FalProviderState>,
    persistence: tauri::State<'_, Persistence>,
) -> Result<FalVideoResult, String> {
    validate_request(&request)?;
    verify_local_cost_estimate(&request, &persistence)?;
    Uuid::parse_str(&request.run_id).map_err(|_| "Ungültige fal-Run-ID.".to_string())?;
    if state.manifest_path(&request.run_id)?.exists() {
        return Err("Diese fal-Run-ID wurde bereits verwendet. Vorhandene Runs werden nur über Wiederaufnehmen fortgesetzt.".into());
    }
    let now = Utc::now().to_rfc3339();
    state.save(&FalRunManifest {
        run_id: request.run_id.clone(),
        project_id: request.project_id.clone(),
        node_id: request.node_id.clone(),
        endpoint: request.endpoint.clone(),
        schema_hash: request.schema_hash.clone(),
        phase: FalRunPhase::Preparing,
        request_id: None,
        created_at: now.clone(),
        updated_at: now,
        error: None,
        result_id: None,
        video_hash: None,
        start_frame_hash: None,
        end_frame_hash: None,
        video_asset_id: None,
        start_result_id: None,
        start_asset_id: None,
        end_result_id: None,
        end_asset_id: None,
        request_snapshot: FalRequestSnapshot {
            prompt: request.prompt.clone(),
            duration: request.duration.clone(),
            resolution: request.resolution.clone(),
            aspect_ratio: request.aspect_ratio.clone(),
            generate_audio: request.generate_audio,
            seed: request.seed,
            bitrate_mode: request.bitrate_mode.clone(),
            input_fingerprint: request.input_fingerprint.clone(),
            references: request
                .references
                .iter()
                .map(|value| media_fingerprint(value))
                .collect(),
            estimated_cost_microunits: request.estimated_cost_microunits,
            cost_estimate: request.cost_estimate.clone(),
            cost_context: request.cost_context.clone(),
        },
    })?;
    let token = CancellationToken::new();
    state
        .active
        .lock()
        .map_err(|_| "Fal-Run-Registry ist nicht verfügbar.".to_string())?
        .insert(request.run_id.clone(), token.clone());
    let output = match submit_and_wait(&request, &state, &persistence, &token).await {
        Ok((response, units)) => {
            let mut manifest = state.load(&request.run_id)?;
            if !matches!(manifest.phase, FalRunPhase::CancelRequested) {
                manifest.phase = FalRunPhase::Finalizing;
            }
            manifest.updated_at = Utc::now().to_rfc3339();
            state.save(&manifest)?;
            finalize_video(&request, response, units, &state, &persistence, &token).await
        }
        Err(error) => Err(error),
    };
    state
        .active
        .lock()
        .ok()
        .map(|mut runs| runs.remove(&request.run_id));
    output
}

fn media_fingerprint(value: &str) -> String {
    value
        .strip_prefix("flowz-cas:")
        .map(str::to_owned)
        .unwrap_or_else(|| format!("sha256:{:x}", Sha256::digest(value.as_bytes())))
}

fn target_is_current(request: &FalVideoRequest, persistence: &Persistence) -> bool {
    if validate_request(request).is_err() {
        return false;
    }
    let Ok(project) = persistence
        .projects
        .open(&request.project_id)
        .map(|record| record.project)
    else {
        return false;
    };
    let Some(node) = project
        .graph
        .nodes
        .iter()
        .find(|node| node.id == request.node_id && node.module_id == "ai.video-generation")
    else {
        return false;
    };
    let Some(snapshot) = request.input_fingerprint.as_object() else {
        return false;
    };
    let request_contract = video_request_contract(request);
    if !node
        .config
        .get("model")
        .and_then(Value::as_str)
        .is_some_and(|configured| {
            configured_video_model_matches_endpoint(configured, &request.endpoint)
        })
        || !crate::execution_snapshot::matches(
            &request.project_id,
            &request.node_id,
            &request.input_fingerprint,
            persistence,
            &["ai.video-generation"],
            Some(&request_contract),
        )
    {
        return false;
    }
    if snapshot.get("nodeConfig") != Some(&Value::Object(node.config.clone())) {
        return false;
    }
    let Some(expected_edges) = snapshot.get("connections").and_then(Value::as_array) else {
        return false;
    };
    let mut actual_edges = project
        .graph
        .edges
        .iter()
        .filter(|edge| edge.target_node_id == request.node_id)
        .collect::<Vec<_>>();
    actual_edges.sort_by(|a, b| {
        a.target_port_id
            .cmp(&b.target_port_id)
            .then(a.order.cmp(&b.order))
            .then(a.id.cmp(&b.id))
    });
    if actual_edges.len() != expected_edges.len() {
        return false;
    }
    actual_edges
        .iter()
        .zip(expected_edges)
        .all(|(edge, expected)| {
            expected.get("sourceNodeId").and_then(Value::as_str)
                == Some(edge.source_node_id.as_str())
                && expected.get("sourcePortId").and_then(Value::as_str)
                    == Some(edge.source_port_id.as_str())
                && expected.get("targetPortId").and_then(Value::as_str)
                    == Some(edge.target_port_id.as_str())
                && expected.get("order").and_then(Value::as_u64) == Some(edge.order)
        })
}

#[tauri::command]
pub async fn fal_video_resume(
    run_id: String,
    state: tauri::State<'_, FalProviderState>,
    persistence: tauri::State<'_, Persistence>,
) -> Result<FalVideoResult, String> {
    let manifest = state.load(&run_id)?;
    if matches!(
        manifest.phase,
        FalRunPhase::SubmitUnknown | FalRunPhase::Preparing
    ) {
        return Err("Dieser Run hat keine sichere fal.ai-Request-ID. FlowZ reicht ihn zum Schutz vor Doppelabrechnung nicht erneut ein.".into());
    }
    if matches!(manifest.phase, FalRunPhase::Complete) {
        return reconstruct_video_result(&run_id, &persistence);
    }
    if matches!(manifest.phase, FalRunPhase::Cancelled | FalRunPhase::Failed) {
        return Err("Dieser fal.ai-Run kann nicht wiederaufgenommen werden.".into());
    }
    let request = resume_request_from_manifest(&manifest)?;
    let request_id = manifest.request_id.clone().ok_or("Fal-Request-ID fehlt.")?;
    let token = CancellationToken::new();
    state
        .active
        .lock()
        .map_err(|_| "Fal-Run-Registry ist nicht verfügbar.".to_string())?
        .insert(run_id.clone(), token.clone());
    let client = api_client()?;
    let key = api_key()?;
    let mut mutable = manifest.clone();
    let waited = wait_existing(
        &client,
        &key,
        &manifest.endpoint,
        &request_id,
        &mut mutable,
        &state,
        &token,
    )
    .await;
    let (response, units) = match waited {
        Ok(value) => value,
        Err(error) => {
            state
                .active
                .lock()
                .ok()
                .map(|mut runs| runs.remove(&run_id));
            return Err(error);
        }
    };
    if !matches!(mutable.phase, FalRunPhase::CancelRequested) {
        mutable.phase = FalRunPhase::Finalizing;
    }
    mutable.updated_at = Utc::now().to_rfc3339();
    state.save(&mutable)?;
    let output = finalize_video(&request, response, units, &state, &persistence, &token).await;
    state
        .active
        .lock()
        .ok()
        .map(|mut runs| runs.remove(&run_id));
    output
}

#[tauri::command]
pub fn fal_pending_runs(
    project_id: String,
    node_id: Option<String>,
    state: tauri::State<'_, FalProviderState>,
) -> Result<Vec<FalPendingRun>, String> {
    let mut result = Vec::new();
    for entry in std::fs::read_dir(state.root.as_ref())
        .map_err(|error| error.to_string())?
        .flatten()
    {
        let Ok(bytes) = std::fs::read(entry.path()) else {
            continue;
        };
        if bytes.len() > 256 * 1024 {
            continue;
        }
        let Ok(item) = serde_json::from_slice::<FalRunManifest>(&bytes) else {
            continue;
        };
        if item.project_id == project_id
            && node_id.as_ref().is_none_or(|id| id == &item.node_id)
            && !matches!(
                item.phase,
                FalRunPhase::Complete | FalRunPhase::Cancelled | FalRunPhase::Failed
            )
        {
            result.push(FalPendingRun {
                run_id: item.run_id,
                project_id: item.project_id,
                node_id: item.node_id,
                endpoint: item.endpoint,
                phase: item.phase,
                created_at: item.created_at,
                error: item.error,
            });
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn fal_cancel_run(
    run_id: String,
    state: tauri::State<'_, FalProviderState>,
) -> Result<bool, String> {
    let mut manifest = state.load(&run_id)?;
    if let Some(request_id) = &manifest.request_id {
        let key = api_key()?;
        let client = api_client()?;
        let response = client
            .put(fal_queue_request_url(
                &manifest.endpoint,
                request_id,
                FalQueueRequestAction::Cancel,
            )?)
            .header(header::AUTHORIZATION, format!("Key {key}"))
            .send()
            .await
            .map_err(|error| error.to_string())?;
        if !response.status().is_success() && response.status() != StatusCode::CONFLICT {
            return Err(format!(
                "fal.ai konnte den Run nicht abbrechen ({}).",
                response.status()
            ));
        }
    }
    manifest.phase = FalRunPhase::CancelRequested;
    manifest.updated_at = Utc::now().to_rfc3339();
    state.save(&manifest)?;
    Ok(true)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractFrameRequest {
    project_id: String,
    node_id: String,
    video_hash: String,
    mode: String,
    value: Option<f64>,
    duration_seconds: f64,
    execution_fingerprint: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractFrameResult {
    result_id: String,
    image_hash: String,
}

#[tauri::command]
pub fn extract_video_frame_result(
    request: ExtractFrameRequest,
    persistence: tauri::State<'_, Persistence>,
) -> Result<ExtractFrameResult, String> {
    if request.project_id.is_empty()
        || request.node_id.is_empty()
        || !request.duration_seconds.is_finite()
        || request.duration_seconds <= 0.0
    {
        return Err("Ungültige Frame-Anfrage.".into());
    }
    let seconds = match request.mode.as_str() {
        "first" => 0.0,
        "last" => (request.duration_seconds - 0.05).max(0.0),
        "seconds" => request.value.unwrap_or(-1.0),
        "percent" => request.duration_seconds * request.value.unwrap_or(-1.0) / 100.0,
        _ => return Err("Unbekannter Frame-Modus.".into()),
    };
    if seconds < 0.0 || seconds > request.duration_seconds {
        return Err("Die Frame-Position liegt außerhalb des Videos.".into());
    }
    let blob = extract_video_frame(&persistence.blobs, &request.video_hash, seconds)?;
    persistence.database.upsert_blob(&blob)?;
    let run_id = Uuid::new_v4().to_string();
    let result_id = Uuid::new_v4().to_string();
    let asset_id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    persistence.database.record_local_completion(
        &run_id,
        &request.project_id,
        &request.node_id,
        "local/frame-extraction",
        &now,
    )?;
    persistence.database.attach_result(&result_id, &run_id, &request.project_id, &request.node_id, "video-frame", None, Some(&blob), Some(&asset_id), None, Some(&json!({"sourceVideoHash": request.video_hash, "mode": request.mode, "seconds": seconds, "executionFingerprint": request.execution_fingerprint})), &now, false)?;
    persistence
        .database
        .set_active_result(&request.project_id, &request.node_id, &result_id)?;
    Ok(ExtractFrameResult {
        result_id,
        image_hash: blob.hash,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set_video_execution_snapshot(
        request: &mut FalVideoRequest,
        config: &serde_json::Map<String, Value>,
        project_revision: u64,
    ) {
        let contract = video_request_contract(request);
        let execution = json!({
            "moduleId": "ai.video-generation",
            "moduleVersion": 1,
            "config": config,
            "inputs": []
        })
        .to_string();
        request.input_fingerprint = json!({
            "moduleId": "ai.video-generation",
            "moduleVersion": 1,
            "nodeConfig": config,
            "connections": [],
            "executionFingerprint": execution,
            "projectRevision": project_revision,
            "requestContract": contract
        });
    }

    #[test]
    fn provider_cost_accepts_both_fal_result_envelopes_and_rejects_invalid_values() {
        assert_eq!(
            provider_cost(&json!({"usage":{"cost":"0.006"}})),
            Some(6_000)
        );
        assert_eq!(
            provider_cost(&json!({"data":{"usage":{"cost":0.0425}}})),
            Some(42_500)
        );
        assert_eq!(provider_cost(&json!({"usage":{"cost":-1}})), None);
        assert_eq!(
            provider_cost(&json!({"usage":{"cost":"not-a-price"}})),
            None
        );
    }
    #[test]
    fn endpoints_fail_closed_and_schema_is_pinned() {
        assert!(endpoint_spec("fal-ai/unknown").is_none());
        let text = endpoint_spec("bytedance/seedance-2.0/fast/text-to-video").unwrap();
        assert_eq!(text.schema_hash, "seedance-2-fast-t2v-2026-07");
        assert_eq!(text.family, "bytedance/seedance-2.0/fast");
        assert!(configured_video_model_matches_endpoint(
            "bytedance/seedance-2.0/fast",
            "bytedance/seedance-2.0/fast/reference-to-video"
        ));
        assert!(configured_video_model_matches_endpoint(
            "bytedance/seedance-2.0/fast/text-to-video",
            "bytedance/seedance-2.0/fast/image-to-video"
        ));
        assert!(!configured_video_model_matches_endpoint(
            "bytedance/seedance-3.0/fast",
            "bytedance/seedance-2.0/fast/text-to-video"
        ));
        assert!(!configured_video_model_matches_endpoint(
            "bytedance/seedance-2.0/fast-evil",
            "bytedance/seedance-2.0/fast/text-to-video"
        ));
        assert!(!configured_video_model_matches_endpoint(
            "bytedance/seedance-2.0/fast",
            "bytedance/seedance-2.0/fast/unknown-mode"
        ));
    }
    #[test]
    fn image_to_video_accepts_the_frontend_cost_context_contract() {
        let mut request = FalVideoRequest {
            run_id: Uuid::new_v4().to_string(),
            project_id: "project".into(),
            node_id: "video".into(),
            endpoint: "bytedance/seedance-2.0/fast/image-to-video".into(),
            schema_hash: "seedance-2-fast-i2v-2026-07".into(),
            prompt: "A blue sphere moving slowly".into(),
            duration: json!(4),
            resolution: "480p".into(),
            aspect_ratio: "16:9".into(),
            generate_audio: false,
            seed: None,
            bitrate_mode: "standard".into(),
            start_frame: Some("flowz-cas:start".into()),
            end_frame: None,
            references: Vec::new(),
            input_fingerprint: json!({}),
            estimated_cost_microunits: None,
            cost_estimate: None,
            cost_context: Some(crate::persistence::FalCostContext {
                schema_version: 1,
                pricing_manifest_version: 1,
                billable_config: json!({
                    "modality": "image-to-video",
                    "duration": 4,
                    "resolution": "480p",
                    "generateAudio": false,
                    "aspectRatio": "16:9",
                    "bitrateMode": "standard"
                }),
            }),
        };

        assert!(validate_request(&request).is_ok());

        request.cost_context.as_mut().unwrap().billable_config["modality"] = json!("image");
        assert_eq!(
            validate_request(&request).unwrap_err(),
            "Der Fal-Kostenkontext passt nicht zu den Videoparametern."
        );
    }
    #[test]
    fn restart_resume_reconstructs_image_to_video_contract_and_keeps_target_current() {
        use crate::persistence::{
            CanvasPosition, CreateProjectRequest, GraphNode, SaveProjectRequest, UpdatePolicy,
        };

        let root = tempfile::tempdir().unwrap();
        let persistence = Persistence::initialize(root.path()).unwrap();
        let created = persistence
            .projects
            .create(CreateProjectRequest {
                name: "Resume video".into(),
            })
            .unwrap();
        let mut project = created.project;
        let config = serde_json::from_value::<serde_json::Map<String, Value>>(json!({
            "model": "bytedance/seedance-2.0/fast",
            "duration": 4,
            "resolution": "480p",
            "aspectRatio": "16:9",
            "generateAudio": false,
            "bitrateMode": "standard"
        }))
        .unwrap();
        project.graph.nodes.push(GraphNode {
            id: "video".into(),
            module_id: "ai.video-generation".into(),
            module_version: 1,
            position: CanvasPosition { x: 0.0, y: 0.0 },
            label: None,
            label_id: None,
            config: config.clone(),
            update_policy: UpdatePolicy::Manual,
        });
        let saved = persistence
            .projects
            .save(SaveProjectRequest {
                expected_updated_at: project.updated_at,
                expected_revision: created.revision,
                project: project.clone(),
            })
            .unwrap();
        let mut request = FalVideoRequest {
            run_id: Uuid::new_v4().to_string(),
            project_id: project.id,
            node_id: "video".into(),
            endpoint: "bytedance/seedance-2.0/fast/image-to-video".into(),
            schema_hash: "seedance-2-fast-i2v-2026-07".into(),
            prompt: "A blue sphere moving slowly".into(),
            duration: json!(4),
            resolution: "480p".into(),
            aspect_ratio: "16:9".into(),
            generate_audio: false,
            seed: None,
            bitrate_mode: "standard".into(),
            start_frame: Some("flowz-cas:start-frame-hash".into()),
            end_frame: None,
            references: Vec::new(),
            input_fingerprint: Value::Null,
            estimated_cost_microunits: None,
            cost_estimate: None,
            cost_context: None,
        };
        set_video_execution_snapshot(&mut request, &config, saved.revision);
        assert!(target_is_current(&request, &persistence));

        let now = Utc::now().to_rfc3339();
        let state = FalProviderState::initialize(root.path()).unwrap();
        state
            .save(&FalRunManifest {
                run_id: request.run_id.clone(),
                project_id: request.project_id.clone(),
                node_id: request.node_id.clone(),
                endpoint: request.endpoint.clone(),
                schema_hash: request.schema_hash.clone(),
                phase: FalRunPhase::Queued,
                request_id: Some(Uuid::new_v4().to_string()),
                created_at: now.clone(),
                updated_at: now,
                error: None,
                result_id: None,
                video_hash: None,
                start_frame_hash: None,
                end_frame_hash: None,
                video_asset_id: None,
                start_result_id: None,
                start_asset_id: None,
                end_result_id: None,
                end_asset_id: None,
                request_snapshot: FalRequestSnapshot {
                    prompt: request.prompt.clone(),
                    duration: request.duration.clone(),
                    resolution: request.resolution.clone(),
                    aspect_ratio: request.aspect_ratio.clone(),
                    generate_audio: request.generate_audio,
                    seed: request.seed,
                    bitrate_mode: request.bitrate_mode.clone(),
                    input_fingerprint: request.input_fingerprint.clone(),
                    references: Vec::new(),
                    estimated_cost_microunits: None,
                    cost_estimate: None,
                    cost_context: None,
                },
            })
            .unwrap();
        drop(state);

        let restarted = FalProviderState::initialize(root.path()).unwrap();
        let loaded = restarted.load(&request.run_id).unwrap();
        let resumed = resume_request_from_manifest(&loaded).unwrap();
        assert_eq!(resumed.start_frame, request.start_frame);
        assert_eq!(
            video_request_contract(&resumed),
            video_request_contract(&request)
        );
        assert!(target_is_current(&resumed, &persistence));

        let mut inconsistent = loaded.clone();
        inconsistent.request_snapshot.prompt = "A different prompt".into();
        assert!(resume_request_from_manifest(&inconsistent).is_err());
        let mut missing = loaded;
        missing
            .request_snapshot
            .input_fingerprint
            .as_object_mut()
            .unwrap()
            .remove("requestContract");
        assert!(resume_request_from_manifest(&missing).is_err());
    }
    #[test]
    fn video_target_accepts_audited_family_modes_and_rejects_contract_or_revision_change() {
        use crate::persistence::{
            CanvasPosition, CreateProjectRequest, GraphNode, SaveProjectRequest, UpdatePolicy,
        };

        let root = tempfile::tempdir().unwrap();
        let persistence = Persistence::initialize(root.path()).unwrap();
        let created = persistence
            .projects
            .create(CreateProjectRequest {
                name: "Video".into(),
            })
            .unwrap();
        let expected_updated_at = created.project.updated_at;
        let mut project = created.project;
        let config = serde_json::from_value::<serde_json::Map<String, Value>>(json!({
            "model": "bytedance/seedance-2.0/fast/text-to-video",
            "duration": 5,
            "resolution": "720p"
        }))
        .unwrap();
        project.graph.nodes.push(GraphNode {
            id: "video".into(),
            module_id: "ai.video-generation".into(),
            module_version: 1,
            position: CanvasPosition { x: 0.0, y: 0.0 },
            label: None,
            label_id: None,
            config: config.clone(),
            update_policy: UpdatePolicy::Manual,
        });
        let saved = persistence
            .projects
            .save(SaveProjectRequest {
                project: project.clone(),
                expected_updated_at,
                expected_revision: created.revision,
            })
            .unwrap();
        let mut request = FalVideoRequest {
            run_id: Uuid::new_v4().to_string(),
            project_id: project.id.clone(),
            node_id: "video".into(),
            endpoint: "bytedance/seedance-2.0/fast/text-to-video".into(),
            schema_hash: "seedance-2-fast-t2v-2026-07".into(),
            prompt: "A quiet product film".into(),
            duration: json!(5),
            resolution: "720p".into(),
            aspect_ratio: "16:9".into(),
            generate_audio: false,
            seed: None,
            bitrate_mode: "standard".into(),
            start_frame: None,
            end_frame: None,
            references: Vec::new(),
            input_fingerprint: Value::Null,
            estimated_cost_microunits: None,
            cost_estimate: None,
            cost_context: None,
        };
        set_video_execution_snapshot(&mut request, &config, saved.revision);
        assert!(target_is_current(&request, &persistence));

        request.endpoint = "bytedance/seedance-2.0/fast/image-to-video".into();
        request.schema_hash = "seedance-2-fast-i2v-2026-07".into();
        request.start_frame = Some("flowz-cas:start".into());
        set_video_execution_snapshot(&mut request, &config, saved.revision);
        assert!(validate_request(&request).is_ok());
        assert!(target_is_current(&request, &persistence));

        request.endpoint = "bytedance/seedance-2.0/fast/reference-to-video".into();
        request.schema_hash = "seedance-2-fast-r2v-2026-07".into();
        request.start_frame = None;
        request.references = vec!["flowz-cas:reference".into()];
        set_video_execution_snapshot(&mut request, &config, saved.revision);
        assert!(validate_request(&request).is_ok());
        assert!(target_is_current(&request, &persistence));

        request.schema_hash = "seedance-2-fast-i2v-2026-07".into();
        set_video_execution_snapshot(&mut request, &config, saved.revision);
        assert!(!target_is_current(&request, &persistence));

        request.endpoint = "bytedance/seedance-2.0/fast/image-to-video".into();
        request.references.clear();
        set_video_execution_snapshot(&mut request, &config, saved.revision);
        assert!(validate_request(&request).is_err());
        assert!(!target_is_current(&request, &persistence));

        request.endpoint = "bytedance/seedance-2.0/fast/reference-to-video".into();
        request.schema_hash = "seedance-2-fast-r2v-2026-07".into();
        request.references = vec!["flowz-cas:reference".into()];
        set_video_execution_snapshot(&mut request, &config, saved.revision);

        let current = persistence.projects.open(&project.id).unwrap();
        let mut family_project = current.project;
        family_project.graph.nodes[0]
            .config
            .insert("model".into(), json!("bytedance/seedance-2.0/fast"));
        let family_config = family_project.graph.nodes[0].config.clone();
        let family_saved = persistence
            .projects
            .save(SaveProjectRequest {
                expected_updated_at: family_project.updated_at,
                expected_revision: current.revision,
                project: family_project,
            })
            .unwrap();
        set_video_execution_snapshot(&mut request, &family_config, family_saved.revision);
        assert!(target_is_current(&request, &persistence));

        request.prompt = "A changed product film".into();
        assert!(!target_is_current(&request, &persistence));
        request.prompt = "A quiet product film".into();

        let current = persistence.projects.open(&project.id).unwrap();
        let mut changed = current.project;
        changed.graph.nodes[0]
            .config
            .insert("duration".into(), json!(10));
        persistence
            .projects
            .save(SaveProjectRequest {
                expected_updated_at: changed.updated_at,
                expected_revision: current.revision,
                project: changed,
            })
            .unwrap();
        assert!(!target_is_current(&request, &persistence));
    }
    #[test]
    fn queue_url_and_seedance_payload_match_the_audited_contract() {
        let mut request = FalVideoRequest {
            run_id: Uuid::new_v4().to_string(),
            project_id: "p".into(),
            node_id: "n".into(),
            endpoint: "bytedance/seedance-2.0/fast/reference-to-video".into(),
            schema_hash: "seedance-2-fast-r2v-2026-07".into(),
            prompt: "Brand film".into(),
            duration: json!(5),
            resolution: "720p".into(),
            aspect_ratio: "auto".into(),
            generate_audio: true,
            seed: None,
            bitrate_mode: "standard".into(),
            start_frame: None,
            end_frame: None,
            references: vec!["data:image/png;base64,AA==".into()],
            input_fingerprint: json!({}),
            estimated_cost_microunits: Some(1_209_500),
            cost_estimate: Some(json!({
                "schemaVersion":1,
                "endpoint":"bytedance/seedance-2.0/fast/reference-to-video",
                "adapterSchemaHash":"seedance-2-fast-r2v-2026-07",
                "currency":"USD",
                "source":"https://fal.ai/models/bytedance/seedance-2.0/fast/reference-to-video",
                "amountMicrounits":1_209_500
            })),
            cost_context: None,
        };
        assert!(validate_request(&request).is_ok());
        let payload = build_video_payload(&request);
        assert_eq!(
            fal_submit_url(&request.endpoint).unwrap(),
            "https://queue.fal.run/bytedance/seedance-2.0/fast/reference-to-video"
        );
        let request_id = "019f5c91-771c-7ab0-8226-d2d4b96686c9";
        assert_eq!(
            fal_queue_request_url(
                &request.endpoint,
                request_id,
                FalQueueRequestAction::Status
            )
            .unwrap(),
            "https://queue.fal.run/bytedance/seedance-2.0/requests/019f5c91-771c-7ab0-8226-d2d4b96686c9/status"
        );
        assert_eq!(
            fal_queue_request_url(
                &request.endpoint,
                request_id,
                FalQueueRequestAction::Result
            )
            .unwrap(),
            "https://queue.fal.run/bytedance/seedance-2.0/requests/019f5c91-771c-7ab0-8226-d2d4b96686c9"
        );
        assert_eq!(
            fal_queue_request_url(
                &request.endpoint,
                request_id,
                FalQueueRequestAction::Cancel
            )
            .unwrap(),
            "https://queue.fal.run/bytedance/seedance-2.0/requests/019f5c91-771c-7ab0-8226-d2d4b96686c9/cancel"
        );
        assert!(fal_submit_url("bytedance/seedance-2.0/fast/unknown").is_err());
        assert!(fal_queue_request_url(
            &request.endpoint,
            "../../foreign-request",
            FalQueueRequestAction::Status
        )
        .is_err());
        assert_eq!(payload["bitrate_mode"], "standard");
        assert!(payload.get("reference_image_urls").is_none());
        request.cost_estimate.as_mut().unwrap()["amountMicrounits"] = json!(1);
        assert!(validate_request(&request).is_err());
    }
    #[test]
    fn download_urls_only_allow_fal_media_https() {
        assert!(allowed_download_url("https://v3.fal.media/files/video.mp4").is_ok());
        assert!(
            allowed_download_url("https://storage.googleapis.com/falserverless/output.png").is_ok()
        );
        assert!(allowed_download_url("https://evil.storage.googleapis.com/output.png").is_err());
        assert!(
            allowed_download_url("https://storage.googleapis.com.evil.test/output.png").is_err()
        );
        assert!(allowed_download_url("http://v3.fal.media/video.mp4").is_err());
        assert!(allowed_download_url("https://fal.media.evil.test/video.mp4").is_err());
        assert!(allowed_download_url("https://127.0.0.1/video.mp4").is_err());
    }
    #[test]
    fn upload_derivatives_are_bounded_and_preserve_real_alpha() {
        let mut source = image::RgbaImage::new(2400, 1200);
        source.put_pixel(0, 0, image::Rgba([10, 20, 30, 0]));
        let mut encoded = Vec::new();
        image::codecs::png::PngEncoder::new(&mut encoded)
            .write_image(
                &source,
                source.width(),
                source.height(),
                image::ExtendedColorType::Rgba8,
            )
            .unwrap();
        let (media_type, derivative) = prepare_upload_derivative(&encoded).unwrap();
        let decoded = image::load_from_memory(&derivative).unwrap();
        assert_eq!(media_type, "image/png");
        assert!(decoded.width().max(decoded.height()) <= 2048);
        assert!(decoded.to_rgba8().pixels().any(|pixel| pixel.0[3] < 255));
    }
}
