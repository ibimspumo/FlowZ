use crate::{
    fal_provider::{self, FalProviderState},
    persistence::{ImportBlobRequest, Persistence},
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::Utc;
use futures_util::StreamExt;
use reqwest::{header, Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::Emitter;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const MANIFEST: &str = include_str!("../../src/nodes/image/fal-image-manifest.json");
const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_IMAGES_PER_RUN: usize = 6;
const MAX_SSE_BYTES: usize = 96 * 1024 * 1024;
const MAX_SSE_EVENTS: usize = 128;

#[derive(Clone)]
pub struct FalImageState {
    root: Arc<PathBuf>,
    active: Arc<Mutex<HashMap<String, CancellationToken>>>,
    transitions: Arc<tokio::sync::Mutex<()>>,
}

impl FalImageState {
    pub fn initialize(app_data: &Path) -> Result<Self, String> {
        let root = app_data.join("fal-image-runs");
        std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
        Ok(Self {
            root: Arc::new(root),
            active: Arc::new(Mutex::new(HashMap::new())),
            transitions: Arc::new(tokio::sync::Mutex::new(())),
        })
    }
    fn path(&self, id: &str) -> Result<PathBuf, String> {
        Uuid::parse_str(id).map_err(|_| "Ungültige fal-Bild-Run-ID.".to_string())?;
        Ok(self.root.join(format!("{id}.json")))
    }
    fn save(&self, run: &ImageRunManifest) -> Result<(), String> {
        let path = self.path(&run.run_id)?;
        let temporary = path.with_extension("json.tmp");
        let bytes = serde_json::to_vec(run).map_err(|error| error.to_string())?;
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| error.to_string())?;
        std::fs::rename(temporary, path).map_err(|error| error.to_string())
    }
    fn load(&self, id: &str) -> Result<ImageRunManifest, String> {
        let bytes = std::fs::read(self.path(id)?)
            .map_err(|_| "Der fal-Bild-Run ist nicht mehr vorhanden.".to_string())?;
        if bytes.len() > 512 * 1024 {
            return Err("Fal-Bild-Run-Manifest ist beschädigt.".into());
        }
        serde_json::from_slice(&bytes).map_err(|_| "Fal-Bild-Run-Manifest ist beschädigt.".into())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Phase {
    Preparing,
    SubmitUnknown,
    Queued,
    InProgress,
    Finalizing,
    Complete,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImageRunManifest {
    run_id: String,
    project_id: String,
    node_id: String,
    model_id: String,
    endpoint: String,
    schema_hash: String,
    phase: Phase,
    request_id: Option<String>,
    #[serde(default)]
    response_url: Option<String>,
    #[serde(default)]
    stream_submit_started: bool,
    created_at: String,
    updated_at: String,
    error: Option<String>,
    result_ids: Vec<String>,
    #[serde(default)]
    result_items: Vec<FalImageItem>,
    #[serde(default)]
    result_cost_microunits: Option<i64>,
    #[serde(default)]
    result_cost_provenance: Option<String>,
    request: FalImageRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FalImageRequest {
    pub run_id: String,
    pub project_id: String,
    pub node_id: String,
    pub model_id: String,
    pub endpoint: String,
    pub schema_hash: String,
    pub prompt: String,
    pub references: Vec<String>,
    pub mask: Option<String>,
    pub config: Value,
    pub input_fingerprint: Value,
    #[serde(default)]
    pub cost_estimate: Option<Value>,
    #[serde(default)]
    pub cost_context: Option<crate::persistence::FalCostContext>,
    #[serde(default)]
    pub streaming: bool,
    #[serde(default)]
    pub artboard_target: Option<ArtboardImageTarget>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtboardImageTarget {
    pub workspace_id: String,
    pub branch_id: String,
    pub board_id: String,
    pub expected_revision_id: String,
    pub expected_revision_number: u64,
    pub proposal_id: String,
    pub intent_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FalImageStreamEvent<'a> {
    project_id: &'a str,
    node_id: &'a str,
    run_id: &'a str,
    mode: &'static str,
    stage: &'static str,
    progress: Option<f32>,
    message: &'static str,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FalImageItem {
    result_id: String,
    asset_id: String,
    blob_hash: String,
    media_type: String,
    width: u32,
    height: u32,
    has_alpha: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FalImageResult {
    run_id: String,
    model_id: String,
    endpoint: String,
    images: Vec<FalImageItem>,
    cost_microunits: Option<i64>,
    billable_units: Option<String>,
    cost_provenance: &'static str,
    target_current: bool,
    contract_error: Option<&'static str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingImageRun {
    run_id: String,
    project_id: String,
    node_id: String,
    model_id: String,
    endpoint: String,
    phase: Phase,
    created_at: String,
    error: Option<String>,
    streaming: bool,
    resumable: bool,
}

fn manifest_model(id: &str) -> Result<Value, String> {
    let value: Value = serde_json::from_str(MANIFEST)
        .map_err(|_| "Das integrierte Bildmodell-Manifest ist beschädigt.".to_string())?;
    value
        .get("models")
        .and_then(Value::as_array)
        .and_then(|models| {
            models
                .iter()
                .find(|model| model.get("id").and_then(Value::as_str) == Some(id))
        })
        .cloned()
        .ok_or("Dieses Bildmodell besitzt keinen geprüften fal.ai-Adapter.".into())
}
fn strings(model: &Value, field: &str) -> Vec<String> {
    model
        .get(field)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}
fn config_str<'a>(config: &'a Value, field: &str) -> Option<&'a str> {
    config.get(field).and_then(Value::as_str)
}
fn config_u64(config: &Value, field: &str) -> Option<u64> {
    config.get(field).and_then(Value::as_u64)
}

fn validate(request: &FalImageRequest) -> Result<Value, String> {
    Uuid::parse_str(&request.run_id).map_err(|_| "Ungültige fal-Bild-Run-ID.".to_string())?;
    if request.project_id.is_empty() || request.node_id.is_empty() || request.prompt.len() > 32_000
    {
        return Err("Projekt, Node oder Prompt ist ungültig.".into());
    }
    if !request.input_fingerprint.is_object() {
        return Err("Der vollständige Input-Fingerprint fehlt.".into());
    }
    if let Some(target) = &request.artboard_target {
        let valid = [
            &target.workspace_id,
            &target.branch_id,
            &target.board_id,
            &target.expected_revision_id,
            &target.proposal_id,
            &target.intent_id,
        ]
        .into_iter()
        .all(|value| {
            !value.is_empty()
                && value.len() <= 128
                && value.chars().all(|character| {
                    character.is_ascii_alphanumeric() || ".:_-".contains(character)
                })
        });
        if !valid
            || request.project_id != target.workspace_id
            || request.node_id != format!("artboard-intent:{}", target.intent_id)
        {
            return Err("Der revisionsgebundene Artboard-Bildauftrag ist ungültig.".into());
        }
    }
    validate_cost_snapshot(request)?;
    let model = manifest_model(&request.model_id)?;
    if model.get("schemaHash").and_then(Value::as_str) != Some(&request.schema_hash) {
        return Err("Der Bildmodell-Adapter ist veraltet. Öffne die Node neu.".into());
    }
    let reference_count = request.references.len();
    let edit_mode = reference_count > 0 || request.mask.is_some();
    let expected_endpoint = if !edit_mode {
        model.get("textEndpoint")
    } else {
        model.get("editEndpoint")
    }
    .and_then(Value::as_str)
    .ok_or("Dieses Modell unterstützt keine Referenzbilder.")?;
    if request.endpoint != expected_endpoint {
        return Err("Endpoint und Eingabemodus passen nicht zusammen.".into());
    }
    if request.streaming {
        let declared = model.get("streaming").and_then(Value::as_bool) == Some(true);
        let status_only = model.get("streamingMode").and_then(Value::as_str) == Some("status");
        let exact_endpoint = strings(&model, "streamingEndpoints")
            .iter()
            .any(|endpoint| endpoint == &request.endpoint);
        if !declared || !status_only || !exact_endpoint {
            return Err("Dieser exakte fal.ai-Endpoint besitzt keinen geprüften Stream.".into());
        }
    }
    let maximum = model
        .pointer("/references/max")
        .and_then(Value::as_u64)
        .map(|v| v as usize);
    if maximum.is_some_and(|max| reference_count > max) {
        return Err(format!(
            "Dieses Modell unterstützt höchstens {} Referenzbilder.",
            maximum.unwrap()
        ));
    }
    if request.mask.is_some()
        && (reference_count == 0
            || model.get("supportsMask").and_then(Value::as_bool) != Some(true))
    {
        return Err("Dieser Edit-Endpoint unterstützt diese Maskeneingabe nicht.".into());
    }
    let redux =
        model.get("reduxNoPrompt").and_then(Value::as_bool) == Some(true) && reference_count > 0;
    if (!redux && request.prompt.trim().is_empty()) || (redux && !request.prompt.trim().is_empty())
    {
        return Err(if redux {
            "FLUX Redux akzeptiert keinen Text-Prompt."
        } else {
            "Ein Text-Prompt wird benötigt."
        }
        .into());
    }
    let variants = config_u64(&request.config, "variants").unwrap_or(0);
    if variants == 0 || variants > model.get("variantMax").and_then(Value::as_u64).unwrap_or(0) {
        return Err("Die Anzahl der Varianten wird nicht unterstützt.".into());
    }
    let mut allowed: HashSet<&str> = ["outputFormat", "variants"].into_iter().collect();
    let model_fields: &[&str] = match request.model_id.as_str() {
        "google/nano-banana-2-lite" => &["aspectRatio", "seed", "safetyTolerance", "thinkingLevel"],
        "fal-ai/nano-banana-pro" => &[
            "size",
            "aspectRatio",
            "seed",
            "safetyTolerance",
            "webSearch",
        ],
        "openai/gpt-image-2" => &["size", "quality"],
        "fal-ai/gpt-image-1.5" => {
            if edit_mode {
                &["size", "quality", "background", "inputFidelity"]
            } else {
                &["size", "quality", "background"]
            }
        }
        "fal-ai/flux/schnell" => {
            if edit_mode {
                &["size", "seed", "steps", "acceleration", "safetyChecker"]
            } else {
                &[
                    "size",
                    "seed",
                    "steps",
                    "guidance",
                    "acceleration",
                    "safetyChecker",
                ]
            }
        }
        "bytedance/seedream/v5/pro/text-to-image" => &["size", "safetyTolerance"],
        _ => &[],
    };
    allowed.extend(model_fields.iter().copied());
    let Some(config_object) = request.config.as_object() else {
        return Err("Bildparameter müssen ein Objekt sein.".into());
    };
    if let Some(foreign) = config_object
        .keys()
        .find(|key| !allowed.contains(key.as_str()))
    {
        return Err(format!(
            "Der gewählte Endpoint akzeptiert den Parameter „{foreign}“ nicht."
        ));
    }
    if config_str(&request.config, "outputFormat").is_none()
        || (request.model_id.starts_with("google/") || request.model_id == "fal-ai/nano-banana-pro")
            && config_str(&request.config, "aspectRatio").is_none()
        || (!request.model_id.starts_with("google/")
            && request.model_id != "fal-ai/nano-banana-pro")
            && config_str(&request.config, "size").is_none()
    {
        return Err("Ein erforderlicher endpointgenauer Bildparameter fehlt.".into());
    }
    for (config_field, manifest_field) in [
        ("size", "sizes"),
        ("aspectRatio", "aspectRatios"),
        ("outputFormat", "formats"),
        ("quality", "quality"),
        ("background", "background"),
        ("inputFidelity", "inputFidelity"),
        ("safetyTolerance", "safetyTolerance"),
        ("thinkingLevel", "thinkingLevels"),
    ] {
        if let Some(value) = config_str(&request.config, config_field) {
            let allowed = strings(&model, manifest_field);
            if !allowed.is_empty() && !allowed.contains(&value.to_owned()) {
                return Err(format!(
                    "Nicht unterstützter Bildparameter: {config_field}."
                ));
            }
        }
    }
    if config_str(&request.config, "background") == Some("transparent")
        && (request.model_id != "fal-ai/gpt-image-1.5"
            || config_str(&request.config, "outputFormat") != Some("png"))
    {
        return Err("Transparenz ist ausschließlich mit GPT Image 1.5 als PNG erlaubt.".into());
    }
    if reference_count == 0 && request.config.get("inputFidelity").is_some() {
        return Err("Input Fidelity ist ausschließlich für Edit-Läufe verfügbar.".into());
    }
    if request.config.get("seed").is_some()
        && model.get("seed").and_then(Value::as_bool) != Some(true)
    {
        return Err("Dieses Modell unterstützt keinen Seed.".into());
    }
    if request.config.get("webSearch").and_then(Value::as_bool) == Some(true)
        && model.get("webSearch").and_then(Value::as_bool) != Some(true)
    {
        return Err("Dieses Modell unterstützt keine Websuche.".into());
    }
    if let Some(acceleration) = config_str(&request.config, "acceleration") {
        if !strings(&model, "acceleration").contains(&acceleration.to_owned()) {
            return Err("Diese Beschleunigungsstufe wird nicht unterstützt.".into());
        }
    }
    if request.config.get("safetyChecker").is_some()
        && model.get("safetyChecker").and_then(Value::as_bool) != Some(true)
    {
        return Err("Dieser Endpoint besitzt keinen konfigurierbaren Safety Checker.".into());
    }
    if let Some(steps) = config_u64(&request.config, "steps") {
        let range = model
            .get("steps")
            .and_then(Value::as_object)
            .ok_or("Dieser Endpoint unterstützt keine Schrittzahl.")?;
        if steps < range.get("min").and_then(Value::as_u64).unwrap_or(u64::MAX)
            || steps > range.get("max").and_then(Value::as_u64).unwrap_or(0)
        {
            return Err("Die Schrittzahl liegt außerhalb des Endpointbereichs.".into());
        }
    }
    if let Some(guidance) = request.config.get("guidance").and_then(Value::as_f64) {
        let range = model
            .get("guidance")
            .and_then(Value::as_object)
            .ok_or("Dieser Endpoint unterstützt kein Guidance.")?;
        if !guidance.is_finite()
            || guidance
                < range
                    .get("min")
                    .and_then(Value::as_f64)
                    .unwrap_or(f64::INFINITY)
            || guidance
                > range
                    .get("max")
                    .and_then(Value::as_f64)
                    .unwrap_or(f64::NEG_INFINITY)
        {
            return Err("Guidance liegt außerhalb des Endpointbereichs.".into());
        }
    }
    Ok(model)
}

fn validate_cost_snapshot(request: &FalImageRequest) -> Result<(), String> {
    if let Some(snapshot) = request.cost_estimate.as_ref() {
        let source = snapshot.get("source").and_then(Value::as_str);
        let source_valid = source.is_some_and(|value| value.starts_with("https://fal.ai/"))
            || source == Some("local-actual-history");
        if serde_json::to_vec(snapshot)
            .map_err(|e| e.to_string())?
            .len()
            > 32_768
            || snapshot.get("schemaVersion").and_then(Value::as_u64) != Some(1)
            || snapshot.get("endpoint").and_then(Value::as_str) != Some(request.endpoint.as_str())
            || snapshot.get("adapterSchemaHash").and_then(Value::as_str)
                != Some(request.schema_hash.as_str())
            || snapshot.get("currency").and_then(Value::as_str) != Some("USD")
            || snapshot
                .get("amountMicrounits")
                .and_then(Value::as_u64)
                .is_none_or(|v| v > 1_000_000_000_000)
            || !source_valid
            || (source == Some("local-actual-history")
                && (snapshot.get("provenance").and_then(Value::as_str) != Some("local-actual")
                    || snapshot.get("confidence").and_then(Value::as_str) != Some("empirical")))
        {
            return Err("Der Kosten-Snapshot ist ungültig oder passt nicht zum Endpoint.".into());
        }
    }
    validate_cost_context(request)
}

fn verify_local_cost_estimate(
    request: &FalImageRequest,
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

fn validate_cost_context(request: &FalImageRequest) -> Result<(), String> {
    let Some(context) = request.cost_context.as_ref() else {
        return Ok(());
    };
    context.validate()?;
    let billable = context
        .billable_config
        .as_object()
        .ok_or("Der Fal-Kostenkontext ist ungültig.")?;
    let expected_modality = if request.endpoint.ends_with("/edit")
        || !request.references.is_empty()
        || request.mask.is_some()
    {
        "edit"
    } else {
        "text"
    };
    if billable.get("modality").and_then(Value::as_str) != Some(expected_modality)
        || billable.get("config") != Some(&request.config)
        || billable.get("referenceCount").and_then(Value::as_u64)
            != Some(request.references.len() as u64)
        || billable.get("mask").and_then(Value::as_bool) != Some(request.mask.is_some())
    {
        return Err("Der Fal-Kostenkontext passt nicht zu den Bildparametern.".into());
    }
    Ok(())
}

async fn upload_references(
    request: &FalImageRequest,
    persistence: &Persistence,
    shared: &FalProviderState,
    client: &Client,
    key: &str,
) -> Result<Vec<String>, String> {
    futures_util::future::try_join_all(
        request
            .references
            .iter()
            .map(|source| fal_provider::fal_upload(client, key, source, persistence, shared)),
    )
    .await
}

fn build_input(request: &FalImageRequest, model: &Value, urls: &[String]) -> Value {
    let mut input = serde_json::Map::new();
    let redux =
        model.get("reduxNoPrompt").and_then(Value::as_bool) == Some(true) && !urls.is_empty();
    if !redux {
        input.insert("prompt".into(), json!(request.prompt));
    }
    let config = &request.config;
    let banana = matches!(
        request.model_id.as_str(),
        "google/nano-banana-2-lite" | "fal-ai/nano-banana-pro"
    );
    if banana {
        if let Some(value) = config_str(config, "aspectRatio") {
            input.insert("aspect_ratio".into(), json!(value));
        }
        if request.model_id == "fal-ai/nano-banana-pro" {
            if let Some(value) = config_str(config, "size") {
                input.insert("resolution".into(), json!(value));
            }
        }
    } else if let Some(value) = config_str(config, "size") {
        input.insert("image_size".into(), json!(value));
    }
    let mappings = [
        ("outputFormat", "output_format"),
        ("quality", "quality"),
        ("background", "background"),
        ("safetyTolerance", "safety_tolerance"),
        ("thinkingLevel", "thinking_level"),
    ];
    for (from, to) in mappings {
        if let Some(value) = config_str(config, from) {
            input.insert(to.into(), json!(value));
        }
    }
    if !urls.is_empty() {
        if let Some(value) = config_str(config, "inputFidelity") {
            input.insert("input_fidelity".into(), json!(value));
        }
    }
    input.insert(
        "num_images".into(),
        json!(config_u64(config, "variants").unwrap_or(1)),
    );
    if let Some(value) = config_u64(config, "seed") {
        input.insert("seed".into(), json!(value));
    }
    if let Some(value) = config_u64(config, "steps") {
        input.insert("num_inference_steps".into(), json!(value));
    }
    if let Some(value) = config.get("guidance").and_then(Value::as_f64) {
        input.insert("guidance_scale".into(), json!(value));
    }
    if let Some(value) = config_str(config, "acceleration") {
        input.insert("acceleration".into(), json!(value));
    }
    if let Some(value) = config.get("safetyChecker").and_then(Value::as_bool) {
        input.insert("enable_safety_checker".into(), json!(value));
    }
    if model.get("webSearch").and_then(Value::as_bool) == Some(true) {
        if let Some(value) = config.get("webSearch").and_then(Value::as_bool) {
            input.insert("enable_web_search".into(), json!(value));
        }
    }
    if !urls.is_empty() {
        if redux {
            input.insert("image_url".into(), json!(urls[0]));
        } else {
            input.insert("image_urls".into(), json!(urls));
        }
    }
    Value::Object(input)
}

fn emit_stream_status(
    app: &tauri::AppHandle,
    request: &FalImageRequest,
    stage: &'static str,
    message: &'static str,
) {
    let _ = app.emit(
        "fal-image-stream",
        FalImageStreamEvent {
            project_id: &request.project_id,
            node_id: &request.node_id,
            run_id: &request.run_id,
            mode: "status",
            stage,
            progress: None,
            message,
        },
    );
}

fn valid_stream_request_id(raw: &str) -> bool {
    !raw.is_empty()
        && raw.len() <= 200
        && raw
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

#[derive(Default)]
struct SseDecoder {
    pending: Vec<u8>,
    scan_from: usize,
    event_data: Vec<u8>,
    total_bytes: usize,
    event_count: usize,
}

impl SseDecoder {
    fn feed(&mut self, chunk: &[u8]) -> Result<Vec<Value>, String> {
        self.total_bytes = self
            .total_bytes
            .checked_add(chunk.len())
            .ok_or("Fal-Stream ist zu groß.")?;
        if self.total_bytes > MAX_SSE_BYTES {
            return Err("Fal-Stream überschreitet das sichere 96-MiB-Limit.".into());
        }
        self.pending.extend_from_slice(chunk);
        let mut events = Vec::new();
        loop {
            let Some(relative) = self.pending[self.scan_from..]
                .iter()
                .position(|byte| *byte == b'\n')
            else {
                self.scan_from = self.pending.len();
                break;
            };
            let newline = self.scan_from + relative;
            let mut line = self.pending.drain(..=newline).collect::<Vec<_>>();
            self.scan_from = 0;
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            self.line(&line, &mut events)?;
        }
        Ok(events)
    }

    fn line(&mut self, line: &[u8], events: &mut Vec<Value>) -> Result<(), String> {
        if line.is_empty() {
            if !self.event_data.is_empty() {
                if self.event_data.last() == Some(&b'\n') {
                    self.event_data.pop();
                }
                self.event_count += 1;
                if self.event_count > MAX_SSE_EVENTS {
                    return Err("Fal-Stream lieferte zu viele Ereignisse.".into());
                }
                let value = serde_json::from_slice::<Value>(&self.event_data)
                    .map_err(|_| "Fal-Stream lieferte ungültiges JSON.".to_string())?;
                if !value.is_object() {
                    return Err("Fal-Stream lieferte kein JSON-Objekt.".into());
                }
                self.event_data.clear();
                events.push(value);
            }
            return Ok(());
        }
        if line[0] == b':' {
            return Ok(());
        }
        let (field, mut value) = match line.iter().position(|byte| *byte == b':') {
            Some(index) => (&line[..index], &line[index + 1..]),
            None => (line, &[][..]),
        };
        if value.first() == Some(&b' ') {
            value = &value[1..];
        }
        if field == b"data" {
            let next_len = self
                .event_data
                .len()
                .checked_add(value.len() + 1)
                .ok_or("Fal-Streamereignis ist zu groß.")?;
            if next_len > MAX_SSE_BYTES {
                return Err("Fal-Streamereignis überschreitet das sichere Limit.".into());
            }
            self.event_data.extend_from_slice(value);
            self.event_data.push(b'\n');
        }
        Ok(())
    }

    fn finish(mut self) -> Result<Vec<Value>, String> {
        let mut events = Vec::new();
        if !self.pending.is_empty() {
            let mut line = std::mem::take(&mut self.pending);
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            self.line(&line, &mut events)?;
        }
        self.line(&[], &mut events)?;
        Ok(events)
    }
}

fn mark_submit_unknown(
    state: &FalImageState,
    run: &mut ImageRunManifest,
    detail: impl AsRef<str>,
) -> Result<String, String> {
    run.phase = Phase::SubmitUnknown;
    run.error = Some(format!(
        "FLOWZ_SUBMIT_UNKNOWN: Der Streaming-Ausgang ist unbekannt: {} FlowZ sendet nicht automatisch erneut; dieser Stream kann nicht fortgesetzt werden.",
        detail.as_ref()
    ));
    run.updated_at = Utc::now().to_rfc3339();
    let message = run.error.clone().unwrap_or_default();
    match state.save(run) {
        Ok(()) => Ok(message),
        Err(persistence_error) => Err(format!(
            "{message} Zusätzlich konnte dieser Schutzstatus nicht dauerhaft gespeichert werden: {persistence_error}"
        )),
    }
}

fn submit_unknown_error(
    state: &FalImageState,
    run: &mut ImageRunManifest,
    detail: impl AsRef<str>,
) -> String {
    mark_submit_unknown(state, run, detail).unwrap_or_else(|error| error)
}

async fn open_stream_response(
    client: &Client,
    key: &str,
    url: &str,
    input: &Value,
    token: &CancellationToken,
    state: &FalImageState,
    run: &mut ImageRunManifest,
) -> Result<reqwest::Response, String> {
    if token.is_cancelled() {
        return Err("Bildgenerierung vor dem Streaming-Submit abgebrochen.".into());
    }
    // From this durable boundary onward the HTTP request may have reached fal.ai.
    // A local abort can no longer prove that no billable generation happened.
    run.stream_submit_started = true;
    run.updated_at = Utc::now().to_rfc3339();
    state.save(run)?;
    tokio::select! {
        _ = token.cancelled() => Err(submit_unknown_error(
            state,
            run,
            "Der Lauf wurde abgebrochen, nachdem der kostenpflichtige Streaming-Submit begonnen hatte.",
        )),
        response = client
            .post(url)
            .header(header::AUTHORIZATION, format!("Key {key}"))
            .header(header::ACCEPT, "text/event-stream")
            .json(input)
            .send() => match response {
                Ok(response) => Ok(response),
                Err(error) => Err(submit_unknown_error(state, run, error.to_string())),
            },
    }
}

async fn stream_submit(
    app: &tauri::AppHandle,
    request: &FalImageRequest,
    state: &FalImageState,
    shared: &FalProviderState,
    persistence: &Persistence,
    token: &CancellationToken,
) -> Result<(Value, Option<String>), String> {
    let model = validate(request)?;
    let client = fal_provider::api_client()?;
    let key = fal_provider::api_key()?;
    emit_stream_status(app, request, "preparing", "node.falStream.preparing");
    let urls = tokio::select! {
        _ = token.cancelled() => return Err("Bildgenerierung abgebrochen.".into()),
        result = upload_references(request, persistence, shared, &client, &key) => result?,
    };
    let mask_url = match &request.mask {
        Some(source) => Some(tokio::select! {
            _ = token.cancelled() => return Err("Bildgenerierung abgebrochen.".into()),
            result = fal_provider::fal_upload(&client, &key, source, persistence, shared) => result?,
        }),
        None => None,
    };
    let mut input = build_input(request, &model, &urls);
    if let (Some(mask_url), Some(object)) = (mask_url, input.as_object_mut()) {
        object.insert("mask_image_url".into(), json!(mask_url));
    }
    let mut run = state.load(&request.run_id)?;
    emit_stream_status(app, request, "connecting", "node.falStream.connecting");
    let url = format!("https://fal.run/{}/stream", request.endpoint);
    let response =
        open_stream_response(&client, &key, &url, &input, token, state, &mut run).await?;
    if let Some(request_id) = response
        .headers()
        .get("x-fal-request-id")
        .and_then(|value| value.to_str().ok())
        .filter(|value| valid_stream_request_id(value))
    {
        run.request_id = Some(request_id.to_owned());
    }
    if !response.status().is_success() {
        run.phase = Phase::Failed;
        run.error = Some(format!(
            "fal.ai hat den Stream mit HTTP {} abgelehnt.",
            response.status().as_u16()
        ));
        run.updated_at = Utc::now().to_rfc3339();
        state.save(&run)?;
        return Err(run.error.unwrap_or_default());
    }
    let content_type_ok = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.to_ascii_lowercase().starts_with("text/event-stream"));
    if !content_type_ok {
        return Err(submit_unknown_error(
            state,
            &mut run,
            "fal.ai lieferte keinen bestätigten SSE-Stream.",
        ));
    }
    let billable = response
        .headers()
        .get("x-fal-billable-units")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty() && value.len() <= 100)
        .map(str::to_owned);
    run.phase = Phase::InProgress;
    run.updated_at = Utc::now().to_rfc3339();
    state.save(&run)?;
    emit_stream_status(app, request, "streaming", "node.falStream.streaming");
    let mut decoder = SseDecoder::default();
    let mut last_event = None;
    let mut body = response.bytes_stream();
    loop {
        let next = tokio::select! {
            _ = token.cancelled() => return Err(submit_unknown_error(
                state,
                &mut run,
                "Der laufende Stream wurde lokal abgebrochen; fal.ai bietet für diesen Direktstream keinen bestätigten Provider-Cancel.",
            )),
            next = body.next() => next,
        };
        let Some(chunk) = next else { break };
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(error) => return Err(submit_unknown_error(state, &mut run, error.to_string())),
        };
        let events = decoder
            .feed(&chunk)
            .map_err(|error| submit_unknown_error(state, &mut run, error))?;
        if let Some(event) = events.into_iter().last() {
            last_event = Some(event);
        }
    }
    let trailing = decoder
        .finish()
        .map_err(|error| submit_unknown_error(state, &mut run, error))?;
    if let Some(event) = trailing.into_iter().last() {
        last_event = Some(event);
    }
    let Some(result) = last_event.filter(|event| {
        event.get("images").and_then(Value::as_array).is_some()
            || event
                .pointer("/data/images")
                .and_then(Value::as_array)
                .is_some()
    }) else {
        return Err(submit_unknown_error(
            state,
            &mut run,
            "der Stream endete ohne vollständiges Bildergebnis.",
        ));
    };
    emit_stream_status(app, request, "finalizing", "node.falStream.finalizing");
    Ok((result, billable))
}

async fn wait_result(
    client: &Client,
    key: &str,
    run: &mut ImageRunManifest,
    state: &FalImageState,
    token: &CancellationToken,
) -> Result<(Value, Option<String>), String> {
    run.request_id.as_deref().ok_or("Fal-Request-ID fehlt.")?;
    loop {
        if token.is_cancelled() {
            return Err("Bildgenerierung abgebrochen.".into());
        }
        let base = run
            .response_url
            .as_deref()
            .ok_or("Dem fal.ai-Run fehlt die geprüfte Response-URL.")?;
        let (status, _) = safe_queue_get(client, key, base, "/status", token).await?;
        match status.get("status").and_then(Value::as_str) {
            Some("COMPLETED") => break,
            Some("IN_PROGRESS") => run.phase = Phase::InProgress,
            Some("IN_QUEUE") => run.phase = Phase::Queued,
            Some("FAILED") => {
                return Err("fal.ai hat die Bildgenerierung als fehlgeschlagen markiert.".into())
            }
            _ => {
                return Err(
                    "fal.ai meldet einen unbekannten Queue-Status; der Run bleibt gespeichert."
                        .into(),
                )
            }
        }
        run.updated_at = Utc::now().to_rfc3339();
        state.save(run)?;
        tokio::select! { _ = token.cancelled() => return Err("Bildgenerierung abgebrochen.".into()), _ = tokio::time::sleep(Duration::from_secs(1)) => {} }
    }
    let base = run
        .response_url
        .as_deref()
        .ok_or("Dem fal.ai-Run fehlt die geprüfte Response-URL.")?;
    safe_queue_get(client, key, base, "", token).await
}

async fn safe_queue_get(
    client: &Client,
    key: &str,
    base: &str,
    suffix: &str,
    token: &CancellationToken,
) -> Result<(Value, Option<String>), String> {
    let mut last_error = String::new();
    for attempt in 0..3 {
        if token.is_cancelled() {
            return Err("Bildgenerierung abgebrochen.".into());
        }
        let response = client
            .get(format!("{base}{suffix}"))
            .header(header::AUTHORIZATION, format!("Key {key}"))
            .send()
            .await
            .map_err(|error| error.to_string());
        match response {
            Ok(response) => match fal_provider::checked_fal_json(response).await {
                Ok(value) => return Ok(value),
                Err(error) => last_error = error,
            },
            Err(error) => last_error = error,
        }
        if attempt < 2 {
            tokio::select! { _ = token.cancelled() => return Err("Bildgenerierung abgebrochen.".into()), _ = tokio::time::sleep(Duration::from_millis(400 * (attempt + 1))) => {} }
        }
    }
    Err(format!(
        "fal.ai-Queue-Antwort blieb nach drei sicheren Leseversuchen ungültig: {last_error}"
    ))
}

async fn submit(
    request: &FalImageRequest,
    state: &FalImageState,
    shared: &FalProviderState,
    persistence: &Persistence,
    token: &CancellationToken,
) -> Result<(Value, Option<String>), String> {
    let model = validate(request)?;
    let client = fal_provider::api_client()?;
    let key = fal_provider::api_key()?;
    let urls = upload_references(request, persistence, shared, &client, &key).await?;
    let mask_url = match &request.mask {
        Some(source) => {
            Some(fal_provider::fal_upload(&client, &key, source, persistence, shared).await?)
        }
        None => None,
    };
    let mut input = build_input(request, &model, &urls);
    if let (Some(mask_url), Some(object)) = (mask_url, input.as_object_mut()) {
        object.insert("mask_image_url".into(), json!(mask_url));
    }
    let mut run = state.load(&request.run_id)?;
    let response = client
        .post(fal_provider::fal_queue_url(&request.endpoint, None, ""))
        .header(header::AUTHORIZATION, format!("Key {key}"))
        .json(&input)
        .send()
        .await;
    let response = match response {
        Ok(value) => value,
        Err(error) => {
            run.phase = Phase::SubmitUnknown;
            run.error = Some(format!(
                "Der Submit-Ausgang ist unbekannt: {error}. FlowZ sendet nicht automatisch erneut."
            ));
            run.updated_at = Utc::now().to_rfc3339();
            state.save(&run)?;
            return Err(run.error.unwrap());
        }
    };
    let submitted = match fal_provider::checked_fal_json(response).await {
        Ok((value, _)) => value,
        Err(error) => {
            run.phase = Phase::SubmitUnknown;
            run.error = Some(format!("Fal-Submit lieferte keine sichere Request-ID: {error} FlowZ sendet nicht automatisch erneut."));
            run.updated_at = Utc::now().to_rfc3339();
            state.save(&run)?;
            return Err(run.error.unwrap());
        }
    };
    let Some(request_id) = submitted
        .get("request_id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= 200)
    else {
        run.phase = Phase::SubmitUnknown;
        run.error = Some(
            "Fal-Submit lieferte keine sichere Request-ID. FlowZ sendet nicht automatisch erneut."
                .into(),
        );
        run.updated_at = Utc::now().to_rfc3339();
        state.save(&run)?;
        return Err(run.error.unwrap());
    };
    run.request_id = Some(request_id.to_owned());
    let response_url = submitted
        .get("response_url")
        .and_then(Value::as_str)
        .and_then(|raw| validate_queue_response_url(raw, &request.endpoint, request_id).ok())
        .unwrap_or_else(|| {
            fal_provider::fal_queue_url(&queue_result_app(&request.endpoint), Some(request_id), "")
        });
    run.response_url = Some(response_url);
    run.phase = Phase::Queued;
    run.updated_at = Utc::now().to_rfc3339();
    state.save(&run)?;
    wait_result(&client, &key, &mut run, state, token).await
}

fn validate_queue_response_url(
    raw: &str,
    endpoint: &str,
    request_id: &str,
) -> Result<String, String> {
    let url = Url::parse(raw).map_err(|_| "Response-URL ist ungültig.".to_string())?;
    let expected_path = format!("/{}/requests/{request_id}", queue_result_app(endpoint));
    if url.scheme() != "https"
        || url.host_str() != Some("queue.fal.run")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != expected_path
    {
        return Err("Response-URL stimmt nicht exakt mit Endpoint und Request-ID überein.".into());
    }
    Ok(url.to_string().trim_end_matches('/').to_owned())
}

fn queue_result_app(endpoint: &str) -> String {
    endpoint.split('/').take(2).collect::<Vec<_>>().join("/")
}

async fn download_image(
    client: &Client,
    raw: &str,
    token: &CancellationToken,
) -> Result<(Vec<u8>, String, u32, u32, bool), String> {
    if raw.starts_with("data:") {
        return decode_data_image(raw);
    }
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
        return validate_image_bytes(bytes, None);
    }
    Err("Fal-CDN hat zu oft weitergeleitet.".into())
}

fn decode_data_image(raw: &str) -> Result<(Vec<u8>, String, u32, u32, bool), String> {
    let (metadata, encoded) = raw
        .split_once(',')
        .ok_or("Fal-Stream lieferte eine ungültige Bild-Data-URI.")?;
    let declared = metadata
        .strip_prefix("data:")
        .and_then(|value| value.strip_suffix(";base64"))
        .filter(|value| matches!(*value, "image/png" | "image/jpeg" | "image/webp"))
        .ok_or("Fal-Stream lieferte keinen erlaubten Base64-Bildtyp.")?;
    let max_encoded = (MAX_IMAGE_BYTES as usize).div_ceil(3) * 4 + 4;
    if encoded.is_empty()
        || encoded.len() > max_encoded
        || !encoded
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
    {
        return Err("Fal-Streambild überschreitet das sichere Limit oder ist ungültig.".into());
    }
    let bytes = BASE64
        .decode(encoded)
        .map_err(|_| "Fal-Stream lieferte ungültige Base64-Bilddaten.".to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES as usize {
        return Err("Fal-Streambild überschreitet das sichere 64-MiB-Limit.".into());
    }
    validate_image_bytes(bytes, Some(declared))
}

fn validate_image_bytes(
    bytes: Vec<u8>,
    declared_media_type: Option<&str>,
) -> Result<(Vec<u8>, String, u32, u32, bool), String> {
    let format = image::guess_format(&bytes)
        .map_err(|_| "Fal-Ergebnis ist kein unterstütztes Bild.".to_string())?;
    let media_type = match format {
        image::ImageFormat::Png => "image/png",
        image::ImageFormat::Jpeg => "image/jpeg",
        image::ImageFormat::WebP => "image/webp",
        _ => return Err("Fal-Ergebnis besitzt kein erlaubtes Bildformat.".into()),
    };
    if declared_media_type.is_some_and(|declared| declared != media_type) {
        return Err(
            "Fal-Streambild stimmt nicht mit seinem deklarierten Medientyp überein.".into(),
        );
    }
    let decoded = image::load_from_memory_with_format(&bytes, format)
        .map_err(|_| "Fal-Bild ist beschädigt.".to_string())?;
    let (width, height) = (decoded.width(), decoded.height());
    if width == 0
        || height == 0
        || width > 16384
        || height > 16384
        || u64::from(width) * u64::from(height) > 100_000_000
    {
        return Err("Fal-Bildabmessungen liegen außerhalb des sicheren Bereichs.".into());
    }
    let has_alpha =
        decoded.color().has_alpha() && decoded.to_rgba8().pixels().any(|pixel| pixel.0[3] < 255);
    Ok((bytes, media_type.to_string(), width, height, has_alpha))
}

fn estimated_cost(
    request: &FalImageRequest,
    model: &Value,
    dimensions: &[(u32, u32)],
) -> Option<i64> {
    let variants = config_u64(&request.config, "variants")? as i64;
    match model.pointer("/price/kind").and_then(Value::as_str)? {
        "nano-banana-pro" => Some(
            variants
                * if config_str(&request.config, "size") == Some("4K") {
                    300_000
                } else {
                    150_000
                }
                + if request.config.get("webSearch").and_then(Value::as_bool) == Some(true) {
                    15_000
                } else {
                    0
                },
        ),
        "flux-megapixel" => Some(
            dimensions
                .iter()
                .map(|(w, h)| {
                    ((f64::from(*w) * f64::from(*h) / 1_000_000.0).ceil()
                        * if request.endpoint.ends_with("/redux") {
                            25_000.0
                        } else {
                            3_000.0
                        }) as i64
                })
                .sum(),
        ),
        "seedream-v5" => Some(
            variants
                * if dimensions
                    .iter()
                    .any(|(w, h)| u64::from(*w) * u64::from(*h) > 1536 * 1536)
                {
                    135_000
                } else {
                    67_500
                }
                + variants * (request.references.len().saturating_sub(1) as i64) * 4_500,
        ),
        "gpt-image-1.5" => {
            let size = config_str(&request.config, "size")?;
            let quality = config_str(&request.config, "quality")?;
            let landscape = size == "1536x1024";
            let portrait = size == "1024x1536";
            let usd = match (quality, landscape, portrait) {
                ("low", false, false) => 9_000,
                ("medium", false, false) => 34_000,
                ("high", false, false) => 133_000,
                ("low", _, _) => 13_000,
                ("medium", true, false) => 50_000,
                ("medium", false, true) => 51_000,
                ("high", true, false) => 199_000,
                ("high", false, true) => 200_000,
                _ => return None,
            };
            Some(variants * usd)
        }
        _ => None,
    }
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

async fn finalize(
    request: &FalImageRequest,
    response: Value,
    billable: Option<String>,
    state: &FalImageState,
    persistence: &Persistence,
    token: &CancellationToken,
) -> Result<FalImageResult, String> {
    let array = response
        .get("images")
        .or_else(|| response.pointer("/data/images"))
        .and_then(Value::as_array)
        .ok_or("fal.ai hat keine Bilder geliefert.")?;
    if array.is_empty() || array.len() > MAX_IMAGES_PER_RUN {
        return Err("fal.ai lieferte eine ungültige Anzahl Bilder.".into());
    }
    let client = fal_provider::api_client()?;
    let mut downloaded = Vec::new();
    for item in array {
        let url = item
            .get("url")
            .and_then(Value::as_str)
            .ok_or("Fal-Bild-URL fehlt.")?;
        downloaded.push(download_image(&client, url, token).await?);
    }
    let contract_error = config_str(&request.config, "background") == Some("transparent")
        && downloaded.iter().any(|item| !item.4);
    let model = manifest_model(&request.model_id)?;
    let actual = provider_cost(&response);
    let estimated = estimated_cost(
        request,
        &model,
        &downloaded.iter().map(|i| (i.2, i.3)).collect::<Vec<_>>(),
    );
    let cost = actual.or(estimated);
    let provenance = if actual.is_some() {
        "actual"
    } else if estimated.is_some() {
        "estimated"
    } else {
        "unknown"
    };
    let created = Utc::now().to_rfc3339();
    let current = !contract_error && target_current(request, persistence);
    let mut blobs = Vec::new();
    let mut result_ids = Vec::new();
    let mut asset_ids = Vec::new();
    let mut parameters = Vec::new();
    for (index, (bytes, media_type, width, height, has_alpha)) in downloaded.iter().enumerate() {
        let temporary =
            std::env::temp_dir().join(format!("flowz-fal-image-{}-{index}.tmp", request.run_id));
        std::fs::write(&temporary, bytes).map_err(|e| e.to_string())?;
        let extension = if media_type == "image/png" {
            "png"
        } else if media_type == "image/webp" {
            "webp"
        } else {
            "jpg"
        };
        let blob = persistence.blobs.import(ImportBlobRequest {
            path: temporary.clone(),
            media_type: Some(media_type.clone()),
            original_name: Some(format!("fal-image-{}.{}", index + 1, extension)),
        });
        let _ = std::fs::remove_file(temporary);
        let blob = blob?;
        blobs.push(blob);
        result_ids.push(
            request
                .artboard_target
                .as_ref()
                .map(|_| format!("fal-artboard-result-{}-{index}", request.run_id))
                .unwrap_or_else(|| Uuid::new_v4().to_string()),
        );
        asset_ids.push(
            request
                .artboard_target
                .as_ref()
                .map(|_| format!("fal-artboard-asset-{}-{index}", request.run_id))
                .unwrap_or_else(|| Uuid::new_v4().to_string()),
        );
        parameters.push(json!({"endpoint":request.endpoint,"schemaHash":request.schema_hash,"variant":index+1,"variantCount":array.len(),"width":width,"height":height,"hasAlpha":has_alpha,"costProvenance":provenance,"costEstimateSnapshot":request.cost_estimate,"billableUnits":billable,"inputFingerprint":request.input_fingerprint,"orphaned":!current,"contractError":contract_error.then_some("Requested transparency was not present in every decoded output.")}));
    }
    let variants = blobs
        .iter()
        .enumerate()
        .map(|(index, blob)| crate::persistence::FalImageVariantCommit {
            result_id: &result_ids[index],
            asset_id: &asset_ids[index],
            blob,
            parameters: &parameters[index],
        })
        .collect::<Vec<_>>();
    let stored = if let Some(target) = &request.artboard_target {
        persistence.database.reconcile_blobs(&blobs)?;
        let mut stored = Vec::new();
        for (index, blob) in blobs.iter().enumerate() {
            let asset_id = &asset_ids[index];
            let version_id = format!("fal-artboard-version-{}-{index}", request.run_id);
            let created_asset = persistence.database.create_library_asset(
                asset_id,
                &version_id,
                &format!("{} · {}", target.board_id, target.intent_id),
                "image",
                None,
                Some(blob),
                None,
                None,
                Some(&request.node_id),
                None,
                &created,
            );
            if let Err(error) = created_asset {
                if !persistence
                    .database
                    .library_asset_version_matches(&version_id, &blob.hash)?
                {
                    return Err(error);
                }
            }
            stored.push(crate::persistence::StoredResult {
                result_id: result_ids[index].clone(),
                run_id: request.run_id.clone(),
                project_id: target.workspace_id.clone(),
                node_id: request.node_id.clone(),
                kind: "image".into(),
                text_value: None,
                blob_hash: Some(blob.hash.clone()),
                asset_id: Some(asset_id.clone()),
                media_type: Some(blob.media_type.clone()),
                created_at: created.clone(),
                cost_microunits: cost,
                model: Some(request.endpoint.clone()),
                prompt: Some(request.prompt.clone()),
                parameters: Some(parameters[index].clone()),
                active: false,
            });
        }
        stored
    } else {
        persistence.database.record_fal_image_results_atomic(
            crate::persistence::FalImageCommit {
                run_id: &request.run_id,
                project_id: &request.project_id,
                node_id: &request.node_id,
                endpoint: &request.endpoint,
                prompt: &request.prompt,
                variants: &variants,
                cost_microunits: cost,
                activate: current,
                error_code: contract_error.then_some("transparency_contract"),
                created_at: &created,
            },
        )?
    };
    if let (Some(actual_cost_microunits), Some(context)) = (actual, request.cost_context.as_ref()) {
        if let Err(error) =
            persistence
                .fal_empirical_costs
                .record_actual(crate::persistence::FalActualCostSample {
                    run_id: &request.run_id,
                    endpoint: &request.endpoint,
                    adapter_schema_hash: &request.schema_hash,
                    pricing_manifest_version: context.pricing_manifest_version,
                    billable_config: &context.billable_config,
                    actual_cost_microunits,
                })
        {
            eprintln!("FlowZ konnte die lokale Fal-Kostenprobe nicht speichern: {error}");
        }
    }
    let results = stored
        .into_iter()
        .map(|item| {
            let blob_hash = item
                .blob_hash
                .ok_or("Gespeichertem fal.ai-Bild fehlt der Blob.")?;
            let metadata = item.parameters.unwrap_or_else(|| json!({}));
            Ok(FalImageItem {
                result_id: item.result_id,
                asset_id: item
                    .asset_id
                    .ok_or("Gespeichertem fal.ai-Bild fehlt das Asset.")?,
                blob_hash,
                media_type: item
                    .media_type
                    .ok_or("Gespeichertem fal.ai-Bild fehlt der Medientyp.")?,
                width: metadata
                    .get("width")
                    .and_then(Value::as_u64)
                    .and_then(|v| u32::try_from(v).ok())
                    .unwrap_or(0),
                height: metadata
                    .get("height")
                    .and_then(Value::as_u64)
                    .and_then(|v| u32::try_from(v).ok())
                    .unwrap_or(0),
                has_alpha: metadata
                    .get("hasAlpha")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let mut run = state.load(&request.run_id)?;
    run.phase = Phase::Complete;
    run.result_ids = results.iter().map(|item| item.result_id.clone()).collect();
    run.result_items = results.clone();
    run.result_cost_microunits = cost;
    run.result_cost_provenance = Some(provenance.into());
    // Provider URLs are required only while recovering an unfinished request.
    // A terminal manifest retains request/result identities, never provider URLs.
    run.response_url = None;
    run.updated_at = Utc::now().to_rfc3339();
    state.save(&run)?;
    Ok(FalImageResult {
        run_id: request.run_id.clone(),
        model_id: request.model_id.clone(),
        endpoint: request.endpoint.clone(),
        images: results,
        cost_microunits: cost,
        billable_units: billable,
        cost_provenance: provenance,
        target_current: current,
        contract_error: contract_error.then_some("Transparenz angefordert, aber mindestens ein Ergebnis besitzt keine tatsächlich transparenten Pixel. Das bezahlte Diagnosebild wurde inaktiv gesichert."),
    })
}

fn target_current(request: &FalImageRequest, persistence: &Persistence) -> bool {
    if let Some(target) = &request.artboard_target {
        let Ok(Some(revision)) = persistence
            .database
            .artboard_revision(&target.expected_revision_id)
        else {
            return false;
        };
        if revision.workspace_id != target.workspace_id
            || revision.branch_id != target.branch_id
            || revision.revision_number != target.expected_revision_number as i64
        {
            return false;
        }
        let Ok(Some(workspace)) = persistence
            .database
            .open_artboard_workspace(&target.workspace_id)
        else {
            return false;
        };
        return workspace.branches.iter().any(|branch| {
            branch.id == target.branch_id && branch.head_revision_id == target.expected_revision_id
        }) && revision
            .workspace
            .get("boards")
            .and_then(|boards| boards.get(&target.board_id))
            .is_some();
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
        .find(|node| node.id == request.node_id)
    else {
        return false;
    };
    let Some(snapshot) = request.input_fingerprint.as_object() else {
        return false;
    };
    if !matches!(
        node.module_id.as_str(),
        "ai.image-generation" | "brand.logo-design"
    ) || snapshot.get("moduleId").and_then(Value::as_str) != Some(node.module_id.as_str())
        || snapshot.get("moduleVersion").and_then(Value::as_u64)
            != Some(u64::from(node.module_version))
    {
        return false;
    }
    let request_contract = json!({"modelId":request.model_id,"endpoint":request.endpoint,"schemaHash":request.schema_hash,"prompt":request.prompt,"references":request.references,"mask":request.mask,"config":request.config,"streaming":request.streaming});
    if snapshot.get("requestContract") != Some(&request_contract) {
        return false;
    }
    if snapshot.get("nodeConfig") != Some(&Value::Object(node.config.clone())) {
        return false;
    }
    if node.config.get("model").and_then(Value::as_str) != Some(request.model_id.as_str()) {
        return false;
    }
    let Some(fingerprint) = snapshot
        .get("executionFingerprint")
        .and_then(Value::as_str)
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
    else {
        return false;
    };
    if fingerprint.get("moduleId").and_then(Value::as_str) != Some(node.module_id.as_str())
        || fingerprint.get("moduleVersion").and_then(Value::as_u64)
            != Some(u64::from(node.module_version))
        || fingerprint.get("config") != Some(&Value::Object(node.config.clone()))
    {
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
    let Some(fingerprint_inputs) = fingerprint.get("inputs").and_then(Value::as_array) else {
        return false;
    };
    if fingerprint_inputs.len() != actual_edges.len() {
        return false;
    }
    for (edge, input) in actual_edges.iter().zip(fingerprint_inputs) {
        if input.get("sourceNodeId").and_then(Value::as_str) != Some(edge.source_node_id.as_str())
            || input.get("sourcePortId").and_then(Value::as_str)
                != Some(edge.source_port_id.as_str())
            || input.get("targetPortId").and_then(Value::as_str)
                != Some(edge.target_port_id.as_str())
            || input.get("order").and_then(Value::as_u64) != Some(edge.order)
        {
            return false;
        }
        let Some(source) = project
            .graph
            .nodes
            .iter()
            .find(|node| node.id == edge.source_node_id)
        else {
            return false;
        };
        let value = if source.module_id == "core.text-input" {
            source.config.get("text").cloned().unwrap_or(Value::Null)
        } else {
            persistence
                .database
                .active_result_identity(&request.project_id, &source.id)
                .ok()
                .flatten()
                .map(|(_, blob, text)| {
                    blob.map(|hash| Value::String(format!("flowz-cas:{hash}")))
                        .or_else(|| text.map(Value::String))
                        .unwrap_or(Value::Null)
                })
                .or_else(|| source.config.get("blobHash").cloned())
                .unwrap_or(Value::Null)
        };
        if input.get("value") != Some(&value) {
            return false;
        }
    }
    actual_edges
        .iter()
        .zip(expected_edges)
        .all(|(edge, expected)| {
            if expected.get("sourceNodeId").and_then(Value::as_str)
                != Some(edge.source_node_id.as_str())
                || expected.get("sourcePortId").and_then(Value::as_str)
                    != Some(edge.source_port_id.as_str())
                || expected.get("targetPortId").and_then(Value::as_str)
                    != Some(edge.target_port_id.as_str())
                || expected.get("order").and_then(Value::as_u64) != Some(edge.order)
            {
                return false;
            }
            let Some(source) = project
                .graph
                .nodes
                .iter()
                .find(|node| node.id == edge.source_node_id)
            else {
                return false;
            };
            let expected_identity = expected
                .get("identity")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let actual_identity = if source.module_id == "core.text-input" {
                source
                    .config
                    .get("text")
                    .and_then(Value::as_str)
                    .map(|text| format!("text-sha256:{:x}", Sha256::digest(text.as_bytes())))
            } else if expected_identity == "config" {
                if expected.get("sourceConfig") != Some(&Value::Object(source.config.clone())) {
                    return false;
                }
                Some("config".into())
            } else {
                persistence
                    .database
                    .active_result_identity(&request.project_id, &source.id)
                    .ok()
                    .flatten()
                    .map(|(result_id, blob, _)| {
                        if expected_identity.starts_with("blob:") {
                            blob.map(|hash| format!("blob:{hash}"))
                                .unwrap_or_else(|| format!("result:{result_id}"))
                        } else {
                            format!("result:{result_id}")
                        }
                    })
            };
            Some(expected_identity) == actual_identity.as_deref()
        })
}

async fn enter_stream_finalizing(
    state: &FalImageState,
    run_id: &str,
    token: &CancellationToken,
) -> Result<(tokio::sync::OwnedMutexGuard<()>, ImageRunManifest), String> {
    let guard = state.transitions.clone().lock_owned().await;
    let mut persisted = state.load(run_id)?;
    if matches!(persisted.phase, Phase::SubmitUnknown) {
        return Err(persisted.error.unwrap_or_else(|| {
            "FLOWZ_SUBMIT_UNKNOWN: Dieser Stream besitzt einen unbekannten Ausgang und wird nicht finalisiert.".into()
        }));
    }
    if token.is_cancelled() {
        return Err(submit_unknown_error(
            state,
            &mut persisted,
            "Der Stream wurde nach vollständigem Empfang parallel abgebrochen; die lokale Finalisierung wurde nicht begonnen.",
        ));
    }
    if !persisted.stream_submit_started || !matches!(persisted.phase, Phase::InProgress) {
        return Err(submit_unknown_error(
            state,
            &mut persisted,
            "Der dauerhafte Streamzustand erlaubt keine sichere Finalisierung.",
        ));
    }
    persisted.phase = Phase::Finalizing;
    persisted.updated_at = Utc::now().to_rfc3339();
    state.save(&persisted)?;
    Ok((guard, persisted))
}

async fn run_existing(
    mut run: ImageRunManifest,
    app: Option<&tauri::AppHandle>,
    state: &FalImageState,
    shared: &FalProviderState,
    persistence: &Persistence,
    token: &CancellationToken,
) -> Result<FalImageResult, String> {
    let key = fal_provider::api_key()?;
    let client = fal_provider::api_client()?;
    let (response, billable) = if run.request.streaming {
        if !matches!(run.phase, Phase::Preparing) {
            return Err("Ein fal.ai-Live-Stream kann nach einer Unterbrechung nicht fortgesetzt werden; FlowZ sendet nicht erneut.".into());
        }
        let app = app.ok_or("Für fal.ai-Live-Status fehlt der App-Kontext.")?;
        stream_submit(app, &run.request, state, shared, persistence, token).await?
    } else if run.request_id.is_some() {
        wait_result(&client, &key, &mut run, state, token).await?
    } else {
        submit(&run.request, state, shared, persistence, token).await?
    };
    // Streaming finalization and cancellation share one transition lock. It is
    // intentionally held through CAS/database finalization: a durable Unknown
    // state can therefore never be overwritten by stale Finalizing/Complete.
    let _stream_transition_guard = if run.request.streaming {
        let (guard, persisted) = enter_stream_finalizing(state, &run.run_id, token).await?;
        run = persisted;
        Some(guard)
    } else {
        run = state.load(&run.run_id)?;
        run.phase = Phase::Finalizing;
        run.updated_at = Utc::now().to_rfc3339();
        state.save(&run)?;
        None
    };
    let result = finalize(&run.request, response, billable, state, persistence, token).await;
    if run.request.streaming {
        let Some(app) = app else { return result };
        match &result {
            Ok(_) => emit_stream_status(app, &run.request, "complete", "node.falStream.complete"),
            Err(_) if !token.is_cancelled() => {
                if let Ok(mut persisted) = state.load(&run.run_id) {
                    persisted.phase = Phase::Failed;
                    persisted.error = Some(
                        "Das gestreamte Ergebnis konnte nicht sicher lokal abgeschlossen werden."
                            .into(),
                    );
                    persisted.updated_at = Utc::now().to_rfc3339();
                    let _ = state.save(&persisted);
                }
                emit_stream_status(app, &run.request, "failed", "node.falStream.failed");
            }
            Err(_) => {}
        }
    }
    result
}

#[tauri::command]
pub async fn fal_image_start(
    request: FalImageRequest,
    app: tauri::AppHandle,
    state: tauri::State<'_, FalImageState>,
    shared: tauri::State<'_, FalProviderState>,
    persistence: tauri::State<'_, Persistence>,
) -> Result<FalImageResult, String> {
    validate(&request)?;
    verify_local_cost_estimate(&request, &persistence)?;
    if state.path(&request.run_id)?.exists() {
        return Err("Diese fal-Bild-Run-ID wurde bereits verwendet.".into());
    }
    let now = Utc::now().to_rfc3339();
    let run = ImageRunManifest {
        run_id: request.run_id.clone(),
        project_id: request.project_id.clone(),
        node_id: request.node_id.clone(),
        model_id: request.model_id.clone(),
        endpoint: request.endpoint.clone(),
        schema_hash: request.schema_hash.clone(),
        phase: Phase::Preparing,
        request_id: None,
        response_url: None,
        stream_submit_started: false,
        created_at: now.clone(),
        updated_at: now,
        error: None,
        result_ids: vec![],
        result_items: vec![],
        result_cost_microunits: None,
        result_cost_provenance: None,
        request,
    };
    state.save(&run)?;
    let token = CancellationToken::new();
    state
        .active
        .lock()
        .map_err(|_| "Fal-Bild-Registry ist nicht verfügbar.".to_string())?
        .insert(run.run_id.clone(), token.clone());
    let run_id = run.run_id.clone();
    let result = run_existing(run, Some(&app), &state, &shared, &persistence, &token).await;
    state.active.lock().ok().map(|mut map| map.remove(&run_id));
    result
}

#[tauri::command]
pub fn fal_image_completed(
    run_id: String,
    state: tauri::State<'_, FalImageState>,
) -> Result<Option<FalImageResult>, String> {
    if !state.path(&run_id)?.exists() {
        return Ok(None);
    }
    let run = state.load(&run_id)?;
    if !matches!(run.phase, Phase::Complete) {
        return Ok(None);
    }
    Ok(Some(FalImageResult {
        run_id: run.run_id,
        model_id: run.model_id,
        endpoint: run.endpoint,
        images: run.result_items,
        cost_microunits: run.result_cost_microunits,
        billable_units: None,
        cost_provenance: match run.result_cost_provenance.as_deref() {
            Some("actual") => "actual",
            Some("estimated") => "estimated",
            _ => "unknown",
        },
        target_current: false,
        contract_error: None,
    }))
}

#[tauri::command]
pub async fn fal_image_resume(
    run_id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, FalImageState>,
    shared: tauri::State<'_, FalProviderState>,
    persistence: tauri::State<'_, Persistence>,
) -> Result<FalImageResult, String> {
    let run = state.load(&run_id)?;
    verify_local_cost_estimate(&run.request, &persistence)?;
    if run.request.streaming {
        return Err("Ein fal.ai-Live-Stream kann nicht wiederaufgenommen werden; FlowZ sendet keinen zweiten kostenpflichtigen Request.".into());
    }
    if matches!(
        run.phase,
        Phase::Complete | Phase::Cancelled | Phase::Failed | Phase::SubmitUnknown
    ) {
        return Err("Dieser fal-Bild-Run kann nicht wiederaufgenommen werden.".into());
    }
    let token = CancellationToken::new();
    state
        .active
        .lock()
        .map_err(|_| "Fal-Bild-Registry ist nicht verfügbar.".to_string())?
        .insert(run_id.clone(), token.clone());
    let result = run_existing(run, Some(&app), &state, &shared, &persistence, &token).await;
    state.active.lock().ok().map(|mut map| map.remove(&run_id));
    result
}

fn pending_image_runs(
    project_id: &str,
    node_id: Option<&str>,
    state: &FalImageState,
) -> Result<Vec<PendingImageRun>, String> {
    let mut items = Vec::new();
    for entry in std::fs::read_dir(&*state.root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.path().extension().and_then(|v| v.to_str()) != Some("json") {
            continue;
        }
        let bytes = std::fs::read(entry.path()).map_err(|e| e.to_string())?;
        if bytes.len() > 512 * 1024 {
            continue;
        }
        let mut run: ImageRunManifest = match serde_json::from_slice(&bytes) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if run.request.streaming
            && (run.stream_submit_started
                || matches!(&run.phase, Phase::InProgress | Phase::Finalizing))
            && !matches!(&run.phase, Phase::SubmitUnknown)
        {
            mark_submit_unknown(
                state,
                &mut run,
                "Die App wurde nach Beginn des Direktstreams beendet; dieser kostenpflichtige Lauf kann nicht sicher fortgesetzt werden.",
            )?;
        }
        if run.project_id == project_id
            && node_id.is_none_or(|id| id == run.node_id)
            && matches!(
                run.phase,
                Phase::Preparing
                    | Phase::Queued
                    | Phase::InProgress
                    | Phase::Finalizing
                    | Phase::SubmitUnknown
            )
        {
            let streaming = run.request.streaming;
            let resumable = !streaming
                && matches!(
                    &run.phase,
                    Phase::Queued | Phase::InProgress | Phase::Finalizing
                );
            let error = run.error.clone().or_else(|| {
                streaming.then(|| {
                    "Dieser unterbrochene Live-Stream ist nicht fortsetzbar. Ein neuer Lauf kann bewusst gestartet werden.".into()
                })
            });
            items.push(PendingImageRun {
                run_id: run.run_id.clone(),
                project_id: run.project_id.clone(),
                node_id: run.node_id.clone(),
                model_id: run.model_id.clone(),
                endpoint: run.endpoint.clone(),
                phase: run.phase,
                created_at: run.created_at,
                error,
                streaming,
                resumable,
            });
        }
    }
    Ok(items)
}

#[tauri::command]
pub fn fal_image_pending(
    project_id: String,
    node_id: Option<String>,
    state: tauri::State<'_, FalImageState>,
) -> Result<Vec<PendingImageRun>, String> {
    pending_image_runs(&project_id, node_id.as_deref(), &state)
}

#[tauri::command]
pub async fn fal_image_cancel(
    run_id: String,
    state: tauri::State<'_, FalImageState>,
) -> Result<bool, String> {
    let token = state
        .active
        .lock()
        .map_err(|_| "Fal-Bild-Registry ist nicht verfügbar.".to_string())?
        .get(&run_id)
        .cloned();
    if let Some(token) = token {
        token.cancel();
        let _transition_guard = state.transitions.lock().await;
        let mut run = state.load(&run_id)?;
        if run.request.streaming {
            if matches!(run.phase, Phase::Complete) {
                return Ok(false);
            }
            if matches!(run.phase, Phase::SubmitUnknown) {
                return Ok(true);
            }
            if run.stream_submit_started {
                mark_submit_unknown(
                    state.inner(),
                    &mut run,
                    "Der Lauf wurde nach Beginn des Direktstreams abgebrochen; fal.ai bestätigt für diesen Stream keinen Provider-Cancel.",
                )?;
                return Ok(true);
            }
        }
        if !run.request.streaming {
            if let Some(request_id) = run.request_id.clone() {
                if let Ok(key) = fal_provider::api_key() {
                    if let Ok(client) = fal_provider::api_client() {
                        let _ = client
                            .put(fal_provider::fal_queue_url(
                                &run.endpoint,
                                Some(&request_id),
                                "/cancel",
                            ))
                            .header(header::AUTHORIZATION, format!("Key {key}"))
                            .send()
                            .await;
                    }
                }
            }
        }
        run.phase = Phase::Cancelled;
        run.updated_at = Utc::now().to_rfc3339();
        state.save(&run)?;
        Ok(true)
    } else {
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(model: &str, endpoint: &str, schema: &str) -> FalImageRequest {
        FalImageRequest {
            run_id: Uuid::new_v4().to_string(),
            project_id: "p".into(),
            node_id: "n".into(),
            model_id: model.into(),
            endpoint: endpoint.into(),
            schema_hash: schema.into(),
            prompt: "Logo".into(),
            references: vec![],
            mask: None,
            config: json!({"size":"1024x1024","outputFormat":"png","variants":1,"quality":"high","background":"transparent"}),
            input_fingerprint: json!({"nodeConfig":{},"connections":[]}),
            cost_estimate: None,
            cost_context: None,
            streaming: false,
            artboard_target: None,
        }
    }
    fn run_manifest(request: FalImageRequest, phase: Phase) -> ImageRunManifest {
        let now = Utc::now().to_rfc3339();
        ImageRunManifest {
            run_id: request.run_id.clone(),
            project_id: request.project_id.clone(),
            node_id: request.node_id.clone(),
            model_id: request.model_id.clone(),
            endpoint: request.endpoint.clone(),
            schema_hash: request.schema_hash.clone(),
            phase,
            request_id: None,
            response_url: None,
            stream_submit_started: false,
            created_at: now.clone(),
            updated_at: now,
            error: None,
            result_ids: vec![],
            result_items: vec![],
            result_cost_microunits: None,
            result_cost_provenance: None,
            request,
        }
    }
    #[test]
    fn manifest_is_shared_and_default_is_fal() {
        let value: Value = serde_json::from_str(MANIFEST).unwrap();
        assert_eq!(value["defaultModel"], "google/nano-banana-2-lite");
        assert_eq!(value["models"].as_array().unwrap().len(), 6);
        assert!(validate_queue_response_url(
            "https://queue.fal.run/fal-ai/flux/requests/abc",
            "fal-ai/flux/schnell",
            "abc"
        )
        .is_ok());
        assert!(validate_queue_response_url(
            "https://queue.fal.run/fal-ai/flux/schnell/requests/abc",
            "fal-ai/flux/schnell",
            "abc"
        )
        .is_err());
    }

    #[test]
    fn sse_parser_handles_fragmented_crlf_comments_and_multiline_data() {
        let mut parser = SseDecoder::default();
        assert!(parser.feed(b": keep-alive\r\nda").unwrap().is_empty());
        assert!(parser
            .feed(b"ta: {\"images\":\r\ndata: []}\r\n\r")
            .unwrap()
            .is_empty());
        let events = parser.feed(b"\n").unwrap();
        assert_eq!(events, vec![json!({"images":[]})]);
        assert!(parser.finish().unwrap().is_empty());
    }

    #[test]
    fn sse_parser_rejects_invalid_json_and_bounded_stream_overflow() {
        let mut invalid = SseDecoder::default();
        assert!(invalid.feed(b"data: nope\n\n").is_err());
        let mut oversized = SseDecoder {
            total_bytes: MAX_SSE_BYTES,
            ..Default::default()
        };
        assert!(oversized.feed(b"x").is_err());
    }

    #[test]
    fn streamed_data_images_are_strictly_typed_bounded_and_decoded() {
        use image::ImageEncoder as _;
        let mut png = Vec::new();
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(&[0, 100, 255, 255], 1, 1, image::ExtendedColorType::Rgba8)
            .unwrap();
        let uri = format!("data:image/png;base64,{}", BASE64.encode(&png));
        let (_, media_type, width, height, _) = decode_data_image(&uri).unwrap();
        assert_eq!((media_type.as_str(), width, height), ("image/png", 1, 1));
        assert!(decode_data_image(&uri.replacen("image/png", "image/jpeg", 1)).is_err());
        assert!(decode_data_image("data:image/svg+xml;base64,PHN2Zz4=").is_err());
        assert!(decode_data_image("data:image/png;base64,%%%=").is_err());
    }

    #[test]
    fn streaming_requires_exact_durable_manifest_endpoint() {
        let mut exact = request(
            "fal-ai/gpt-image-1.5",
            "fal-ai/gpt-image-1.5",
            "gpt-image-1-5-2026-07-11",
        );
        exact.streaming = true;
        assert!(validate(&exact).is_ok());
        exact.endpoint = "fal-ai/gpt-image-1.5/edit".into();
        assert!(validate(&exact).is_err());
        let mut unsupported = request(
            "fal-ai/flux/schnell",
            "fal-ai/flux/schnell",
            "flux-schnell-2026-07-11",
        );
        unsupported.config = json!({"size":"square","outputFormat":"jpeg","variants":1,"steps":4,"guidance":3.5,"acceleration":"none","safetyChecker":false});
        unsupported.streaming = true;
        assert!(validate(&unsupported).is_err());
        assert!(valid_stream_request_id(
            "019f560a-d481-7a32-a550-993967f6bff7"
        ));
        assert!(!valid_stream_request_id("https://queue.fal.run/request"));
    }

    #[test]
    fn persisted_in_progress_stream_is_unknown_and_never_resumable() {
        let root = tempfile::tempdir().unwrap();
        let state = FalImageState::initialize(root.path()).unwrap();
        let mut request = request(
            "fal-ai/gpt-image-1.5",
            "fal-ai/gpt-image-1.5",
            "gpt-image-1-5-2026-07-11",
        );
        request.streaming = true;
        request.project_id = "restart-project".into();
        let mut run = run_manifest(request, Phase::InProgress);
        run.stream_submit_started = true;
        let run_id = run.run_id.clone();
        state.save(&run).unwrap();
        let pending = pending_image_runs("restart-project", None, &state).unwrap();
        assert_eq!(pending.len(), 1);
        assert!(pending[0].streaming);
        assert!(!pending[0].resumable);
        assert!(matches!(pending[0].phase, Phase::SubmitUnknown));
        assert!(matches!(
            state.load(&run_id).unwrap().phase,
            Phase::SubmitUnknown
        ));
    }

    #[test]
    fn submit_unknown_reports_when_its_protective_manifest_cannot_be_saved() {
        let root = tempfile::tempdir().unwrap();
        let state = FalImageState::initialize(root.path()).unwrap();
        let request = request(
            "fal-ai/gpt-image-1.5",
            "fal-ai/gpt-image-1.5",
            "gpt-image-1-5-2026-07-11",
        );
        let mut run = run_manifest(request, Phase::Preparing);
        std::fs::remove_dir_all(&*state.root).unwrap();
        std::fs::write(&*state.root, b"not a directory").unwrap();
        let error = mark_submit_unknown(&state, &mut run, "transport uncertain").unwrap_err();
        assert!(error.contains("Schutzstatus nicht dauerhaft gespeichert"));
        assert!(error.contains("transport uncertain"));
    }

    #[tokio::test]
    async fn cancel_after_server_accept_before_headers_is_durably_unknown() {
        use tokio::io::AsyncReadExt as _;
        let root = tempfile::tempdir().unwrap();
        let state = FalImageState::initialize(root.path()).unwrap();
        let mut request = request(
            "fal-ai/gpt-image-1.5",
            "fal-ai/gpt-image-1.5",
            "gpt-image-1-5-2026-07-11",
        );
        request.streaming = true;
        let mut run = run_manifest(request, Phase::Preparing);
        let run_id = run.run_id.clone();
        state.save(&run).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (accepted_tx, accepted_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0_u8; 4096];
            let read = socket.read(&mut buffer).await.unwrap();
            assert!(read > 0);
            let _ = accepted_tx.send(());
            tokio::time::sleep(Duration::from_secs(5)).await;
        });
        let token = CancellationToken::new();
        let cancel = token.clone();
        tokio::spawn(async move {
            accepted_rx.await.unwrap();
            cancel.cancel();
        });
        let client = fal_provider::api_client().unwrap();
        let error = open_stream_response(
            &client,
            "test-key",
            &format!("http://{address}/stream"),
            &json!({"prompt":"test"}),
            &token,
            &state,
            &mut run,
        )
        .await
        .unwrap_err();
        server.abort();
        assert!(error.contains("Streaming-Ausgang ist unbekannt"));
        let persisted = state.load(&run_id).unwrap();
        assert!(persisted.stream_submit_started);
        assert!(matches!(persisted.phase, Phase::SubmitUnknown));
    }

    #[tokio::test]
    async fn durable_submit_unknown_wins_the_pre_finalizing_race() {
        let root = tempfile::tempdir().unwrap();
        let state = FalImageState::initialize(root.path()).unwrap();
        let mut request = request(
            "fal-ai/gpt-image-1.5",
            "fal-ai/gpt-image-1.5",
            "gpt-image-1-5-2026-07-11",
        );
        request.streaming = true;
        let mut run = run_manifest(request, Phase::InProgress);
        run.stream_submit_started = true;
        let run_id = run.run_id.clone();
        state.save(&run).unwrap();

        // Hold the exact transition lock so the finalizer is deterministically
        // queued while the competing cancel path persists SubmitUnknown.
        let transition = state.transitions.lock().await;
        let finalizer_state = state.clone();
        let finalizer_run_id = run_id.clone();
        let finalizer = tokio::spawn(async move {
            enter_stream_finalizing(
                &finalizer_state,
                &finalizer_run_id,
                &CancellationToken::new(),
            )
            .await
            .map(|_| ())
        });
        tokio::task::yield_now().await;
        let mut cancelled = state.load(&run_id).unwrap();
        mark_submit_unknown(
            &state,
            &mut cancelled,
            "Deterministisch parallel abgebrochen.",
        )
        .unwrap();
        drop(transition);

        let error = finalizer.await.unwrap().unwrap_err();
        assert!(error.starts_with("FLOWZ_SUBMIT_UNKNOWN:"));
        assert!(matches!(
            state.load(&run_id).unwrap().phase,
            Phase::SubmitUnknown
        ));
    }
    #[test]
    fn transparent_contract_is_exact() {
        let good = request(
            "fal-ai/gpt-image-1.5",
            "fal-ai/gpt-image-1.5",
            "gpt-image-1-5-2026-07-11",
        );
        assert!(validate(&good).is_ok());
        let mut bad = good.clone();
        bad.model_id = "openai/gpt-image-2".into();
        bad.endpoint = "openai/gpt-image-2".into();
        bad.schema_hash = "gpt-image-2-2026-07-11".into();
        assert!(validate(&bad).is_err());
    }
    #[test]
    fn lite_rejects_references() {
        let mut request = request(
            "google/nano-banana-2-lite",
            "google/nano-banana-2-lite",
            "nb2-lite-t2i-2026-07-11",
        );
        request.config =
            json!({"aspectRatio":"1:1","outputFormat":"png","variants":1,"safetyTolerance":"4"});
        request.references.push("data:image/png;base64,AA==".into());
        assert!(validate(&request).is_err());
    }

    #[test]
    fn redux_rejects_guidance_and_ranges_are_enforced() {
        let mut request = request(
            "fal-ai/flux/schnell",
            "fal-ai/flux/schnell/redux",
            "flux-schnell-2026-07-11",
        );
        request.prompt.clear();
        request.references.push("flowz-cas:abc".into());
        request.config = json!({"size":"square","outputFormat":"jpeg","variants":1,"steps":4,"guidance":3.5,"acceleration":"none","safetyChecker":true});
        assert!(validate(&request).unwrap_err().contains("guidance"));
        request.config = json!({"size":"square","outputFormat":"jpeg","variants":1,"steps":13,"acceleration":"none","safetyChecker":true});
        assert!(validate(&request).unwrap_err().contains("Schrittzahl"));
    }
    #[test]
    fn logo_target_accepts_exact_contract_and_rejects_module_change() {
        use crate::persistence::{
            CanvasPosition, CreateProjectRequest, GraphEdge, GraphNode, SaveProjectRequest,
            UpdatePolicy,
        };
        let root = tempfile::tempdir().unwrap();
        let persistence = Persistence::initialize(root.path()).unwrap();
        let created = persistence
            .projects
            .create(CreateProjectRequest {
                name: "Logo".into(),
            })
            .unwrap();
        let expected_updated_at = created.project.updated_at;
        let mut project = created.project;
        let config = serde_json::from_value::<serde_json::Map<String, Value>>(
            json!({"model":"fal-ai/gpt-image-1.5","background":"transparent"}),
        )
        .unwrap();
        project.graph.nodes.push(GraphNode {
            id: "logo".into(),
            module_id: "brand.logo-design".into(),
            module_version: 1,
            position: CanvasPosition { x: 0.0, y: 0.0 },
            label: None,
            label_id: None,
            config: config.clone(),
            update_policy: UpdatePolicy::Manual,
        });
        project.graph.nodes.push(GraphNode {
            id: "source".into(),
            module_id: "core.text-input".into(),
            module_version: 1,
            position: CanvasPosition { x: 0.0, y: 0.0 },
            label: None,
            label_id: None,
            config: serde_json::from_value(json!({"text":"Brief"})).unwrap(),
            update_policy: UpdatePolicy::Manual,
        });
        project.graph.edges.push(GraphEdge {
            id: "edge".into(),
            source_node_id: "source".into(),
            source_port_id: "text".into(),
            target_node_id: "logo".into(),
            target_port_id: "brief".into(),
            order: 0,
        });
        persistence
            .projects
            .save(SaveProjectRequest {
                project: project.clone(),
                expected_updated_at,
                expected_revision: created.revision,
            })
            .unwrap();
        let mut request = request(
            "fal-ai/gpt-image-1.5",
            "fal-ai/gpt-image-1.5",
            "gpt-image-1-5-2026-07-11",
        );
        request.project_id = project.id.clone();
        request.node_id = "logo".into();
        let contract = json!({"modelId":request.model_id,"endpoint":request.endpoint,"schemaHash":request.schema_hash,"prompt":request.prompt,"references":request.references,"mask":request.mask,"config":request.config,"streaming":request.streaming});
        let execution=json!({"moduleId":"brand.logo-design","moduleVersion":1,"config":config,"inputs":[{"sourceNodeId":"source","sourcePortId":"text","targetPortId":"brief","order":0,"value":"Brief"}]}).to_string();
        let identity = format!("text-sha256:{:x}", Sha256::digest(b"Brief"));
        request.input_fingerprint = json!({"moduleId":"brand.logo-design","moduleVersion":1,"nodeConfig":config,"connections":[{"sourceNodeId":"source","sourcePortId":"text","targetPortId":"brief","order":0,"identity":identity}],"executionFingerprint":execution,"requestContract":contract});
        assert!(target_current(&request, &persistence));
        let mut wrong_request = request.clone();
        wrong_request.endpoint = "fal-ai/gpt-image-1.5/edit".into();
        assert!(!target_current(&wrong_request, &persistence));
        let current = persistence.projects.open(&project.id).unwrap();
        let current_updated_at = current.project.updated_at;
        let mut changed = current.project;
        changed.graph.nodes[0]
            .config
            .insert("background".into(), Value::String("opaque".into()));
        let changed = persistence
            .projects
            .save(SaveProjectRequest {
                project: changed,
                expected_updated_at: current_updated_at,
                expected_revision: current.revision,
            })
            .unwrap();
        assert!(!target_current(&request, &persistence));
        let mut source_changed = changed.project;
        source_changed.graph.nodes[0].config = config.clone();
        source_changed.graph.nodes[1]
            .config
            .insert("text".into(), Value::String("Geändert".into()));
        let source_changed = persistence
            .projects
            .save(SaveProjectRequest {
                expected_updated_at: source_changed.updated_at,
                expected_revision: changed.revision,
                project: source_changed,
            })
            .unwrap();
        assert!(!target_current(&request, &persistence));
        let mut switched = source_changed.project;
        switched.graph.nodes[1]
            .config
            .insert("text".into(), Value::String("Brief".into()));
        switched.graph.nodes[0].module_id = "ai.image-generation".into();
        let switched = persistence
            .projects
            .save(SaveProjectRequest {
                expected_updated_at: switched.updated_at,
                expected_revision: source_changed.revision,
                project: switched,
            })
            .unwrap();
        assert!(!target_current(&request, &persistence));
        let mut deleted = switched.project;
        deleted.graph.nodes.retain(|node| node.id != "logo");
        deleted.graph.edges.clear();
        persistence
            .projects
            .save(SaveProjectRequest {
                expected_updated_at: deleted.updated_at,
                expected_revision: switched.revision,
                project: deleted,
            })
            .unwrap();
        assert!(!target_current(&request, &persistence));
    }

    #[test]
    fn seedream_reference_surcharge_scales_with_variants() {
        let mut request = request(
            "bytedance/seedream/v5/pro/text-to-image",
            "bytedance/seedream/v5/pro/edit",
            "seedream-v5-pro-2026-07-11",
        );
        request.references = vec!["a".into(), "b".into(), "c".into()];
        request.config =
            json!({"size":"square","outputFormat":"png","variants":2,"safetyTolerance":"4"});
        assert_eq!(
            estimated_cost(
                &request,
                &manifest_model(&request.model_id).unwrap(),
                &[(1024, 1024), (1024, 1024)]
            ),
            Some(153_000)
        );
    }

    #[test]
    fn cost_snapshot_is_endpoint_bound_and_redux_uses_its_own_rate() {
        let mut text = request(
            "fal-ai/flux/schnell",
            "fal-ai/flux/schnell",
            "flux-schnell-2026-07-11",
        );
        text.config = json!({"size":"square_hd","outputFormat":"png","variants":1,"steps":4,"guidance":3.5,"acceleration":"none","safetyChecker":false});
        text.cost_estimate = Some(json!({
            "schemaVersion":1,
            "endpoint":text.endpoint,
            "adapterSchemaHash":text.schema_hash,
            "currency":"USD",
            "source":"https://fal.ai/models/fal-ai/flux/schnell",
            "amountMicrounits":6000
        }));
        assert!(validate(&text).is_ok());
        text.cost_estimate.as_mut().unwrap()["endpoint"] = json!("fal-ai/flux/schnell/redux");
        assert!(validate(&text).is_err());

        let redux = request(
            "fal-ai/flux/schnell",
            "fal-ai/flux/schnell/redux",
            "flux-schnell-2026-07-11",
        );
        assert_eq!(
            estimated_cost(
                &redux,
                &manifest_model(&redux.model_id).unwrap(),
                &[(1024, 1024)]
            ),
            Some(50_000)
        );
    }

    /// Explicit, paid smoke test. Run manually once with the user's Keychain key;
    /// it is ignored in normal CI and never launches the native app.
    #[tokio::test]
    #[ignore]
    async fn live_flux_schnell_downloads_decodes_and_persists_to_cas() {
        let temporary = tempfile::tempdir().unwrap();
        let persistence = Persistence::initialize(temporary.path()).unwrap();
        let project = persistence
            .projects
            .create(crate::persistence::CreateProjectRequest {
                name: "fal live smoke".into(),
            })
            .unwrap();
        persistence
            .database
            .upsert_project(&project.project)
            .unwrap();
        let state = FalImageState::initialize(temporary.path()).unwrap();
        let shared = FalProviderState::initialize(temporary.path()).unwrap();
        let request = FalImageRequest {
            run_id: Uuid::new_v4().to_string(),
            project_id: project.project.id,
            node_id: "live-smoke-node".into(),
            model_id: "fal-ai/flux/schnell".into(),
            endpoint: "fal-ai/flux/schnell".into(),
            schema_hash: "flux-schnell-2026-07-11".into(),
            prompt: "A minimal red circle centered on a plain white background, flat vector style"
                .into(),
            references: vec![],
            mask: None,
            config: json!({"size":"square","outputFormat":"jpeg","variants":1,"seed":42,"steps":1,"guidance":3.5,"acceleration":"none","safetyChecker":true}),
            input_fingerprint: json!({"nodeConfig":{},"connections":[]}),
            cost_estimate: None,
            cost_context: None,
            streaming: false,
            artboard_target: None,
        };
        let now = Utc::now().to_rfc3339();
        let run = ImageRunManifest {
            run_id: request.run_id.clone(),
            project_id: request.project_id.clone(),
            node_id: request.node_id.clone(),
            model_id: request.model_id.clone(),
            endpoint: request.endpoint.clone(),
            schema_hash: request.schema_hash.clone(),
            phase: Phase::Preparing,
            request_id: None,
            response_url: None,
            stream_submit_started: false,
            created_at: now.clone(),
            updated_at: now,
            error: None,
            result_ids: vec![],
            result_items: vec![],
            result_cost_microunits: None,
            result_cost_provenance: None,
            request,
        };
        state.save(&run).unwrap();
        let result = run_existing(
            run,
            None,
            &state,
            &shared,
            &persistence,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(result.images.len(), 1);
        assert!(result.cost_microunits.is_some_and(|cost| cost > 0));
        let blob = persistence
            .blobs
            .metadata(&result.images[0].blob_hash)
            .unwrap();
        assert!(blob.media_type.starts_with("image/"));
        assert!(result.images[0].width > 0 && result.images[0].height > 0);
    }
}
