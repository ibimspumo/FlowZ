use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::Utc;
use image::{GenericImageView, ImageEncoder};
use keyring::Entry;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tokio_util::sync::CancellationToken;

mod artboard_agent;
mod artboard_composite;
mod brand;
mod export;
mod fal_image;
mod fal_image_tools;
mod fal_provider;
mod image_transform;
mod image_trim;
mod persistence;
mod recording;
mod transcription;
mod web_context;
use persistence::{
    decimal_to_microunits, inspect_media, snapshot_media, ApplyArtboardOperationBatch,
    ArtboardBranch, ArtboardRevision, ArtboardWorkspaceRecord, BlobMetadata, CatalogCreateRequest,
    CatalogDeleteRequest, CatalogDeleteResult, CatalogDuplicateRequest, CatalogRecord,
    CatalogRenameRequest, CostBreakdown, CreateArtboardBranch, CreateArtboardWorkspace,
    CreateProjectRequest, EmergencyTextResult, FalEmpiricalCostEstimate, FalEmpiricalCostQuery,
    ImportBlobRequest, ImportedMedia, LibraryAssetPage, LibraryAssetSummary, LibraryResultPage,
    LibraryUsage, MoveArtboardHead, Persistence, ProjectSaveResult, ProjectSummary,
    RegisterArtboardInputSnapshot, SaveProjectRequest, StorageBreakdown, StoredResult,
};
use tauri::http::{header, HeaderValue, Method, Request, Response, StatusCode};
use tauri::ipc::{InvokeBody, Request as IpcRequest};
use uuid::Uuid;

const SERVICE: &str = "dev.flowz.app";
const ACCOUNT: &str = "openrouter-api-key";
static ASSET_THUMBNAIL_BACKFILL_LOCK: Mutex<()> = Mutex::new(());

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())
}

fn api_key() -> Result<String, String> {
    entry()?
        .get_password()
        .map_err(|_| "Kein OpenRouter-Key gespeichert.".into())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AiResult {
    content: Option<String>,
    images: Vec<String>,
    cost_microunits: Option<i64>,
    generation_id: Option<String>,
}

fn provider_cost_microunits(data: &Value) -> Option<i64> {
    let value = data.pointer("/usage/cost")?;
    let decimal = match value {
        Value::Number(number) => number.to_string(),
        Value::String(text) => text.clone(),
        _ => return None,
    };
    decimal_to_microunits(&decimal)
        .or_else(|_| rounded_decimal_to_microunits(&decimal))
        .ok()
}

fn rounded_decimal_to_microunits(value: &str) -> Result<i64, String> {
    let value = value.trim();
    let negative = value.starts_with('-');
    let unsigned = value.trim_start_matches(['-', '+']);
    let (mantissa, exponent) = unsigned
        .split_once(['e', 'E'])
        .map_or((unsigned, 0), |(mantissa, exponent)| {
            (mantissa, exponent.parse::<i32>().unwrap_or(i32::MIN))
        });
    if exponent == i32::MIN {
        return Err("Ungültiger Provider-Kostenbetrag.".into());
    }
    let mut parts = mantissa.split('.');
    let whole = parts.next().unwrap_or_default();
    let fraction = parts.next().unwrap_or_default();
    if whole.is_empty()
        || parts.next().is_some()
        || !whole.chars().all(|c| c.is_ascii_digit())
        || !fraction.chars().all(|c| c.is_ascii_digit())
    {
        return Err("Ungültiger Provider-Kostenbetrag.".into());
    }
    let digits: i128 = format!("{whole}{fraction}")
        .parse()
        .map_err(|_| "Provider-Kostenbetrag ist zu groß.".to_string())?;
    let decimal_places = fraction.len() as i32 - exponent;
    let micros = if decimal_places <= 6 {
        digits
            .checked_mul(
                10_i128
                    .checked_pow((6 - decimal_places) as u32)
                    .ok_or("Provider-Kostenbetrag ist zu groß.")?,
            )
            .ok_or("Provider-Kostenbetrag ist zu groß.")?
    } else {
        let divisor = 10_i128
            .checked_pow((decimal_places - 6) as u32)
            .ok_or("Provider-Kostenbetrag ist zu klein oder zu groß.")?;
        let quotient = digits / divisor;
        let remainder = digits % divisor;
        quotient + i128::from(remainder.saturating_mul(2) >= divisor)
    };
    let signed = if negative { -micros } else { micros };
    i64::try_from(signed).map_err(|_| "Provider-Kostenbetrag ist zu groß.".into())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatRequest {
    model: String,
    prompt: String,
    images: Vec<String>,
    output_mode: Option<String>,
    schema_name: Option<String>,
    schema: Option<Value>,
    system_instruction: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoreResultRequest {
    run_id: Option<String>,
    project_id: String,
    node_id: String,
    model: Option<String>,
    kind: String,
    text: Option<String>,
    data_url: Option<String>,
    original_name: Option<String>,
    cost_microunits: Option<i64>,
    prompt: Option<String>,
    parameters: Option<Value>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PaidBrandResultRequest {
    run_id: String,
    project_id: String,
    node_id: String,
    model: String,
    kind: String,
    text: String,
    cost_microunits: Option<i64>,
    parameters: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PaidBrandResult {
    result_id: String,
    persisted: bool,
    outboxed: bool,
    target_current: bool,
    persistence_error: Option<String>,
}

fn paid_brand_target_current(
    request: &PaidBrandResultRequest,
    persistence: &Persistence,
    expected_module: &str,
) -> bool {
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
        .find(|node| node.id == request.node_id && node.module_id == expected_module)
    else {
        return false;
    };
    if node.config.get("model").and_then(Value::as_str) != Some(request.model.as_str()) {
        return false;
    }
    let Some(parameters) = request.parameters.as_object() else {
        return false;
    };
    let Some(snapshot) = parameters
        .get("inputFingerprint")
        .and_then(Value::as_object)
    else {
        return false;
    };
    if parameters.get("executionFingerprint") != snapshot.get("executionFingerprint")
        || snapshot.get("nodeConfig") != Some(&Value::Object(node.config.clone()))
    {
        return false;
    }
    let Some(fingerprint) = parameters
        .get("executionFingerprint")
        .and_then(Value::as_str)
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
    else {
        return false;
    };
    if fingerprint.get("moduleId").and_then(Value::as_str) != Some(expected_module)
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
            let actual = if source.module_id == "core.text-input" {
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
            Some(expected_identity) == actual.as_deref()
        })
}

#[tauri::command]
fn store_paid_brand_result(
    mut request: PaidBrandResultRequest,
    persistence: tauri::State<'_, Persistence>,
) -> Result<PaidBrandResult, String> {
    Uuid::parse_str(&request.run_id).map_err(|_| "Ungültige Brand-Lauf-ID.".to_string())?;
    if !request.kind.starts_with("brand-")
        || request.text.is_empty()
        || request.text.len() > 2 * 1024 * 1024
        || request.cost_microunits.is_some_and(|cost| cost < 0)
    {
        return Err("Ungültiges bezahltes Brand-Ergebnis.".into());
    }
    let expected_module = match request.kind.as_str() {
        "brand-audienceAnalysis" => "brand.audience",
        "brand-brandNames" => "brand.names",
        "brand-colorPalette" => "brand.color-palette",
        "brand-fontPairing" => "brand.font-pairing",
        _ => return Err("Unbekannter bezahlter Brand-Ergebnistyp.".into()),
    };
    let target_current = paid_brand_target_current(&request, &persistence, expected_module);
    request.parameters["orphaned"] = Value::Bool(!target_current);
    request.parameters["expectedModule"] = Value::String(expected_module.into());
    let result_id = Uuid::new_v4().to_string();
    let created_at = Utc::now().to_rfc3339();
    match persistence.database.record_provider_text_result_atomic(
        &result_id,
        &request.run_id,
        &request.project_id,
        &request.node_id,
        &request.model,
        &request.kind,
        &request.text,
        Some(&request.parameters),
        request.cost_microunits,
        &created_at,
        target_current,
    ) {
        Ok(_) => Ok(PaidBrandResult {
            result_id,
            persisted: true,
            outboxed: false,
            target_current,
            persistence_error: None,
        }),
        Err(database_error) => {
            let emergency = EmergencyTextResult {
                version: 1,
                result_id: result_id.clone(),
                run_id: request.run_id,
                project_id: request.project_id,
                node_id: request.node_id,
                model: request.model,
                kind: request.kind,
                text: request.text,
                parameters: request.parameters,
                cost_microunits: request.cost_microunits,
                created_at,
            };
            match persistence.emergency_outbox.store(&emergency){Ok(())=>Ok(PaidBrandResult{result_id,persisted:false,outboxed:true,target_current:false,persistence_error:Some(format!("SQLite-Ablage fehlgeschlagen ({database_error}); Ergebnis und Kosten wurden fsync-sicher in Nicht zugeordnet gesichert."))}),Err(outbox_error)=>Err(format!("Brand-Ergebnis konnte weder in SQLite ({database_error}) noch im Notfall-Outbox ({outbox_error}) gesichert werden."))}
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryResult {
    #[serde(flatten)]
    stored: StoredResult,
    data_url: Option<String>,
    hydration_error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LibraryResultQuery {
    project_id: Option<String>,
    node_id: Option<String>,
    kind: Option<String>,
    #[serde(default)]
    query: String,
    #[serde(default)]
    page: i64,
    #[serde(default = "default_library_result_page_size")]
    page_size: i64,
}

fn default_library_result_page_size() -> i64 {
    40
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryResultContent {
    result_id: String,
    text_value: Option<String>,
    blob_hash: Option<String>,
    media_type: Option<String>,
    media_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveLibraryAssetRequest {
    name: String,
    kind: String,
    text: Option<String>,
    data_url: Option<String>,
    original_name: Option<String>,
    source_project_id: Option<String>,
    source_node_id: Option<String>,
    source_result_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryAssetPayload {
    #[serde(flatten)]
    summary: LibraryAssetSummary,
    text: Option<String>,
    data_url: Option<String>,
    blob_hash: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryAssetReference {
    version_id: String,
    blob_hash: Option<String>,
    media_type: Option<String>,
}

struct TranscriptionRunEntry {
    token: CancellationToken,
    started: bool,
    created_at: Instant,
}
#[derive(Clone, Default)]
struct TranscriptionRunRegistry(Arc<Mutex<HashMap<String, TranscriptionRunEntry>>>);
impl TranscriptionRunRegistry {
    fn start(&self, run_id: &str) -> Result<CancellationToken, String> {
        Uuid::parse_str(run_id).map_err(|_| "Ungültige Run-ID.".to_string())?;
        let mut runs = self
            .0
            .lock()
            .map_err(|_| "Transkriptions-Registry ist nicht verfügbar.".to_string())?;
        runs.retain(|_, entry| {
            entry.started || entry.created_at.elapsed() < Duration::from_secs(300)
        });
        if let Some(entry) = runs.get_mut(run_id) {
            if entry.started {
                return Err("Diese Transkriptions-Run-ID wird bereits ausgeführt.".into());
            }
            entry.started = true;
            return Ok(entry.token.clone());
        }
        let token = CancellationToken::new();
        runs.insert(
            run_id.into(),
            TranscriptionRunEntry {
                token: token.clone(),
                started: true,
                created_at: Instant::now(),
            },
        );
        Ok(token)
    }
    fn cancel(&self, run_id: &str) -> bool {
        let Ok(mut runs) = self.0.lock() else {
            return false;
        };
        runs.retain(|_, entry| {
            entry.started || entry.created_at.elapsed() < Duration::from_secs(300)
        });
        if runs.len() >= 256 && !runs.contains_key(run_id) {
            return false;
        }
        let entry = runs
            .entry(run_id.into())
            .or_insert_with(|| TranscriptionRunEntry {
                token: CancellationToken::new(),
                started: false,
                created_at: Instant::now(),
            });
        entry.token.cancel();
        true
    }
    fn remove(&self, run_id: &str) {
        if let Ok(mut runs) = self.0.lock() {
            runs.remove(run_id);
        }
    }
}
struct TranscriptionRunCleanup {
    registry: TranscriptionRunRegistry,
    run_id: String,
}
impl Drop for TranscriptionRunCleanup {
    fn drop(&mut self) {
        self.registry.remove(&self.run_id);
    }
}

struct DropGrant {
    path: PathBuf,
    webview_label: String,
    created_at: Instant,
}
#[derive(Clone, Default)]
struct DropGrantRegistry(Arc<Mutex<HashMap<String, DropGrant>>>);
#[derive(Clone)]
struct MediaStage {
    imported: ImportedMedia,
    project_id: String,
    node_id: String,
    kind: String,
    project_revision: u64,
    target_grant: Option<String>,
    origin: String,
    finalizing: bool,
    created_at: Instant,
    persisted_created_at: chrono::DateTime<Utc>,
}
#[derive(Clone)]
struct MediaStageRegistry {
    items: Arc<Mutex<HashMap<String, MediaStage>>>,
    root: Option<Arc<PathBuf>>,
}
impl Default for MediaStageRegistry {
    fn default() -> Self {
        Self {
            items: Arc::new(Mutex::new(HashMap::new())),
            root: None,
        }
    }
}

impl MediaStageRegistry {
    fn initialize(app_data_dir: &Path, persistence: &Persistence) -> Result<Self, String> {
        let root = app_data_dir.join("media-stages");
        std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
        let registry = Self {
            items: Arc::new(Mutex::new(HashMap::new())),
            root: Some(Arc::new(root.clone())),
        };
        for entry in std::fs::read_dir(&root).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let loaded = std::fs::metadata(&path)
                .ok()
                .filter(|metadata| metadata.is_file() && metadata.len() <= 512 * 1024)
                .and_then(|_| std::fs::read(&path).ok())
                .and_then(|bytes| serde_json::from_slice::<PersistedMediaStage>(&bytes).ok())
                .and_then(|manifest| registry.restore_manifest(manifest, persistence).ok());
            if let Some((id, stage)) = loaded {
                registry
                    .items
                    .lock()
                    .map_err(|_| "Import-Staging ist nicht verfügbar.".to_string())?
                    .insert(id, stage);
            } else {
                let _ = std::fs::remove_file(path);
            }
        }
        // A crash can leave the fsynced temporary file before its atomic rename.
        // Recording stages are not provider-paid results, so incomplete commits are
        // discarded and their otherwise-unreferenced CAS objects are reclaimed now.
        for entry in std::fs::read_dir(&root).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with('.') || !name.ends_with(".tmp") {
                continue;
            }
            let hashes = std::fs::metadata(&path)
                .ok()
                .filter(|metadata| metadata.is_file() && metadata.len() <= 512 * 1024)
                .and_then(|_| std::fs::read(&path).ok())
                .and_then(|bytes| serde_json::from_slice::<PersistedMediaStage>(&bytes).ok())
                .map(|manifest| [Some(manifest.hash), manifest.poster_hash])
                .unwrap_or([None, None]);
            let _ = std::fs::remove_file(&path);
            for hash in hashes.into_iter().flatten() {
                let in_recovered_stage = registry.items.lock().ok().is_some_and(|items| {
                    items.values().any(|stage| {
                        stage.imported.hash == hash
                            || stage.imported.poster_hash.as_deref() == Some(hash.as_str())
                    })
                });
                if !in_recovered_stage && !persistence.database.contains_blob(&hash).unwrap_or(true)
                {
                    let _ = persistence.blobs.remove_untracked(&hash);
                }
            }
        }
        persistence::sync_directory(&root)?;
        prune_expired_media_stages(&registry, persistence);
        Ok(registry)
    }

    fn restore_manifest(
        &self,
        manifest: PersistedMediaStage,
        persistence: &Persistence,
    ) -> Result<(String, MediaStage), String> {
        if manifest.version != 1
            || Uuid::parse_str(&manifest.stage_id).is_err()
            || manifest.project_id.is_empty()
            || manifest.node_id.is_empty()
            || manifest.kind != "audio"
            || manifest.origin != "recording"
            || manifest.target_grant.as_deref().is_none_or(str::is_empty)
        {
            return Err("Ungültiger gespeicherter Aufnahmestand.".into());
        }
        let age = Utc::now().signed_duration_since(manifest.created_at);
        if age.num_seconds() < -300 {
            return Err("Aufnahmestand liegt unzulässig in der Zukunft.".into());
        }
        let blob = persistence.blobs.metadata(&manifest.hash)?;
        if blob.size_bytes != manifest.size_bytes || blob.media_type != manifest.media_type {
            return Err("Gespeicherter Aufnahmestand passt nicht zum Medienobjekt.".into());
        }
        if let Some(hash) = manifest.poster_hash.as_deref() {
            persistence.blobs.metadata(hash)?;
        }
        let elapsed = Duration::from_secs(age.num_seconds().max(0) as u64);
        let created_at = Instant::now()
            .checked_sub(elapsed)
            .unwrap_or_else(Instant::now);
        let id = manifest.stage_id.clone();
        Ok((
            id.clone(),
            MediaStage {
                imported: ImportedMedia {
                    blob,
                    hash: manifest.hash,
                    size_bytes: manifest.size_bytes,
                    media_type: manifest.media_type,
                    original_name: manifest.original_name,
                    created_at: manifest.created_at,
                    metadata: manifest.media_metadata,
                    poster_hash: manifest.poster_hash,
                    start_frame_hash: None,
                    end_frame_hash: None,
                    result_id: None,
                    asset_id: None,
                    stage_id: Some(id),
                },
                project_id: manifest.project_id,
                node_id: manifest.node_id,
                kind: manifest.kind,
                project_revision: manifest.project_revision,
                target_grant: manifest.target_grant,
                origin: manifest.origin,
                finalizing: false,
                created_at,
                persisted_created_at: manifest.created_at,
            },
        ))
    }

    fn persist(&self, stage_id: &str, stage: &MediaStage) -> Result<(), String> {
        if stage.origin != "recording" {
            return Ok(());
        }
        let Some(root) = self.root.as_deref() else {
            return Ok(());
        };
        let manifest = PersistedMediaStage {
            version: 1,
            stage_id: stage_id.into(),
            project_id: stage.project_id.clone(),
            node_id: stage.node_id.clone(),
            kind: stage.kind.clone(),
            project_revision: stage.project_revision,
            target_grant: stage.target_grant.clone(),
            origin: stage.origin.clone(),
            created_at: stage.persisted_created_at,
            hash: stage.imported.hash.clone(),
            poster_hash: stage.imported.poster_hash.clone(),
            size_bytes: stage.imported.size_bytes,
            media_type: stage.imported.media_type.clone(),
            original_name: stage.imported.original_name.clone(),
            media_metadata: stage.imported.metadata.clone(),
        };
        let bytes = serde_json::to_vec(&manifest).map_err(|error| error.to_string())?;
        let destination = root.join(format!("{stage_id}.json"));
        let temporary = root.join(format!(".{stage_id}.tmp"));
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        let operation = (|| {
            file.write_all(&bytes).map_err(|error| error.to_string())?;
            file.sync_all().map_err(|error| error.to_string())?;
            std::fs::rename(&temporary, &destination).map_err(|error| error.to_string())?;
            persistence::sync_directory(root)
        })();
        if operation.is_err() {
            let _ = std::fs::remove_file(temporary);
        }
        operation
    }

    fn delete_manifest(&self, stage_id: &str) {
        if let Some(root) = self.root.as_deref() {
            let _ = std::fs::remove_file(root.join(format!("{stage_id}.json")));
            let _ = persistence::sync_directory(root);
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedMediaStage {
    version: u8,
    stage_id: String,
    project_id: String,
    node_id: String,
    kind: String,
    project_revision: u64,
    target_grant: Option<String>,
    origin: String,
    created_at: chrono::DateTime<Utc>,
    hash: String,
    poster_hash: Option<String>,
    size_bytes: u64,
    media_type: String,
    original_name: Option<String>,
    media_metadata: persistence::MediaMetadata,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingMediaStage {
    stage_id: String,
    project_id: String,
    node_id: String,
    kind: String,
    origin: String,
    original_name: Option<String>,
    created_at: chrono::DateTime<Utc>,
}
#[derive(Clone, Default)]
struct MediaCancelRegistry(Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>);

fn register_media_cancellation(
    registry: &MediaCancelRegistry,
    operation_id: &str,
) -> Result<Arc<AtomicBool>, String> {
    Uuid::parse_str(operation_id).map_err(|_| "Ungültige Import-Vorgangs-ID.".to_string())?;
    let mut items = registry
        .0
        .lock()
        .map_err(|_| "Import-Abbruch ist nicht verfügbar.".to_string())?;
    if items.contains_key(operation_id) {
        return Err("Diese Import-Vorgangs-ID wird bereits verwendet.".into());
    }
    let flag = Arc::new(AtomicBool::new(false));
    items.insert(operation_id.into(), flag.clone());
    Ok(flag)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaDropEvent {
    token: Option<String>,
    path_count: usize,
    x: f64,
    y: f64,
}

fn decode_image_data_url(data_url: &str) -> Result<(String, Vec<u8>), String> {
    const MAX_ENCODED: usize = 86 * 1024 * 1024;
    if data_url.len() > MAX_ENCODED {
        return Err("Das Bild ist für die lokale Bibliothek zu groß.".into());
    }
    let (header, encoded) = data_url
        .split_once(',')
        .ok_or_else(|| "Ungültige Bild-Daten-URL.".to_string())?;
    let media_type = header
        .strip_prefix("data:")
        .and_then(|value| value.strip_suffix(";base64"))
        .ok_or_else(|| "Nur Base64-Bilddaten werden akzeptiert.".to_string())?;
    if !matches!(
        media_type,
        "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "image/svg+xml"
    ) {
        return Err("Nicht unterstütztes Bildformat.".into());
    }
    let bytes = BASE64
        .decode(encoded)
        .map_err(|_| "Ungültige Base64-Bilddaten.".to_string())?;
    let magic_matches = match media_type {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/webp" => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/svg+xml" => safe_svg(&bytes),
        _ => false,
    };
    if !magic_matches {
        return Err("Bildformat und Dateisignatur stimmen nicht überein.".into());
    }
    Ok((media_type.to_owned(), bytes))
}

fn create_asset_thumbnail(bytes: &[u8]) -> Result<Vec<u8>, String> {
    const THUMBNAIL_EDGE: u32 = 192;
    let decoded = image::load_from_memory(bytes)
        .map_err(|_| "Für dieses Bildformat konnte keine Vorschau erzeugt werden.".to_string())?;
    let thumbnail = decoded.thumbnail(THUMBNAIL_EDGE, THUMBNAIL_EDGE).to_rgba8();
    let (width, height) = thumbnail.dimensions();
    let mut encoded = Vec::new();
    image::codecs::png::PngEncoder::new(&mut encoded)
        .write_image(&thumbnail, width, height, image::ExtendedColorType::Rgba8)
        .map_err(|_| "Die Bildvorschau konnte nicht kodiert werden.".to_string())?;
    Ok(encoded)
}

fn safe_svg(bytes: &[u8]) -> bool {
    let Ok(source) = std::str::from_utf8(bytes) else {
        return false;
    };
    let normalized = source.trim_start().to_ascii_lowercase();
    let has_svg_root = normalized.starts_with("<svg")
        || normalized
            .strip_prefix("<?xml")
            .and_then(|rest| rest.find("?>").map(|end| &rest[end + 2..]))
            .is_some_and(|rest| rest.trim_start().starts_with("<svg"));
    let inspected = normalized
        .replace("http://www.w3.org/2000/svg", "")
        .replace("http://www.w3.org/1999/xlink", "");
    has_svg_root
        && ![
            "<script",
            "javascript:",
            "onload=",
            "onerror=",
            "<foreignobject",
            "http://",
            "https://",
        ]
        .iter()
        .any(|needle| inspected.contains(needle))
}

fn optimize_reference_image(reference: &str) -> Result<String, String> {
    if reference.starts_with("https://") || reference.starts_with("http://") {
        return Ok(reference.to_owned());
    }
    let (_, bytes) = decode_image_data_url(reference)?;
    let decoded = image::load_from_memory(&bytes)
        .map_err(|_| "Referenzbild konnte nicht dekodiert werden.".to_string())?;
    let (width, height) = decoded.dimensions();
    const MAX_EDGE: u32 = 2048;
    let optimized = if width.max(height) > MAX_EDGE {
        decoded.resize(MAX_EDGE, MAX_EDGE, image::imageops::FilterType::Lanczos3)
    } else {
        decoded
    };
    let has_alpha = optimized.color().has_alpha();
    let (media_type, output) = if has_alpha {
        let rgba = optimized.to_rgba8();
        let mut output = Vec::new();
        image::codecs::png::PngEncoder::new(&mut output)
            .write_image(
                &rgba,
                rgba.width(),
                rgba.height(),
                image::ExtendedColorType::Rgba8,
            )
            .map_err(|_| "Optimiertes PNG konnte nicht erzeugt werden.".to_string())?;
        ("image/png", output)
    } else {
        let rgb = optimized.to_rgb8();
        let mut output = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, 85)
            .write_image(
                &rgb,
                rgb.width(),
                rgb.height(),
                image::ExtendedColorType::Rgb8,
            )
            .map_err(|_| "Optimiertes JPEG konnte nicht erzeugt werden.".to_string())?;
        ("image/jpeg", output)
    };
    Ok(format!(
        "data:{media_type};base64,{}",
        BASE64.encode(output)
    ))
}

async fn checked_json(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    let retry_after = response
        .headers()
        .get("retry-after")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let body: Value = response.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() || body.get("error").is_some() {
        let message = body
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("OpenRouter-Anfrage fehlgeschlagen");
        let error_type = body
            .pointer("/error/metadata/error_type")
            .or_else(|| body.get("error_type"))
            .and_then(Value::as_str);
        let code = body
            .pointer("/error/code")
            .and_then(Value::as_u64)
            .map(|value| value as u16)
            .unwrap_or(status.as_u16());
        let explanation = match (code, error_type) {
            (402, _) | (_, Some("payment_required")) => "Dein OpenRouter-Guthaben oder das Ausgabenlimit des API-Keys ist ausgeschöpft.",
            (429, _) | (_, Some("rate_limit_exceeded")) => "Das Modell oder sein Provider hat gerade ein Rate- oder Quota-Limit erreicht. Warte kurz oder wähle ein anderes Modell.",
            (503, _) | (_, Some("provider_overloaded")) => "Der Modell-Provider ist momentan überlastet. Versuche es gleich erneut oder wähle ein anderes Modell.",
            (502, _) | (_, Some("provider_unavailable")) => "Der Modell-Provider ist momentan nicht verfügbar.",
            (_, Some("token_limit_exceeded")) => "Das Token- oder Kostenlimit dieser Anfrage wurde überschritten.",
            _ => "OpenRouter konnte die Anfrage nicht ausführen.",
        };
        let retry = retry_after
            .map(|seconds| format!(" Erneut versuchen in etwa {} Sekunden.", seconds))
            .unwrap_or_default();
        let kind = error_type
            .map(|value| format!(" · {}", value))
            .unwrap_or_default();
        return Err(format!(
            "{}{}\n{} ({}{})",
            explanation, retry, message, code, kind
        ));
    }
    Ok(body)
}

#[tauri::command]
fn save_openrouter_key(key: String) -> Result<(), String> {
    let key = key.trim();
    if !key.starts_with("sk-or-") || key.len() < 20 {
        return Err("Das sieht nicht wie ein OpenRouter-Key aus.".into());
    }
    entry()?.set_password(key).map_err(|e| e.to_string())
}

#[tauri::command]
fn openrouter_key_status() -> bool {
    entry()
        .and_then(|e| e.get_password().map_err(|e| e.to_string()))
        .is_ok()
}

#[tauri::command]
fn delete_openrouter_key() -> Result<(), String> {
    entry()?.delete_credential().map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_models(kind: String) -> Result<Value, String> {
    if kind == "image" {
        // Visual generation is fal.ai-only. Keep the legacy OpenRouter image
        // implementation below readable for old persisted history, but never
        // expose its catalog or execution commands to a new run.
        return Ok(json!({ "data": [] }));
    }
    let url = if kind == "transcription" {
        "https://openrouter.ai/api/v1/models?output_modalities=transcription"
    } else {
        "https://openrouter.ai/api/v1/models?output_modalities=text"
    };
    let mut response = checked_json(
        Client::new()
            .get(url)
            .send()
            .await
            .map_err(|e| e.to_string())?,
    )
    .await?;
    filter_model_catalog(&kind, &mut response);
    Ok(response)
}

fn filter_model_catalog(kind: &str, response: &mut Value) {
    if kind == "vision" {
        if let Some(models) = response.get_mut("data").and_then(Value::as_array_mut) {
            models.retain(|model| {
                let inputs = model
                    .pointer("/architecture/input_modalities")
                    .and_then(Value::as_array);
                let outputs = model
                    .pointer("/architecture/output_modalities")
                    .and_then(Value::as_array);
                inputs.is_some_and(|items| items.iter().any(|item| item.as_str() == Some("image")))
                    && outputs
                        .is_some_and(|items| items.iter().any(|item| item.as_str() == Some("text")))
            });
        }
    } else if kind == "transcription" {
        if let Some(models) = response.get_mut("data").and_then(Value::as_array_mut) {
            models.retain(|model| {
                let inputs = model
                    .pointer("/architecture/input_modalities")
                    .and_then(Value::as_array);
                let outputs = model
                    .pointer("/architecture/output_modalities")
                    .and_then(Value::as_array);
                inputs.is_some_and(|items| items.iter().any(|item| item.as_str() == Some("audio")))
                    && outputs.is_some_and(|items| {
                        items
                            .iter()
                            .any(|item| item.as_str() == Some("transcription"))
                    })
            });
            for model in models {
                let id = model.get("id").and_then(Value::as_str).unwrap_or_default();
                let timestamps = transcription::model_supports_timestamps(id);
                model["flowz_capabilities"] = json!({
                    "timestamps": timestamps,
                    "timestampReason": if timestamps {
                        "Geprüfter OpenAI-kompatibler Whisper-Adapter: verbose_json mit Wort- und Abschnittszeitmarken."
                    } else {
                        "Für diese ASR-Modellfamilie ist kein geprüfter Wort-/Abschnittszeitmarken-Adapter verfügbar."
                    }
                });
            }
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptionResult {
    text: String,
    cost_microunits: Option<i64>,
    generation_id: Option<String>,
    result_id: Option<String>,
    created_at: String,
    persisted: bool,
    target_current: bool,
    persistence_error: Option<String>,
    timestamps: Option<transcription::TranscriptionTimestamps>,
}

fn validate_transcription_target(
    persistence: &Persistence,
    request: &transcription::TranscriptionRequest,
) -> Result<String, String> {
    let project = persistence.projects.open(&request.project_id)?.project;
    if !project
        .graph
        .nodes
        .iter()
        .any(|node| node.id == request.node_id && node.module_id == "ai.transcription")
    {
        return Err(
            "Die Transkriptions-Node existiert nicht mehr oder hat einen anderen Typ.".into(),
        );
    }
    if !project
        .graph
        .nodes
        .iter()
        .any(|node| node.id == request.source_node_id && node.module_id == "core.audio-input")
    {
        return Err(
            "Die verbundene Audio-Quelle existiert nicht mehr oder hat einen anderen Typ.".into(),
        );
    }
    if !persistence.database.validates_audio_source(
        &request.project_id,
        &request.source_node_id,
        &request.source_result_id,
        &request.source_blob_hash,
    )? {
        return Err("Die Audio-Quelle ist kein unveränderliches Ergebnis dieses Projekts.".into());
    }
    persistence.projects.media_target_grant(
        &request.project_id,
        &request.node_id,
        "ai.transcription",
    )
}

#[tauri::command]
async fn run_transcription(
    request: transcription::TranscriptionRequest,
    registry: tauri::State<'_, TranscriptionRunRegistry>,
    persistence: tauri::State<'_, Persistence>,
) -> Result<TranscriptionResult, String> {
    let token = registry.start(&request.run_id)?;
    let _cleanup = TranscriptionRunCleanup {
        registry: registry.inner().clone(),
        run_id: request.run_id.clone(),
    };
    if token.is_cancelled() {
        return Err("Transkription abgebrochen.".into());
    }
    transcription::validate_request(&request)?;
    let target_grant = validate_transcription_target(&persistence, &request)?;
    let blob = persistence.blobs.metadata(&request.source_blob_hash)?;
    if !blob.media_type.starts_with("audio/") {
        return Err("Die verbundene Quelle ist keine Audiodatei.".into());
    }
    let size = persistence.blobs.size(&request.source_blob_hash)?;
    if size == 0 || size > transcription::MAX_TRANSCRIPTION_BYTES as u64 {
        return Err("Transkriptionsdateien müssen zwischen 1 Byte und 25 MB groß sein. Teile längere Audios vor der Transkription in kürzere Abschnitte.".into());
    }
    let path = persistence.blobs.path_for_hash(&request.source_blob_hash)?;
    let read_token = token.clone();
    let read_task = tokio::task::spawn_blocking(move || {
        let file = std::fs::File::open(path).map_err(|error| error.to_string())?;
        let mut bytes = Vec::with_capacity(size as usize);
        let mut limited = file.take(transcription::MAX_TRANSCRIPTION_BYTES as u64 + 1);
        let mut chunk = [0_u8; 64 * 1024];
        loop {
            if read_token.is_cancelled() {
                return Err(transcription::TRANSCRIPTION_CANCELLED.into());
            }
            let read = limited
                .read(&mut chunk)
                .map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            bytes.extend_from_slice(&chunk[..read]);
        }
        if bytes.len() > transcription::MAX_TRANSCRIPTION_BYTES {
            return Err("Transkriptionsdateien sind auf 25 MB begrenzt.".into());
        }
        Ok::<_, String>(bytes)
    });
    let bytes = tokio::select! {
        _ = token.cancelled() => return Err("Transkription abgebrochen.".into()),
        result = read_task => result.map_err(|_| "Die Audiodatei konnte nicht vorbereitet werden.".to_string())??,
    };
    if token.is_cancelled() {
        return Err("Transkription abgebrochen.".into());
    }
    let key = api_key()?;
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| error.to_string())?;
    let filename = blob.original_name.as_deref().unwrap_or("flowz-audio");
    let outcome = transcription::request_transcription(
        &client,
        "https://openrouter.ai/api/v1/audio/transcriptions",
        &key,
        &request.model,
        bytes,
        &blob.media_type,
        filename,
        request.language.as_deref(),
        request.timestamps,
        &token,
    )
    .await;
    let provider = match outcome {
        Err(message) if message == transcription::TRANSCRIPTION_CANCELLED => {
            return Err("Transkription abgebrochen.".into())
        }
        other => other?,
    };
    let created_at = Utc::now().to_rfc3339();
    // Billing is authoritative as soon as the provider has completed, even if the
    // target was removed while the request was in flight or result attachment fails.
    let target_current = persistence
        .projects
        .media_target_matches_grant(
            &request.project_id,
            &request.node_id,
            "ai.transcription",
            &target_grant,
        )
        .unwrap_or(false);
    let result_id = Uuid::new_v4().to_string();
    let parameters = json!({
        "language": transcription::normalized_language(request.language.as_deref())?.unwrap_or_else(|| "auto".into()),
        "timestamps": request.timestamps,
        "timestampData": provider.timestamps.clone(),
        "sourceProjectId": request.project_id,
        "sourceNodeId": request.source_node_id,
        "sourceResultId": request.source_result_id,
        "sourceBlobHash": request.source_blob_hash,
        "generationId": provider.generation_id.clone(),
        "executionFingerprint": request.execution_fingerprint,
        "targetGrant": target_grant,
        "orphaned": !target_current,
    });
    let persisted_result = persistence.database.record_provider_text_result_atomic(
        &result_id,
        &request.run_id,
        &request.project_id,
        &request.node_id,
        &request.model,
        "transcription",
        &provider.text,
        Some(&parameters),
        provider.cost_microunits,
        &created_at,
        false,
    );
    let (persisted, outboxed, persistence_error) = match persisted_result {
        Ok(_) => (true, false, None),
        Err(database_error) => {
            let mut emergency_parameters = parameters.clone();
            emergency_parameters["orphaned"] = Value::Bool(true);
            emergency_parameters["emergencyOutbox"] = Value::Bool(true);
            let emergency = EmergencyTextResult {
                version: 1,
                result_id: result_id.clone(),
                run_id: request.run_id.clone(),
                project_id: request.project_id.clone(),
                node_id: request.node_id.clone(),
                model: request.model.clone(),
                kind: "transcription".into(),
                text: provider.text.clone(),
                parameters: emergency_parameters,
                cost_microunits: provider.cost_microunits,
                created_at: created_at.clone(),
            };
            match persistence.emergency_outbox.store(&emergency) {
                Ok(()) => (
                    false,
                    true,
                    Some(format!(
                        "Die SQLite-Ablage ist fehlgeschlagen ({database_error}). Das bezahlte Transkript wurde fsync-sicher in „Nicht zugeordnet“ gesichert."
                    )),
                ),
                Err(outbox_error) => (
                    false,
                    false,
                    Some(format!(
                        "Transkript nur temporär: SQLite-Fehler: {database_error}; Notfallablage-Fehler: {outbox_error}"
                    )),
                ),
            }
        }
    };
    Ok(TranscriptionResult {
        text: provider.text,
        cost_microunits: provider.cost_microunits,
        generation_id: provider.generation_id,
        result_id: (persisted || outboxed).then_some(result_id),
        created_at,
        persisted,
        target_current,
        persistence_error,
        timestamps: provider.timestamps,
    })
}

#[tauri::command]
fn cancel_transcription_run(
    run_id: String,
    registry: tauri::State<'_, TranscriptionRunRegistry>,
) -> bool {
    registry.cancel(&run_id)
}

#[tauri::command]
async fn run_chat(request: ChatRequest) -> Result<AiResult, String> {
    let custom_system = request.system_instruction.as_deref().unwrap_or("").trim();
    if custom_system.len() > 8_000 {
        return Err("Die globale Text-KI-Anweisung ist zu lang.".into());
    }
    let mut content = vec![json!({"type":"text", "text": request.prompt})];
    for image in request.images {
        let optimized = optimize_reference_image(&image)?;
        content.push(json!({"type":"image_url", "image_url":{"url": optimized}}));
    }
    let custom_schema = request.schema.clone();
    let structured = request.output_mode.as_deref() == Some("single") || custom_schema.is_some();
    let built_in_system = if custom_schema.is_some() {
        "Return only the requested structured data. Distinguish sourced evidence from assumptions; never invent evidence or availability claims."
    } else {
        "Return exactly one final result. Do not add introductions, alternatives, explanations, labels, follow-up questions, or commentary. Put only that single result in the required result field."
    };
    let messages = if structured {
        json!([
            {"role":"system", "content": if custom_system.is_empty() { built_in_system.to_string() } else { format!("{}\n\n{}", custom_system, built_in_system) }},
            {"role":"user", "content": content}
        ])
    } else if !custom_system.is_empty() {
        json!([{"role":"system", "content": custom_system}, {"role":"user", "content": content}])
    } else {
        json!([{"role":"user", "content": content}])
    };
    let mut body = json!({"model": request.model, "messages": messages, "usage":{"include":true}});
    if let Some(schema) = custom_schema {
        let schema_name = request
            .schema_name
            .as_deref()
            .unwrap_or("flowz_structured_artifact");
        if schema_name.is_empty()
            || schema_name.len() > 64
            || !schema_name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            return Err("Ungültiger Name für das strukturierte Schema.".into());
        }
        body["response_format"] = json!({
            "type":"json_schema",
            "json_schema":{"name":schema_name,"strict":true,"schema":schema}
        });
        body["provider"] = json!({"require_parameters":true});
    } else if structured {
        body["response_format"] = json!({
            "type":"json_schema",
            "json_schema":{
                "name":"flowz_single_result",
                "strict":true,
                "schema":{
                    "type":"object",
                    "properties":{
                        "result":{
                            "type":"string",
                            "description":"Exactly one final result requested by the user, without preamble, alternatives, labels, explanations, or follow-up text."
                        }
                    },
                    "required":["result"],
                    "additionalProperties":false
                }
            }
        });
        body["provider"] = json!({"require_parameters":true});
    }
    let response = Client::new()
        .post("https://openrouter.ai/api/v1/chat/completions")
        .bearer_auth(api_key()?)
        .header("HTTP-Referer", "https://flowz.dev")
        .header("X-Title", "FlowZ")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let data = checked_json(response).await?;
    let raw_content = data
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let output = if request.schema.is_some() {
        let raw = raw_content
            .ok_or_else(|| "Das Modell hat keine strukturierte Antwort geliefert.".to_string())?;
        let parsed: Value = serde_json::from_str(&raw)
            .map_err(|_| "Die strukturierte Modellantwort war kein gültiges JSON.".to_string())?;
        serde_json::to_string(&parsed).map_err(|error| error.to_string())?
    } else if structured {
        let raw = raw_content
            .ok_or_else(|| "Das Modell hat keine strukturierte Antwort geliefert.".to_string())?;
        let parsed: Value = serde_json::from_str(&raw)
            .map_err(|_| "Die strukturierte Modellantwort war kein gültiges JSON.".to_string())?;
        parsed
            .get("result")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| "In der strukturierten Antwort fehlt das Feld „result“.".to_string())?
    } else {
        raw_content.unwrap_or_default()
    };
    Ok(AiResult {
        content: Some(output),
        images: vec![],
        cost_microunits: provider_cost_microunits(&data),
        generation_id: data.get("id").and_then(Value::as_str).map(str::to_owned),
    })
}

#[tauri::command]
fn project_create(
    request: CreateProjectRequest,
    persistence: tauri::State<'_, Persistence>,
) -> Result<ProjectSaveResult, String> {
    let record = persistence.projects.create(request)?;
    persistence.database.upsert_project(&record.project)?;
    Ok(record)
}

#[tauri::command]
fn project_list(persistence: tauri::State<'_, Persistence>) -> Result<Vec<ProjectSummary>, String> {
    persistence.projects.list()
}

#[tauri::command]
fn project_open(
    id: String,
    persistence: tauri::State<'_, Persistence>,
) -> Result<ProjectSaveResult, String> {
    persistence.projects.open(&id)
}

#[tauri::command]
fn project_save(
    request: SaveProjectRequest,
    persistence: tauri::State<'_, Persistence>,
) -> Result<ProjectSaveResult, String> {
    let record = persistence.projects.save(request)?;
    persistence.database.upsert_project(&record.project)?;
    Ok(record)
}

#[tauri::command]
fn document_catalog_list(
    persistence: tauri::State<'_, Persistence>,
) -> Result<Vec<CatalogRecord>, String> {
    persistence.document_catalog_list()
}

#[tauri::command]
fn document_flow_cover_source(
    document_id: String,
    expected_revision: u64,
    content_fingerprint: String,
    persistence: tauri::State<'_, Persistence>,
) -> Result<persistence::FlowCoverSource, String> {
    persistence.document_flow_cover_source(&document_id, expected_revision, &content_fingerprint)
}

#[tauri::command]
fn document_cover_commit(
    request: persistence::DocumentCoverCommitRequest,
    persistence: tauri::State<'_, Persistence>,
) -> Result<persistence::DocumentCoverRecord, String> {
    persistence.document_cover_commit(request)
}

#[tauri::command]
fn document_catalog_create(
    request: CatalogCreateRequest,
    persistence: tauri::State<'_, Persistence>,
) -> Result<CatalogRecord, String> {
    persistence.document_catalog_create(request)
}

#[tauri::command]
fn document_catalog_rename(
    request: CatalogRenameRequest,
    persistence: tauri::State<'_, Persistence>,
) -> Result<CatalogRecord, String> {
    persistence.document_catalog_rename(request)
}

#[tauri::command]
fn document_catalog_duplicate(
    request: CatalogDuplicateRequest,
    persistence: tauri::State<'_, Persistence>,
) -> Result<CatalogRecord, String> {
    persistence.document_catalog_duplicate(request)
}

#[tauri::command]
fn document_catalog_delete(
    request: CatalogDeleteRequest,
    persistence: tauri::State<'_, Persistence>,
) -> Result<CatalogDeleteResult, String> {
    persistence.document_catalog_delete(request)
}

#[tauri::command]
fn artboard_workspace_create(
    request: CreateArtboardWorkspace,
    persistence: tauri::State<'_, Persistence>,
) -> Result<ArtboardRevision, String> {
    persistence.database.create_artboard_workspace(request)
}
#[tauri::command]
fn artboard_workspace_open(
    id: String,
    persistence: tauri::State<'_, Persistence>,
) -> Result<Option<ArtboardWorkspaceRecord>, String> {
    persistence.database.open_artboard_workspace(&id)
}
#[tauri::command]
fn artboard_revision_open(
    id: String,
    persistence: tauri::State<'_, Persistence>,
) -> Result<Option<ArtboardRevision>, String> {
    persistence.database.artboard_revision(&id)
}
#[tauri::command]
fn artboard_apply_operations(
    request: ApplyArtboardOperationBatch,
    persistence: tauri::State<'_, Persistence>,
) -> Result<ArtboardRevision, String> {
    if request
        .operations
        .iter()
        .any(|operation| operation.get("type").and_then(Value::as_str) == Some("set-board-inputs"))
    {
        let snapshot = request
            .input_snapshot
            .as_ref()
            .ok_or("Eine Flow-Verknüpfung braucht den exakten InputSnapshot.")?;
        let bindings = snapshot
            .get("bindings")
            .and_then(Value::as_object)
            .ok_or("InputSnapshot.bindings fehlt.")?;
        for (binding_id, binding) in bindings {
            let source = binding
                .get("source")
                .and_then(Value::as_object)
                .ok_or("InputBinding.source fehlt.")?;
            let project_id = source
                .get("projectId")
                .and_then(Value::as_str)
                .ok_or("InputBinding.source.projectId fehlt.")?;
            let source_node_id = source
                .get("nodeId")
                .and_then(Value::as_str)
                .ok_or("InputBinding.source.nodeId fehlt.")?;
            let source_port_id = source
                .get("portId")
                .and_then(Value::as_str)
                .ok_or("InputBinding.source.portId fehlt.")?;
            let project = persistence.projects.open(project_id)?.project;
            let targets = project
                .graph
                .nodes
                .iter()
                .filter(|node| {
                    node.module_id == "brand.artboard"
                        && node
                            .config
                            .get("artboardWorkspaceId")
                            .and_then(Value::as_str)
                            == Some(request.workspace_id.as_str())
                })
                .map(|node| node.id.as_str())
                .collect::<std::collections::HashSet<_>>();
            let target_role = binding_id
                .rsplit_once('-')
                .map_or(binding_id.as_str(), |item| item.0);
            let exact_edge = project.graph.edges.iter().any(|edge| {
                edge.source_node_id == source_node_id
                    && edge.source_port_id.split("::").next() == Some(source_port_id)
                    && targets.contains(edge.target_node_id.as_str())
                    && edge.target_port_id.split("::").next() == Some(target_role)
            });
            if !exact_edge {
                return Err(format!(
                    "InputBinding {binding_id} stimmt nicht mit Projekt, Quell-Node, Quell-Port und verknüpfter Artboard-Node überein."
                ));
            }
        }
    }
    persistence.database.apply_artboard_operation_batch(request)
}
#[tauri::command]
fn artboard_branch_create(
    request: CreateArtboardBranch,
    persistence: tauri::State<'_, Persistence>,
) -> Result<ArtboardBranch, String> {
    persistence.database.create_artboard_branch(request)
}
#[tauri::command]
fn artboard_move_head(
    request: MoveArtboardHead,
    persistence: tauri::State<'_, Persistence>,
) -> Result<ArtboardBranch, String> {
    persistence.database.move_artboard_head(request)
}
#[tauri::command]
fn artboard_register_input_snapshot(
    request: RegisterArtboardInputSnapshot,
    persistence: tauri::State<'_, Persistence>,
) -> Result<String, String> {
    persistence
        .database
        .register_artboard_input_snapshot(request)
}

#[tauri::command]
fn blob_pick_import(
    app: tauri::AppHandle,
    persistence: tauri::State<'_, Persistence>,
) -> Result<BlobMetadata, String> {
    let selected = app
        .dialog()
        .file()
        .blocking_pick_file()
        .ok_or_else(|| "Dateiauswahl wurde abgebrochen.".to_string())?;
    let path = selected.into_path().map_err(|_| {
        "Die ausgewählte Datei hat keinen lokalen, importierbaren Pfad.".to_string()
    })?;
    let request = ImportBlobRequest {
        path,
        media_type: None,
        original_name: None,
    };
    let blob = persistence.blobs.import(request)?;
    persistence.database.upsert_blob(&blob)?;
    Ok(blob)
}

#[tauri::command]
fn recording_begin(
    project_id: String,
    node_id: String,
    project_revision: u64,
    mime_type: String,
    persistence: tauri::State<'_, Persistence>,
    recordings: tauri::State<'_, recording::RecordingSessionRegistry>,
) -> Result<String, String> {
    let _ = project_revision;
    let target_grant =
        persistence
            .projects
            .media_target_grant(&project_id, &node_id, "core.audio-input")?;
    recordings.begin(project_id, node_id, target_grant, mime_type)
}

#[tauri::command]
fn recording_append(
    request: IpcRequest<'_>,
    recordings: tauri::State<'_, recording::RecordingSessionRegistry>,
) -> Result<u64, String> {
    let session_id = request
        .headers()
        .get("x-flowz-recording-session")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "Die Aufnahme-Session fehlt.".to_string())?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Audio-Chunks müssen als rohe Binärdaten übertragen werden.".into());
    };
    recordings.append(session_id, bytes)
}

#[tauri::command]
async fn recording_finish(
    session_id: String,
    persistence: tauri::State<'_, Persistence>,
    recordings: tauri::State<'_, recording::RecordingSessionRegistry>,
    stages: tauri::State<'_, MediaStageRegistry>,
) -> Result<ImportedMedia, String> {
    let completed = recordings.finish(&session_id)?;
    let target_grant = completed.target_grant.clone();
    let persistence = persistence.inner().clone();
    let stages = stages.inner().clone();
    let joined = tokio::task::spawn_blocking(move || {
        let cancelled = AtomicBool::new(false);
        stage_media_path(
            completed.path,
            Some(completed.original_name),
            "audio",
            &completed.project_id,
            &completed.node_id,
            0,
            Some(target_grant),
            "recording",
            &persistence,
            &stages,
            &cancelled,
        )
    })
    .await;
    let staged =
        joined.map_err(|_| "Die Aufnahmeprüfung wurde unerwartet beendet.".to_string())??;
    recordings.complete(&session_id)?;
    Ok(staged)
}

#[tauri::command]
fn recording_abort(
    session_id: String,
    recordings: tauri::State<'_, recording::RecordingSessionRegistry>,
) -> Result<bool, String> {
    recordings.abort(&session_id)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn media_pick_stage(
    kind: String,
    project_id: String,
    node_id: String,
    project_revision: u64,
    operation_id: String,
    app: tauri::AppHandle,
    persistence: tauri::State<'_, Persistence>,
    stages: tauri::State<'_, MediaStageRegistry>,
    cancellations: tauri::State<'_, MediaCancelRegistry>,
) -> Result<ImportedMedia, String> {
    if kind != "video" && kind != "audio" {
        return Err("Unbekannter Medientyp.".into());
    }
    let mut picker = app.dialog().file();
    picker = if kind == "video" {
        picker.add_filter("Video", &["mp4", "m4v", "mov", "webm"])
    } else {
        picker.add_filter("Audio", &["mp3", "m4a", "wav", "flac", "ogg", "webm"])
    };
    let (sender, receiver) = tokio::sync::oneshot::channel();
    picker.pick_file(move |selected| {
        let _ = sender.send(selected);
    });
    let selected = receiver
        .await
        .map_err(|_| "Dateiauswahl wurde abgebrochen.".to_string())?
        .ok_or_else(|| "Dateiauswahl wurde abgebrochen.".to_string())?;
    let path = selected
        .into_path()
        .map_err(|_| "Die ausgewählte Datei hat keinen lokalen Pfad.".to_string())?;
    let original_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned());
    let persistence = persistence.inner().clone();
    let stages = stages.inner().clone();
    let cancellations = cancellations.inner().clone();
    let cancelled = register_media_cancellation(&cancellations, &operation_id)?;
    let joined = tokio::task::spawn_blocking(move || {
        stage_media_path(
            path,
            original_name,
            &kind,
            &project_id,
            &node_id,
            project_revision,
            None,
            "file",
            &persistence,
            &stages,
            &cancelled,
        )
    })
    .await;
    if let Ok(mut items) = cancellations.0.lock() {
        items.remove(&operation_id);
    }
    joined.map_err(|_| "Der Medienimport wurde unerwartet beendet.".to_string())?
}

fn validate_media_target(
    persistence: &Persistence,
    project_id: &str,
    node_id: &str,
    kind: &str,
    project_revision: u64,
) -> Result<(), String> {
    let expected = if kind == "video" {
        "core.video-input"
    } else if kind == "audio" {
        "core.audio-input"
    } else {
        return Err("Unbekannter Medientyp.".into());
    };
    persistence
        .projects
        .with_media_target(project_id, node_id, expected, project_revision, || Ok(()))
}

#[allow(clippy::too_many_arguments)]
fn stage_media_path(
    path: PathBuf,
    original_name: Option<String>,
    kind: &str,
    project_id: &str,
    node_id: &str,
    project_revision: u64,
    target_grant: Option<String>,
    origin: &str,
    persistence: &Persistence,
    stages: &MediaStageRegistry,
    cancelled: &AtomicBool,
) -> Result<ImportedMedia, String> {
    prune_expired_media_stages(stages, persistence);
    if target_grant.is_none() {
        validate_media_target(persistence, project_id, node_id, kind, project_revision)?;
    }
    let snapshot = snapshot_media(
        &persistence.blobs,
        ImportBlobRequest {
            path,
            media_type: None,
            original_name,
        },
        cancelled,
    )?;
    let already_durable = persistence.database.contains_blob(&snapshot.hash)?;
    let mut imported = match inspect_media(&persistence.blobs, snapshot.clone(), kind, cancelled) {
        Ok(imported) => imported,
        Err(error) => {
            if !already_durable {
                let _ = persistence.blobs.remove_untracked(&snapshot.hash);
            }
            return Err(error);
        }
    };
    if target_grant.is_none() {
        if let Err(error) =
            validate_media_target(persistence, project_id, node_id, kind, project_revision)
        {
            cleanup_staged_media(&imported, stages, persistence);
            return Err(error);
        }
    }
    let stage_id = Uuid::new_v4().to_string();
    imported.stage_id = Some(stage_id.clone());
    let persisted_created_at = Utc::now();
    let inserted = stages.items.lock().map(|mut items| {
        items.insert(
            stage_id.clone(),
            MediaStage {
                imported: imported.clone(),
                project_id: project_id.into(),
                node_id: node_id.into(),
                kind: kind.into(),
                project_revision,
                target_grant,
                origin: origin.into(),
                finalizing: false,
                created_at: Instant::now(),
                persisted_created_at,
            },
        )
    });
    if inserted.is_err() {
        cleanup_staged_media(&imported, stages, persistence);
        return Err("Import-Staging ist nicht verfügbar.".into());
    }
    let persistence_result = stages
        .items
        .lock()
        .map_err(|_| "Import-Staging ist nicht verfügbar.".to_string())?
        .get(&stage_id)
        .ok_or_else(|| "Import-Staging ist nicht verfügbar.".to_string())
        .and_then(|stage| stages.persist(&stage_id, stage));
    if let Err(error) = persistence_result {
        if let Ok(mut items) = stages.items.lock() {
            items.remove(&stage_id);
        }
        cleanup_staged_media(&imported, stages, persistence);
        return Err(format!(
            "Aufnahmestand konnte nicht sicher gespeichert werden: {error}"
        ));
    }
    Ok(imported)
}

fn prune_expired_media_stages(stages: &MediaStageRegistry, persistence: &Persistence) {
    let expired = stages
        .items
        .lock()
        .ok()
        .map(|mut items| {
            let ids: Vec<_> = items
                .iter()
                .filter(|(_, stage)| stage.created_at.elapsed() > media_stage_lifetime(stage))
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|id| items.remove(&id))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for stage in expired {
        if let Some(id) = stage.imported.stage_id.as_deref() {
            stages.delete_manifest(id);
        }
        cleanup_staged_media(&stage.imported, stages, persistence);
    }
}

fn media_stage_lifetime(stage: &MediaStage) -> Duration {
    if stage.origin == "recording" {
        Duration::from_secs(2 * 60 * 60)
    } else {
        Duration::from_secs(120)
    }
}

fn finalize_media_import(
    mut imported: ImportedMedia,
    project_id: &str,
    node_id: &str,
    persistence: &Persistence,
) -> Result<ImportedMedia, String> {
    let poster = imported
        .poster_hash
        .as_deref()
        .map(|hash| persistence.blobs.metadata(hash))
        .transpose()?;
    let (result_id, asset_id) = if imported.metadata.kind == "video" {
        let start = persistence::extract_video_frame(&persistence.blobs, &imported.hash, 0.0)?;
        let end = persistence::extract_video_frame(
            &persistence.blobs,
            &imported.hash,
            (imported.metadata.duration_seconds - 0.05).max(0.0),
        )?;
        let ids = persistence.database.record_video_import_with_frames(
            project_id,
            node_id,
            &imported.blob,
            &imported.metadata,
            poster.as_ref(),
            &start,
            &end,
        )?;
        imported.start_frame_hash = Some(start.hash);
        imported.end_frame_hash = Some(end.hash);
        ids
    } else {
        persistence.database.record_media_import(
            project_id,
            node_id,
            &imported.blob,
            &imported.metadata,
            poster.as_ref(),
        )?
    };
    imported.result_id = Some(result_id);
    imported.asset_id = Some(asset_id);
    Ok(imported)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn media_drop_stage(
    token: String,
    kind: String,
    project_id: String,
    node_id: String,
    project_revision: u64,
    operation_id: String,
    webview: tauri::WebviewWindow,
    drops: tauri::State<'_, DropGrantRegistry>,
    stages: tauri::State<'_, MediaStageRegistry>,
    persistence: tauri::State<'_, Persistence>,
    cancellations: tauri::State<'_, MediaCancelRegistry>,
) -> Result<ImportedMedia, String> {
    let canonical = consume_drop_grant(&drops, &token, webview.label())?;
    let original_name = canonical
        .file_name()
        .map(|name| name.to_string_lossy().into_owned());
    let persistence = persistence.inner().clone();
    let stages = stages.inner().clone();
    let cancellations = cancellations.inner().clone();
    let cancelled = register_media_cancellation(&cancellations, &operation_id)?;
    let joined = tokio::task::spawn_blocking(move || {
        stage_media_path(
            canonical,
            original_name,
            &kind,
            &project_id,
            &node_id,
            project_revision,
            None,
            "drop",
            &persistence,
            &stages,
            &cancelled,
        )
    })
    .await;
    if let Ok(mut items) = cancellations.0.lock() {
        items.remove(&operation_id);
    }
    joined.map_err(|_| "Der Medienimport wurde unerwartet beendet.".to_string())?
}

fn consume_drop_grant(
    drops: &DropGrantRegistry,
    token: &str,
    webview_label: &str,
) -> Result<PathBuf, String> {
    drops
        .0
        .lock()
        .map_err(|_| "Drop-Prüfung ist nicht verfügbar.".to_string())?
        .remove(token)
        .filter(|grant| {
            grant.created_at.elapsed() < Duration::from_secs(20)
                && grant.webview_label == webview_label
        })
        .map(|grant| grant.path)
        .ok_or_else(|| "Der einmalige Drop-Token ist ungültig oder abgelaufen.".to_string())
}

#[tauri::command]
fn media_cancel_import(
    operation_id: String,
    cancellations: tauri::State<'_, MediaCancelRegistry>,
) -> bool {
    cancellations
        .0
        .lock()
        .ok()
        .and_then(|items| items.get(&operation_id).cloned())
        .is_some_and(|flag| {
            flag.store(true, std::sync::atomic::Ordering::Relaxed);
            true
        })
}

#[tauri::command]
fn media_finalize_stage(
    stage_id: String,
    project_id: String,
    node_id: String,
    kind: String,
    stages: tauri::State<'_, MediaStageRegistry>,
    persistence: tauri::State<'_, Persistence>,
) -> Result<ImportedMedia, String> {
    finalize_media_stage_inner(
        &stage_id,
        &project_id,
        &node_id,
        &kind,
        &stages,
        &persistence,
    )
}

#[tauri::command]
fn media_pending_stages(
    project_id: String,
    node_id: String,
    stages: tauri::State<'_, MediaStageRegistry>,
    persistence: tauri::State<'_, Persistence>,
) -> Vec<PendingMediaStage> {
    prune_expired_media_stages(&stages, &persistence);
    stages
        .items
        .lock()
        .ok()
        .map(|items| {
            items
                .iter()
                .filter(|(_, stage)| stage.project_id == project_id && stage.node_id == node_id)
                .map(|(id, stage)| PendingMediaStage {
                    stage_id: id.clone(),
                    project_id: stage.project_id.clone(),
                    node_id: stage.node_id.clone(),
                    kind: stage.kind.clone(),
                    origin: stage.origin.clone(),
                    original_name: stage.imported.original_name.clone(),
                    created_at: stage.persisted_created_at,
                })
                .collect()
        })
        .unwrap_or_default()
}

fn finalize_media_stage_inner(
    stage_id: &str,
    project_id: &str,
    node_id: &str,
    kind: &str,
    stages: &MediaStageRegistry,
    persistence: &Persistence,
) -> Result<ImportedMedia, String> {
    prune_expired_media_stages(stages, persistence);
    let stage = {
        let mut items = stages
            .items
            .lock()
            .map_err(|_| "Import-Staging ist nicht verfügbar.".to_string())?;
        let stage = items.get_mut(stage_id).ok_or_else(|| {
            "Der Medienimport ist abgelaufen, wurde verworfen oder bereits verwendet.".to_string()
        })?;
        if stage.project_id != project_id || stage.node_id != node_id || stage.kind != kind {
            return Err("Der geprüfte Medienstand gehört zu einer anderen Ziel-Node und bleibt dort wiederherstellbar.".into());
        }
        if stage.finalizing {
            return Err("Dieser Medienstand wird bereits übernommen.".into());
        }
        stage.finalizing = true;
        stage.clone()
    };
    let expected_module = if kind == "video" {
        "core.video-input"
    } else if kind == "audio" {
        "core.audio-input"
    } else {
        if let Ok(mut items) = stages.items.lock() {
            if let Some(item) = items.get_mut(stage_id) {
                item.finalizing = false;
            }
        }
        return Err("Unbekannter Medientyp.".into());
    };
    let operation =
        || finalize_media_import(stage.imported.clone(), project_id, node_id, persistence);
    let committed = if let Some(grant) = stage.target_grant.as_deref() {
        persistence.projects.with_media_target_grant(
            project_id,
            node_id,
            expected_module,
            grant,
            operation,
        )
    } else {
        persistence.projects.with_media_target(
            project_id,
            node_id,
            expected_module,
            stage.project_revision,
            operation,
        )
    };
    match committed {
        Ok(imported) => {
            if let Ok(mut items) = stages.items.lock() {
                items.remove(stage_id);
            }
            stages.delete_manifest(stage_id);
            Ok(imported)
        }
        Err(error) => {
            if let Ok(mut items) = stages.items.lock() {
                if let Some(item) = items.get_mut(stage_id) {
                    item.finalizing = false;
                }
            }
            Err(format!("{error} Du kannst die geprüfte Aufnahme erneut übernehmen oder ausdrücklich verwerfen."))
        }
    }
}

#[tauri::command]
fn media_cancel_stage(
    stage_id: String,
    stages: tauri::State<'_, MediaStageRegistry>,
    persistence: tauri::State<'_, Persistence>,
) -> Result<(), String> {
    cancel_media_stage_inner(&stage_id, &stages, &persistence)
}

fn cancel_media_stage_inner(
    stage_id: &str,
    stages: &MediaStageRegistry,
    persistence: &Persistence,
) -> Result<(), String> {
    let stage = {
        stages
            .items
            .lock()
            .map_err(|_| "Import-Staging ist nicht verfügbar.".to_string())?
            .remove(stage_id)
    };
    if let Some(stage) = stage {
        stages.delete_manifest(stage_id);
        cleanup_staged_media(&stage.imported, stages, persistence);
    }
    Ok(())
}

fn cleanup_staged_media(
    imported: &ImportedMedia,
    stages: &MediaStageRegistry,
    persistence: &Persistence,
) {
    let hashes = [
        Some(imported.hash.as_str()),
        imported.poster_hash.as_deref(),
    ];
    for hash in hashes.into_iter().flatten() {
        let in_other_stage = stages.items.lock().ok().is_some_and(|items| {
            items.values().any(|stage| {
                stage.imported.hash == hash || stage.imported.poster_hash.as_deref() == Some(hash)
            })
        });
        if !in_other_stage && !persistence.database.contains_blob(hash).unwrap_or(true) {
            let _ = persistence.blobs.remove_untracked(hash);
        }
    }
}

fn media_protocol_response(
    request: &Request<Vec<u8>>,
    persistence: &Persistence,
) -> Response<Vec<u8>> {
    const MAX_NO_RANGE_BODY: u64 = 8 * 1024 * 1024;
    let fail = |status: StatusCode| {
        let mut response = Response::new(Vec::new());
        *response.status_mut() = status;
        response.headers_mut().insert(
            "X-Content-Type-Options",
            HeaderValue::from_static("nosniff"),
        );
        response
    };
    if request.method() != Method::GET && request.method() != Method::HEAD {
        let mut response = fail(StatusCode::METHOD_NOT_ALLOWED);
        response
            .headers_mut()
            .insert(header::ALLOW, HeaderValue::from_static("GET, HEAD"));
        return response;
    }
    let opaque_id = request.uri().path().trim_matches('/');
    if opaque_id.contains('/') {
        return fail(StatusCode::BAD_REQUEST);
    }
    let hash = opaque_id.to_ascii_lowercase();
    if hash.len() != 64 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return fail(StatusCode::BAD_REQUEST);
    }
    let Ok(metadata) = persistence.blobs.metadata(&hash) else {
        return fail(StatusCode::NOT_FOUND);
    };
    if !matches!(
        metadata.media_type.as_str(),
        "video/mp4"
            | "video/webm"
            | "video/quicktime"
            | "audio/mp4"
            | "audio/webm"
            | "audio/wav"
            | "audio/flac"
            | "audio/mpeg"
            | "audio/ogg"
            | "font/ttf"
            | "image/png"
            | "image/jpeg"
            | "image/webp"
    ) {
        return fail(StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }
    let Ok(size) = persistence.blobs.size(&hash) else {
        return fail(StatusCode::NOT_FOUND);
    };
    if size == 0 {
        return fail(StatusCode::NOT_FOUND);
    }
    let parsed = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| parse_single_range(value, size));
    if request.headers().contains_key(header::RANGE) && parsed.is_none() {
        return Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{size}"))
            .header(header::ACCEPT_RANGES, "bytes")
            .header("X-Content-Type-Options", "nosniff")
            .body(Vec::new())
            .unwrap_or_else(|_| fail(StatusCode::INTERNAL_SERVER_ERROR));
    }
    if request.method() == Method::GET && parsed.is_none() && size > MAX_NO_RANGE_BODY {
        return Response::builder()
            .status(StatusCode::PAYLOAD_TOO_LARGE)
            .header(header::ACCEPT_RANGES, "bytes")
            .header("X-FlowZ-Required-Range", "bytes")
            .header("X-FlowZ-Media-Size", size)
            .header("X-Content-Type-Options", "nosniff")
            .body(Vec::new())
            .unwrap_or_else(|_| fail(StatusCode::INTERNAL_SERVER_ERROR));
    }
    // Tauri v2 custom-protocol bodies are Cow<[u8]>, not streams. Small no-Range
    // requests receive a complete 200 response; large ones are rejected above
    // instead of allocating up to the 4-GiB import limit. WebKit/Chromium media
    // elements request seekable audio/video with Range and stay on this bounded path.
    let (start, mut end, partial) =
        parsed
            .map(|(a, b)| (a, b, true))
            .unwrap_or((0, size - 1, false));
    if partial {
        end = end.min(start.saturating_add(8 * 1024 * 1024 - 1));
    }
    let length = (end - start + 1) as usize;
    let body = if request.method() == Method::HEAD {
        Vec::new()
    } else {
        match persistence.blobs.read_range(&hash, start, length) {
            Ok(bytes) => bytes,
            Err(_) => return fail(StatusCode::NOT_FOUND),
        }
    };
    let mut response = Response::builder()
        .status(if partial {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        })
        .header(header::CONTENT_TYPE, metadata.media_type)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, length)
        .header("X-Content-Type-Options", "nosniff")
        .header(
            header::CACHE_CONTROL,
            "private, max-age=31536000, immutable",
        );
    if partial {
        response = response.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"));
    }
    response
        .body(body)
        .unwrap_or_else(|_| fail(StatusCode::INTERNAL_SERVER_ERROR))
}

fn parse_single_range(value: &str, size: u64) -> Option<(u64, u64)> {
    let value = value.strip_prefix("bytes=")?;
    if value.contains(',') {
        return None;
    }
    let (start, end) = value.split_once('-')?;
    if start.is_empty() {
        let suffix: u64 = end.parse().ok()?;
        if suffix == 0 {
            return None;
        }
        return Some((size.saturating_sub(suffix), size - 1));
    }
    let start: u64 = start.parse().ok()?;
    if start >= size {
        return None;
    }
    let end = if end.is_empty() {
        size - 1
    } else {
        end.parse::<u64>().ok()?.min(size - 1)
    };
    (start <= end).then_some((start, end))
}

#[tauri::command]
fn library_get_usage(persistence: tauri::State<'_, Persistence>) -> Result<LibraryUsage, String> {
    persistence.database.usage()
}

fn remove_orphaned_blobs(persistence: &Persistence, hashes: Vec<String>) -> Result<(), String> {
    let mut removed = Vec::new();
    for hash in hashes {
        persistence.blobs.remove_untracked(&hash)?;
        removed.push(hash);
    }
    persistence.database.purge_blob_rows(&removed)
}

fn project_protected_result_ids(
    project: &persistence::ProjectDocument,
) -> std::collections::HashSet<String> {
    let mut ids = std::collections::HashSet::new();
    for node in &project.graph.nodes {
        for key in ["collectionResultIds", "fanOutResultIds"] {
            if let Some(values) = node.config.get(key).and_then(Value::as_array) {
                ids.extend(values.iter().filter_map(Value::as_str).map(str::to_owned));
            }
        }
        if let Some(result_id) = node
            .config
            .get("directMedia")
            .and_then(Value::as_object)
            .and_then(|binding| binding.get("source"))
            .and_then(Value::as_object)
            .filter(|source| source.get("kind").and_then(Value::as_str) == Some("project-result"))
            .and_then(|source| source.get("resultId"))
            .and_then(Value::as_str)
        {
            ids.insert(result_id.to_owned());
        }
    }
    for edge in &project.graph.edges {
        if let Some(id) = edge.source_port_id.strip_prefix("variant:") {
            ids.insert(id.to_owned());
        }
    }
    ids
}

#[tauri::command]
fn library_storage_breakdown(
    persistence: tauri::State<'_, Persistence>,
) -> Result<StorageBreakdown, String> {
    persistence.database.storage_breakdown()
}

#[tauri::command]
fn library_project_costs(
    project_id: String,
    persistence: tauri::State<'_, Persistence>,
) -> Result<CostBreakdown, String> {
    persistence.database.project_costs(&project_id)
}

#[tauri::command]
fn fal_empirical_cost_estimate(
    request: FalEmpiricalCostQuery,
    persistence: tauri::State<'_, Persistence>,
) -> Result<FalEmpiricalCostEstimate, String> {
    persistence.fal_empirical_costs.estimate(&request)
}

#[tauri::command]
fn library_delete_result(
    project_id: String,
    result_id: String,
    protected_ids: Vec<String>,
    persistence: tauri::State<'_, Persistence>,
) -> Result<u64, String> {
    let project = persistence.projects.open(&project_id)?.project;
    let mut protected = project_protected_result_ids(&project);
    protected.extend(protected_ids);
    let protected = protected.into_iter().collect::<Vec<_>>();
    let outcome = persistence
        .database
        .delete_result(&project_id, &result_id, &protected)?;
    remove_orphaned_blobs(&persistence, outcome.orphaned_hashes)?;
    Ok(outcome.removed_results)
}

#[tauri::command]
fn library_clear_node_history(
    project_id: String,
    node_id: String,
    protected_ids: Vec<String>,
    persistence: tauri::State<'_, Persistence>,
) -> Result<u64, String> {
    let project = persistence.projects.open(&project_id)?.project;
    if !project.graph.nodes.iter().any(|node| node.id == node_id) {
        return Err("Die Node gehört nicht zum Projekt.".into());
    }
    let mut protected = project_protected_result_ids(&project);
    protected.extend(protected_ids);
    let protected = protected.into_iter().collect::<Vec<_>>();
    let outcome = persistence
        .database
        .clear_node_history(&project_id, &node_id, &protected)?;
    remove_orphaned_blobs(&persistence, outcome.orphaned_hashes)?;
    Ok(outcome.removed_results)
}

#[tauri::command]
fn library_delete_project(
    project_id: String,
    confirmation: String,
    persistence: tauri::State<'_, Persistence>,
) -> Result<(), String> {
    let project = persistence.projects.open(&project_id)?.project;
    if confirmation != project.name {
        return Err("Gib den exakten Projektnamen als Bestätigung ein.".into());
    }
    let outcome = persistence.database.delete_project_records(&project_id)?;
    remove_orphaned_blobs(&persistence, outcome.orphaned_hashes)?;
    persistence.projects.delete(&project_id)
}

#[tauri::command]
fn library_store_result(
    request: StoreResultRequest,
    persistence: tauri::State<'_, Persistence>,
) -> Result<LibraryResult, String> {
    if request.project_id.is_empty() || request.node_id.is_empty() {
        return Err("Projekt- und Node-ID werden benötigt.".into());
    }
    if request.cost_microunits.is_some_and(|value| value < 0) {
        return Err("Kosten dürfen nicht negativ sein.".into());
    }
    let run_id = match request.run_id.as_deref() {
        Some(candidate) => {
            Uuid::parse_str(candidate).map_err(|_| "Ungültige Lauf-ID.".to_string())?;
            if let Some((project_id, node_id)) = persistence.database.run_target(candidate)? {
                if project_id != request.project_id || node_id != request.node_id {
                    return Err("Die Lauf-ID gehört zu einer anderen Node.".into());
                }
            }
            candidate.to_owned()
        }
        None => Uuid::new_v4().to_string(),
    };
    let result_id = Uuid::new_v4().to_string();
    let asset_id = request
        .data_url
        .as_ref()
        .map(|_| Uuid::new_v4().to_string());
    let created_at = Utc::now().to_rfc3339();
    let model = request.model.as_deref().unwrap_or("local");
    // Cost is recorded as soon as the provider has completed, even if local blob persistence fails.
    persistence.database.record_provider_completion(
        &run_id,
        &request.project_id,
        &request.node_id,
        model,
        request.cost_microunits,
        &created_at,
    )?;
    let blob = if let Some(data_url) = request.data_url.as_deref() {
        let (media_type, bytes) = decode_image_data_url(data_url)?;
        let blob =
            persistence
                .blobs
                .import_bytes(&bytes, media_type, request.original_name.clone())?;
        persistence.database.upsert_blob(&blob)?;
        Some(blob)
    } else {
        None
    };
    if request.text.is_none() && blob.is_none() {
        return Err("Das Ergebnis enthält weder Text noch Bilddaten.".into());
    }
    let stored = persistence.database.attach_result(
        &result_id,
        &run_id,
        &request.project_id,
        &request.node_id,
        &request.kind,
        request.text.as_deref(),
        blob.as_ref(),
        asset_id.as_deref(),
        request.prompt.as_deref(),
        request.parameters.as_ref(),
        &created_at,
    )?;
    Ok(LibraryResult {
        stored,
        data_url: request.data_url,
        hydration_error: None,
    })
}

#[tauri::command]
fn library_project_results(
    project_id: String,
    persistence: tauri::State<'_, Persistence>,
) -> Result<Vec<LibraryResult>, String> {
    persistence
        .database
        .project_results(&project_id)?
        .into_iter()
        .map(|stored| {
            let (data_url, hydration_error) = match (
                stored.active,
                &stored.blob_hash,
                &stored.media_type,
            ) {
                (true, Some(hash), Some(media_type)) if media_type.starts_with("image/") => {
                    match persistence.blobs.read(hash) {
                        Ok(bytes) => (
                            Some(format!(
                                "data:{};base64,{}",
                                media_type,
                                BASE64.encode(bytes)
                            )),
                            None,
                        ),
                        Err(_) => (
                            None,
                            Some(
                                "Das aktive Bild ist im lokalen CAS beschädigt oder nicht lesbar."
                                    .into(),
                            ),
                        ),
                    }
                }
                _ => (None, None),
            };
            Ok(LibraryResult {
                stored,
                data_url,
                hydration_error,
            })
        })
        .collect()
}

#[tauri::command]
fn library_result_search(
    request: LibraryResultQuery,
    persistence: tauri::State<'_, Persistence>,
) -> Result<LibraryResultPage, String> {
    let normalize = |value: Option<String>, label: &str| -> Result<Option<String>, String> {
        let value = value
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        if value
            .as_ref()
            .is_some_and(|value| value.len() > 512 || value.chars().any(char::is_control))
        {
            return Err(format!("{label} ist ungültig."));
        }
        Ok(value)
    };
    if request.query.len() > 500 || request.query.chars().any(char::is_control) {
        return Err("Die History-Suche ist ungültig.".into());
    }
    let project_id = normalize(request.project_id, "Projekt-ID")?;
    let node_id = normalize(request.node_id, "Node-ID")?;
    let kind = normalize(request.kind, "Ergebnis-Typ")?;
    persistence.database.search_results(
        project_id.as_deref(),
        node_id.as_deref(),
        kind.as_deref(),
        &request.query,
        request.page,
        request.page_size,
    )
}

#[tauri::command]
fn library_result_contents(
    project_id: String,
    result_ids: Vec<String>,
    persistence: tauri::State<'_, Persistence>,
) -> Result<Vec<LibraryResultContent>, String> {
    if project_id.is_empty()
        || project_id.len() > 512
        || result_ids.is_empty()
        || result_ids.len() > 100
    {
        return Err("Batch-Inhalte benötigen ein Projekt und 1–100 Ergebnisse.".into());
    }
    let unique = result_ids.iter().collect::<std::collections::HashSet<_>>();
    if unique.len() != result_ids.len()
        || result_ids
            .iter()
            .any(|id| id.is_empty() || id.len() > 512 || id.chars().any(char::is_control))
    {
        return Err("Ergebnis-IDs müssen eindeutig und gültig sein.".into());
    }
    let contents = persistence
        .database
        .result_contents(&project_id, &result_ids)
        .map_err(|error| {
            if error.contains("Query returned no rows") {
                "Mindestens ein Ergebnis gehört nicht zu diesem Projekt.".into()
            } else {
                error
            }
        })?;
    Ok(contents
        .into_iter()
        .map(|content| {
            let media_url = content
                .blob_hash
                .as_ref()
                .map(|hash| format!("flowz-media://localhost/{hash}"));
            LibraryResultContent {
                result_id: content.result_id,
                text_value: content.text_value,
                blob_hash: content.blob_hash,
                media_type: content.media_type,
                media_url,
            }
        })
        .collect())
}

#[tauri::command]
fn library_orphan_results(
    project_id: String,
    persistence: tauri::State<'_, Persistence>,
) -> Result<Vec<LibraryResult>, String> {
    library_orphan_results_inner(&project_id, &persistence)
}

fn library_orphan_results_inner(
    project_id: &str,
    persistence: &Persistence,
) -> Result<Vec<LibraryResult>, String> {
    let project = persistence.projects.open(project_id)?.project;
    let node_ids = project
        .graph
        .nodes
        .iter()
        .map(|node| node.id.as_str())
        .collect::<std::collections::HashSet<_>>();
    let database_results = persistence.database.project_results(project_id)?;
    let database_ids = database_results
        .iter()
        .map(|item| item.result_id.clone())
        .collect::<std::collections::HashSet<_>>();
    let mut results = database_results
        .into_iter()
        .filter(|result| {
            !node_ids.contains(result.node_id.as_str())
                || result
                    .parameters
                    .as_ref()
                    .and_then(|value| value.get("orphaned"))
                    .and_then(Value::as_bool)
                    == Some(true)
        })
        .map(|stored| LibraryResult {
            stored,
            data_url: None,
            hydration_error: None,
        })
        .collect::<Vec<_>>();
    results.extend(
        persistence
            .emergency_outbox
            .project_results(project_id)?
            .into_iter()
            .filter(|item| !database_ids.contains(&item.result_id))
            .map(|item| LibraryResult {
                stored: StoredResult {
                    result_id: item.result_id,
                    run_id: item.run_id,
                    project_id: item.project_id,
                    node_id: item.node_id,
                    kind: item.kind,
                    text_value: Some(item.text),
                    blob_hash: None,
                    asset_id: None,
                    media_type: None,
                    created_at: item.created_at,
                    cost_microunits: item.cost_microunits,
                    model: Some(item.model),
                    prompt: None,
                    parameters: Some(item.parameters),
                    active: false,
                },
                data_url: None,
                hydration_error: None,
            }),
    );
    results.sort_by(|left, right| right.stored.created_at.cmp(&left.stored.created_at));
    Ok(results)
}

#[tauri::command]
fn library_reassign_result(
    project_id: String,
    result_id: String,
    node_id: String,
    persistence: tauri::State<'_, Persistence>,
) -> Result<(), String> {
    library_reassign_result_inner(&project_id, &result_id, &node_id, &persistence)
}

fn library_reassign_result_inner(
    project_id: &str,
    result_id: &str,
    node_id: &str,
    persistence: &Persistence,
) -> Result<(), String> {
    let project = persistence.projects.open(project_id)?.project;
    if !project
        .graph
        .nodes
        .iter()
        .any(|node| node.id == node_id && node.module_id == "core.text-input")
    {
        return Err("Die Wiederherstellungs-Node ist nicht verfügbar.".into());
    }
    if let Some(emergency) = persistence.emergency_outbox.find(result_id)? {
        if emergency.project_id != project_id {
            return Err("Das Notfallergebnis gehört nicht zu diesem Projekt.".into());
        }
        let mut parameters = emergency.parameters;
        parameters["orphaned"] = Value::Bool(false);
        parameters["recoveredAsNodeId"] = Value::String(node_id.to_owned());
        persistence.database.record_provider_text_result_atomic(
            &emergency.result_id,
            &emergency.run_id,
            &emergency.project_id,
            node_id,
            &emergency.model,
            &emergency.kind,
            &emergency.text,
            Some(&parameters),
            emergency.cost_microunits,
            &emergency.created_at,
            false,
        )?;
        persistence
            .database
            .set_active_result(project_id, node_id, result_id)?;
        // SQLite is now authoritative. A rare filesystem cleanup failure must not
        // make the UI delete the successfully restored target node; duplicate
        // outbox entries are suppressed by result id and pruned later.
        let _ = persistence.emergency_outbox.remove(result_id);
        return Ok(());
    }
    persistence
        .database
        .reassign_result(project_id, result_id, node_id)
}

#[tauri::command]
fn library_result_data(
    project_id: String,
    result_id: String,
    persistence: tauri::State<'_, Persistence>,
) -> Result<Option<String>, String> {
    let stored = persistence
        .database
        .project_results(&project_id)?
        .into_iter()
        .find(|result| result.result_id == result_id)
        .ok_or_else(|| "Das Bibliotheksergebnis gehört nicht zu diesem Projekt.".to_string())?;
    match (stored.blob_hash, stored.media_type) {
        (Some(hash), Some(media_type))
            if media_type.starts_with("video/") || media_type.starts_with("audio/") =>
        {
            Ok(Some(format!("flowz-media://localhost/{hash}")))
        }
        (Some(hash), Some(media_type)) => Ok(Some(format!(
            "data:{media_type};base64,{}",
            BASE64.encode(persistence.blobs.read(&hash)?)
        ))),
        _ => Ok(None),
    }
}

#[tauri::command]
fn library_set_active_result(
    project_id: String,
    node_id: String,
    result_id: String,
    persistence: tauri::State<'_, Persistence>,
) -> Result<(), String> {
    persistence
        .database
        .set_active_result(&project_id, &node_id, &result_id)
}

#[tauri::command]
fn library_asset_save(
    request: SaveLibraryAssetRequest,
    persistence: tauri::State<'_, Persistence>,
) -> Result<LibraryAssetSummary, String> {
    if request
        .text
        .as_ref()
        .is_some_and(|value| value.len() > 1_000_000)
    {
        return Err("Text-Assets sind auf 1 MB begrenzt.".into());
    }
    let (blob, thumbnail_blob) = if let Some(data_url) = request.data_url.as_deref() {
        let (media_type, bytes) = decode_image_data_url(data_url)?;
        let blob = persistence
            .blobs
            .import_bytes(&bytes, media_type, request.original_name)?;
        persistence.database.upsert_blob(&blob)?;
        let thumbnail = create_asset_thumbnail(&bytes)
            .ok()
            .map(|thumbnail| {
                persistence.blobs.import_bytes(
                    &thumbnail,
                    "image/png".into(),
                    Some("flowz-thumbnail.png".into()),
                )
            })
            .transpose()?;
        if let Some(thumbnail) = thumbnail.as_ref() {
            persistence.database.upsert_blob(thumbnail)?;
        }
        (Some(blob), thumbnail)
    } else {
        (None, None)
    };
    let created_at = Utc::now().to_rfc3339();
    persistence.database.create_library_asset(
        &Uuid::new_v4().to_string(),
        &Uuid::new_v4().to_string(),
        &request.name,
        &request.kind,
        request.text.as_deref(),
        blob.as_ref(),
        thumbnail_blob.as_ref(),
        request.source_project_id.as_deref(),
        request.source_node_id.as_deref(),
        request.source_result_id.as_deref(),
        &created_at,
    )
}

#[tauri::command]
fn library_asset_thumbnail(
    version_id: String,
    persistence: tauri::State<'_, Persistence>,
) -> Result<Option<String>, String> {
    let thumbnail =
        if let Some(thumbnail) = persistence.database.library_asset_thumbnail(&version_id)? {
            Some(thumbnail)
        } else {
            // Only the cache-miss path is serialized. Re-read after acquiring the lock:
            // another request may have completed the persistent backfill meanwhile.
            let _guard = ASSET_THUMBNAIL_BACKFILL_LOCK.lock().map_err(|_| {
                "Die Vorschaubild-Erzeugung ist vorübergehend nicht verfügbar.".to_string()
            })?;
            if let Some(thumbnail) = persistence.database.library_asset_thumbnail(&version_id)? {
                Some(thumbnail)
            } else {
                // Backfill raster assets created before schema v5 without ever sending the
                // original image through the palette IPC path.
                let content = persistence.database.library_asset_content(&version_id)?;
                let Some(original_hash) = content.blob_hash else {
                    return Ok(None);
                };
                let bytes = persistence.blobs.read(&original_hash)?;
                let Ok(encoded) = create_asset_thumbnail(&bytes) else {
                    return Ok(None);
                };
                let blob = persistence.blobs.import_bytes(
                    &encoded,
                    "image/png".into(),
                    Some("flowz-thumbnail.png".into()),
                )?;
                persistence.database.upsert_blob(&blob)?;
                let canonical = persistence
                    .database
                    .set_library_asset_thumbnail(&version_id, &blob.hash)?;
                Some(canonical)
            }
        };
    let Some((hash, media_type)) = thumbnail else {
        return Ok(None);
    };
    Ok(Some(format!(
        "data:{media_type};base64,{}",
        BASE64.encode(persistence.blobs.read(&hash)?)
    )))
}

#[tauri::command]
fn library_asset_search(
    query: String,
    kind: Option<String>,
    page: i64,
    page_size: i64,
    persistence: tauri::State<'_, Persistence>,
) -> Result<LibraryAssetPage, String> {
    persistence
        .database
        .search_library_assets(&query, kind.as_deref(), page, page_size)
}

#[tauri::command]
fn library_asset_content(
    version_id: String,
    persistence: tauri::State<'_, Persistence>,
) -> Result<LibraryAssetPayload, String> {
    let content = persistence.database.library_asset_content(&version_id)?;
    let data_url = match (&content.blob_hash, &content.summary.media_type) {
        (Some(hash), Some(media_type)) => Some(format!(
            "data:{media_type};base64,{}",
            BASE64.encode(persistence.blobs.read(hash)?)
        )),
        _ => None,
    };
    Ok(LibraryAssetPayload {
        summary: content.summary,
        text: content.text_value,
        data_url,
        blob_hash: content.blob_hash,
    })
}

#[tauri::command]
fn library_asset_reference(
    version_id: String,
    persistence: tauri::State<'_, Persistence>,
) -> Result<LibraryAssetReference, String> {
    let content = persistence.database.library_asset_content(&version_id)?;
    Ok(LibraryAssetReference {
        version_id,
        blob_hash: content.blob_hash,
        media_type: content.summary.media_type,
    })
}

#[tauri::command]
fn library_asset_contents(
    version_ids: Vec<String>,
    persistence: tauri::State<'_, Persistence>,
) -> Result<Vec<LibraryAssetPayload>, String> {
    persistence
        .database
        .library_asset_contents(&version_ids)?
        .into_iter()
        .map(|content| {
            let data_url = match (&content.blob_hash, &content.summary.media_type) {
                (Some(hash), Some(media_type)) => Some(format!(
                    "data:{media_type};base64,{}",
                    BASE64.encode(persistence.blobs.read(hash)?)
                )),
                _ => None,
            };
            Ok(LibraryAssetPayload {
                summary: content.summary,
                text: content.text_value,
                data_url,
                blob_hash: content.blob_hash,
            })
        })
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .register_uri_scheme_protocol("flowz-media", |context, request| {
            let persistence = context.app_handle().state::<Persistence>();
            media_protocol_response(&request, &persistence)
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_webview_event(|webview, event| {
            if let tauri::WebviewEvent::DragDrop(tauri::DragDropEvent::Drop { paths, position }) =
                event
            {
                let mut token = None;
                if paths.len() == 1 {
                    if let Ok(path) = std::fs::canonicalize(&paths[0]) {
                        let value = Uuid::new_v4().to_string();
                        if let Ok(mut registry) = webview.state::<DropGrantRegistry>().0.lock() {
                            registry.retain(|_, grant| {
                                grant.created_at.elapsed() < Duration::from_secs(20)
                            });
                            registry.insert(
                                value.clone(),
                                DropGrant {
                                    path,
                                    webview_label: webview.label().into(),
                                    created_at: Instant::now(),
                                },
                            );
                            token = Some(value);
                        }
                    }
                }
                let _ = webview.emit(
                    "flowz-media-drop",
                    MediaDropEvent {
                        token,
                        path_count: paths.len(),
                        x: position.x,
                        y: position.y,
                    },
                );
            }
        })
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            let recordings = recording::RecordingSessionRegistry::initialize(&app_data_dir)
                .map_err(|error| std::io::Error::other(format!("FlowZ recording: {error}")))?;
            let persistence = Persistence::initialize(&app_data_dir)
                .map_err(|error| std::io::Error::other(format!("FlowZ persistence: {error}")))?;
            let stages = MediaStageRegistry::initialize(&app_data_dir, &persistence)
                .map_err(|error| std::io::Error::other(format!("FlowZ media stages: {error}")))?;
            let fal = fal_provider::FalProviderState::initialize(&app_data_dir)
                .map_err(|error| std::io::Error::other(format!("FlowZ fal.ai: {error}")))?;
            let fal_images = fal_image::FalImageState::initialize(&app_data_dir)
                .map_err(|error| std::io::Error::other(format!("FlowZ fal.ai images: {error}")))?;
            let periodic_recordings = recordings.clone();
            let periodic_stages = stages.clone();
            let periodic_persistence = persistence.clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(60));
                loop {
                    interval.tick().await;
                    periodic_recordings.prune_expired();
                    prune_expired_media_stages(&periodic_stages, &periodic_persistence);
                }
            });
            app.manage(persistence.clone());
            app.manage(TranscriptionRunRegistry::default());
            app.manage(DropGrantRegistry::default());
            app.manage(stages);
            app.manage(MediaCancelRegistry::default());
            app.manage(recordings);
            app.manage(fal);
            app.manage(fal_images);
            app.manage(artboard_agent::CodexAppServerState::new(
                app_data_dir.clone(),
            ));
            app.manage(artboard_agent::OpenRouterArtboardState::default());
            app.manage(artboard_agent::AgentRepositoryState::new(&app_data_dir));
            app.manage(
                export::ExportGrantStore::initialize(&app_data_dir).map_err(|error| {
                    std::io::Error::other(format!("FlowZ export grants: {error}"))
                })?,
            );
            app.manage(
                brand::BrandState::initialize(app_data_dir.clone(), &persistence)
                    .map_err(std::io::Error::other)?,
            );
            app.manage(
                fal_image_tools::FalImageToolState::initialize(&app_data_dir).map_err(|error| {
                    std::io::Error::other(format!("FlowZ fal.ai image tools: {error}"))
                })?,
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            save_openrouter_key,
            openrouter_key_status,
            delete_openrouter_key,
            artboard_agent::codex_agent_start,
            artboard_agent::codex_agent_request,
            artboard_agent::codex_agent_respond,
            artboard_agent::codex_agent_scratch,
            artboard_agent::codex_agent_close,
            artboard_agent::openrouter_artboard_step,
            artboard_agent::openrouter_artboard_cancel,
            artboard_agent::artboard_agent_session_find,
            artboard_agent::artboard_agent_session_save,
            artboard_agent::artboard_agent_run_find_latest,
            artboard_agent::artboard_agent_run_save,
            artboard_agent::artboard_agent_usage_save,
            artboard_agent::artboard_agent_proposal_find,
            artboard_agent::artboard_agent_proposal_save,
            artboard_agent::artboard_agent_proposal_delete,
            fal_provider::save_fal_key,
            fal_provider::fal_key_status,
            fal_provider::delete_fal_key,
            fal_provider::fal_upload_cache_status,
            fal_provider::fal_upload_cache_clear,
            fal_provider::fal_video_start,
            fal_provider::fal_video_resume,
            fal_provider::fal_pending_runs,
            fal_provider::fal_cancel_run,
            fal_provider::extract_video_frame_result,
            fal_image::fal_image_start,
            fal_image::fal_image_resume,
            fal_image::fal_image_completed,
            fal_image::fal_image_pending,
            fal_image::fal_image_cancel,
            fal_image_tools::fal_image_tool_start,
            fal_image_tools::fal_image_tool_resume,
            fal_image_tools::fal_image_tool_pending,
            fal_image_tools::fal_image_tool_cancel,
            image_transform::transform_image,
            image_trim::trim_transparent_image,
            list_models,
            run_chat,
            store_paid_brand_result,
            brand::brand_check_domains,
            brand::brand_prepare_font,
            brand::brand_preview_font,
            brand::brand_font_cache_list,
            brand::brand_font_cache_delete,
            run_transcription,
            cancel_transcription_run,
            project_create,
            project_list,
            project_open,
            project_save,
            document_catalog_list,
            document_flow_cover_source,
            document_cover_commit,
            document_catalog_create,
            document_catalog_rename,
            document_catalog_duplicate,
            document_catalog_delete,
            artboard_workspace_create,
            artboard_workspace_open,
            artboard_revision_open,
            artboard_apply_operations,
            artboard_branch_create,
            artboard_move_head,
            artboard_register_input_snapshot,
            artboard_composite::artboard_composites_persist,
            blob_pick_import,
            recording_begin,
            recording_append,
            recording_finish,
            recording_abort,
            media_pick_stage,
            media_drop_stage,
            media_finalize_stage,
            media_pending_stages,
            media_cancel_stage,
            media_cancel_import,
            export::export_pick_folder,
            export::export_write,
            export::export_reveal,
            export::artboard_export_pick_folder,
            export::artboard_export_write,
            export::artboard_export_reveal,
            library_get_usage,
            library_storage_breakdown,
            library_project_costs,
            fal_empirical_cost_estimate,
            library_delete_result,
            library_clear_node_history,
            library_delete_project,
            library_store_result,
            library_project_results,
            library_result_search,
            library_result_contents,
            library_orphan_results,
            library_reassign_result,
            library_result_data,
            library_set_active_result,
            library_asset_save,
            library_asset_search,
            library_asset_thumbnail,
            library_asset_content,
            library_asset_reference,
            library_asset_contents,
            web_context::save_brave_search_key,
            web_context::brave_search_key_status,
            web_context::delete_brave_search_key,
            web_context::fetch_webpage,
            web_context::run_web_research
        ])
        .run(tauri::generate_context!())
        .expect("error while running FlowZ");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_test_wav(path: &std::path::Path) {
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
        std::fs::write(path, wav).unwrap();
    }

    #[test]
    fn transcription_catalog_rejects_chat_tts_and_malformed_models() {
        let mut catalog = json!({"data":[
            {"id":"stt","architecture":{"input_modalities":["audio"],"output_modalities":["transcription"]}},
            {"id":"openai/whisper-1","architecture":{"input_modalities":["audio"],"output_modalities":["transcription"]}},
            {"id":"chat","architecture":{"input_modalities":["audio"],"output_modalities":["text"]}},
            {"id":"tts","architecture":{"input_modalities":["text"],"output_modalities":["audio"]}},
            {"id":"broken"}
        ]});
        filter_model_catalog("transcription", &mut catalog);
        let ids = catalog["data"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|model| model["id"].as_str())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["stt", "openai/whisper-1"]);
        assert_eq!(catalog["data"][1]["flowz_capabilities"]["timestamps"], true);
    }

    #[test]
    fn transcription_cancel_before_command_entry_is_sticky_and_duplicate_runs_are_rejected() {
        let registry = TranscriptionRunRegistry::default();
        let run_id = Uuid::new_v4().to_string();
        assert!(registry.cancel(&run_id));
        let token = registry.start(&run_id).unwrap();
        assert!(token.is_cancelled());
        assert!(registry.start(&run_id).is_err());
        registry.remove(&run_id);
        assert!(!registry.start(&run_id).unwrap().is_cancelled());
    }

    #[test]
    fn direct_media_project_result_is_collected_as_protected_history() {
        let temp = tempfile::tempdir().unwrap();
        let persistence = Persistence::initialize(temp.path()).unwrap();
        let mut project = persistence
            .projects
            .create(CreateProjectRequest {
                name: "Protected".into(),
            })
            .unwrap()
            .project;
        project.graph.nodes = serde_json::from_value(json!([{
            "id": "image-node",
            "moduleId": "ai.image-generation",
            "moduleVersion": 1,
            "position": { "x": 0.0, "y": 0.0 },
            "config": {
                "directMedia": {
                    "schemaVersion": 1,
                    "kind": "image",
                    "blobHash": "a".repeat(64),
                    "mediaType": "image/png",
                    "priority": "fallback",
                    "source": { "kind": "project-result", "projectId": project.id.clone(), "projectRevision": 7, "resultId": "bound-result" }
                },
                "collectionResultIds": ["collection-result"]
            },
            "updatePolicy": "manual"
        }])).unwrap();
        let protected = project_protected_result_ids(&project);
        assert!(protected.contains("bound-result"));
        assert!(protected.contains("collection-result"));
    }
    #[test]
    fn emergency_paid_transcript_is_visible_and_recoverable_after_sqlite_failure() {
        let temp = tempfile::tempdir().unwrap();
        let persistence = Persistence::initialize(temp.path()).unwrap();
        let mut project = persistence
            .projects
            .create(CreateProjectRequest {
                name: "Outbox".into(),
            })
            .unwrap();
        project.project.graph.nodes = serde_json::from_value(json!([{ "id": "recovered", "moduleId": "core.text-input", "moduleVersion": 1, "position": { "x": 0.0, "y": 0.0 }, "config": {"text":""}, "updatePolicy": "manual" }])).unwrap();
        let project = persistence
            .projects
            .save(SaveProjectRequest {
                expected_updated_at: project.project.updated_at,
                expected_revision: project.revision,
                project: project.project,
            })
            .unwrap();
        persistence
            .database
            .upsert_project(&project.project)
            .unwrap();
        let emergency = EmergencyTextResult {
            version: 1,
            result_id: Uuid::new_v4().to_string(),
            run_id: Uuid::new_v4().to_string(),
            project_id: project.project.id.clone(),
            node_id: "deleted-stt".into(),
            model: "openai/whisper-1".into(),
            kind: "transcription".into(),
            text: "Bezahltes Notfalltranskript".into(),
            parameters: json!({
                "orphaned": true,
                "emergencyOutbox": true,
                "sourceNodeId": "audio",
                "timestampData": {"segments":[{"start":0.0,"end":1.0,"text":"Bezahltes Notfalltranskript"}],"words":[]}
            }),
            cost_microunits: Some(200),
            created_at: Utc::now().to_rfc3339(),
        };
        // This is the branch taken after the atomic SQLite transaction has failed.
        persistence.emergency_outbox.store(&emergency).unwrap();
        let visible = library_orphan_results_inner(&project.project.id, &persistence).unwrap();
        assert_eq!(visible.len(), 1);
        assert_eq!(
            visible[0].stored.text_value.as_deref(),
            Some(emergency.text.as_str())
        );
        assert_eq!(visible[0].stored.cost_microunits, Some(200));
        assert!(visible[0].stored.parameters.as_ref().unwrap()["timestampData"].is_object());

        library_reassign_result_inner(
            &project.project.id,
            &emergency.result_id,
            "recovered",
            &persistence,
        )
        .unwrap();
        assert!(persistence
            .emergency_outbox
            .find(&emergency.result_id)
            .unwrap()
            .is_none());
        let stored = persistence
            .database
            .project_results(&project.project.id)
            .unwrap();
        assert_eq!(
            stored[0].text_value.as_deref(),
            Some(emergency.text.as_str())
        );
        assert_eq!(stored[0].cost_microunits, Some(200));
        assert!(stored[0].active);
    }

    #[test]
    fn media_ranges_are_single_bounded_intervals() {
        assert_eq!(parse_single_range("bytes=10-19", 100), Some((10, 19)));
        assert_eq!(parse_single_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(parse_single_range("bytes=90-", 100), Some((90, 99)));
        assert_eq!(parse_single_range("bytes=100-", 100), None);
        assert_eq!(parse_single_range("bytes=0-1,4-5", 100), None);
    }

    #[test]
    fn drop_grants_are_one_time_expiring_and_webview_bound() {
        let grants = DropGrantRegistry::default();
        let path = PathBuf::from("/tmp/example.mp4");
        grants.0.lock().unwrap().insert(
            "one".into(),
            DropGrant {
                path: path.clone(),
                webview_label: "main".into(),
                created_at: Instant::now(),
            },
        );
        assert_eq!(consume_drop_grant(&grants, "one", "main").unwrap(), path);
        assert!(consume_drop_grant(&grants, "one", "main").is_err());
        grants.0.lock().unwrap().insert(
            "wrong-view".into(),
            DropGrant {
                path: PathBuf::from("/tmp/view.mp4"),
                webview_label: "main".into(),
                created_at: Instant::now(),
            },
        );
        assert!(consume_drop_grant(&grants, "wrong-view", "other").is_err());
        grants.0.lock().unwrap().insert(
            "expired".into(),
            DropGrant {
                path: PathBuf::from("/tmp/old.mp4"),
                webview_label: "main".into(),
                created_at: Instant::now() - Duration::from_secs(21),
            },
        );
        assert!(consume_drop_grant(&grants, "expired", "main").is_err());
    }

    #[test]
    fn media_cancellation_ids_are_validated_and_collision_safe() {
        let registry = MediaCancelRegistry::default();
        assert!(register_media_cancellation(&registry, "not-a-uuid").is_err());
        let id = Uuid::new_v4().to_string();
        let first = register_media_cancellation(&registry, &id).unwrap();
        assert!(!first.load(std::sync::atomic::Ordering::Relaxed));
        assert!(register_media_cancellation(&registry, &id).is_err());
    }

    #[test]
    fn staged_media_is_cleaned_on_revision_change_cancel_and_database_failure() {
        let temp = tempfile::tempdir().unwrap();
        let persistence = Persistence::initialize(temp.path()).unwrap();
        let mut created = persistence
            .projects
            .create(CreateProjectRequest {
                name: "Stage races".into(),
            })
            .unwrap();
        created.project.graph.nodes = serde_json::from_value(json!([{ "id": "audio", "moduleId": "core.audio-input", "moduleVersion": 1, "position": { "x": 0.0, "y": 0.0 }, "config": {}, "updatePolicy": "manual" }])).unwrap();
        let saved = persistence
            .projects
            .save(SaveProjectRequest {
                expected_updated_at: created.project.updated_at,
                expected_revision: created.revision,
                project: created.project,
            })
            .unwrap();
        persistence.database.upsert_project(&saved.project).unwrap();
        let source = temp.path().join("stage.wav");
        write_test_wav(&source);
        let stages = MediaStageRegistry::default();
        let imported = stage_media_path(
            source.clone(),
            Some("stage.wav".into()),
            "audio",
            &saved.project.id,
            "audio",
            saved.revision,
            None,
            "picker",
            &persistence,
            &stages,
            &AtomicBool::new(false),
        )
        .unwrap();
        let stage_id = imported.stage_id.clone().unwrap();
        let mut changed_project = saved.project.clone();
        changed_project.graph.nodes[0].module_id = "core.text-input".into();
        let changed = persistence
            .projects
            .save(SaveProjectRequest {
                expected_updated_at: saved.project.updated_at,
                expected_revision: saved.revision,
                project: changed_project,
            })
            .unwrap();
        persistence
            .database
            .upsert_project(&changed.project)
            .unwrap();
        assert!(finalize_media_stage_inner(
            &stage_id,
            &changed.project.id,
            "audio",
            "audio",
            &stages,
            &persistence
        )
        .is_err());
        assert!(persistence.blobs.metadata(&imported.hash).is_ok());
        cancel_media_stage_inner(&stage_id, &stages, &persistence).unwrap();
        assert!(persistence.blobs.metadata(&imported.hash).is_err());

        let mut restored = changed.project.clone();
        restored.graph.nodes[0].module_id = "core.audio-input".into();
        let restored = persistence
            .projects
            .save(SaveProjectRequest {
                expected_updated_at: changed.project.updated_at,
                expected_revision: changed.revision,
                project: restored,
            })
            .unwrap();
        let cancelled = stage_media_path(
            source.clone(),
            Some("cancel.wav".into()),
            "audio",
            &restored.project.id,
            "audio",
            restored.revision,
            None,
            "picker",
            &persistence,
            &stages,
            &AtomicBool::new(false),
        )
        .unwrap();
        cancel_media_stage_inner(
            cancelled.stage_id.as_deref().unwrap(),
            &stages,
            &persistence,
        )
        .unwrap();
        assert!(persistence.blobs.metadata(&cancelled.hash).is_err());

        let expired = stage_media_path(
            source.clone(),
            Some("expired.wav".into()),
            "audio",
            &restored.project.id,
            "audio",
            restored.revision,
            None,
            "picker",
            &persistence,
            &stages,
            &AtomicBool::new(false),
        )
        .unwrap();
        stages
            .items
            .lock()
            .unwrap()
            .get_mut(expired.stage_id.as_deref().unwrap())
            .unwrap()
            .created_at = Instant::now() - Duration::from_secs(121);
        prune_expired_media_stages(&stages, &persistence);
        assert!(persistence.blobs.metadata(&expired.hash).is_err());

        persistence
            .database
            .upsert_project(&restored.project)
            .unwrap();
        let committed = stage_media_path(
            source.clone(),
            Some("commit.wav".into()),
            "audio",
            &restored.project.id,
            "audio",
            restored.revision,
            None,
            "picker",
            &persistence,
            &stages,
            &AtomicBool::new(false),
        )
        .unwrap();
        let committed_stage_id = committed.stage_id.clone().unwrap();
        let durable = finalize_media_stage_inner(
            &committed_stage_id,
            &restored.project.id,
            "audio",
            "audio",
            &stages,
            &persistence,
        )
        .unwrap();
        assert!(durable.result_id.is_some());
        assert!(finalize_media_stage_inner(
            &committed_stage_id,
            &restored.project.id,
            "audio",
            "audio",
            &stages,
            &persistence
        )
        .is_err());
        assert!(persistence.blobs.metadata(&durable.hash).is_ok());

        // No matching projects row: record_media_import fails its FK transaction;
        // the staged CAS object must still be removed.
        let isolated_root = temp.path().join("isolated");
        let isolated = Persistence::initialize(&isolated_root).unwrap();
        let mut project = isolated
            .projects
            .create(CreateProjectRequest {
                name: "DB failure".into(),
            })
            .unwrap();
        project.project.graph.nodes = serde_json::from_value(json!([{ "id": "audio", "moduleId": "core.audio-input", "moduleVersion": 1, "position": { "x": 0.0, "y": 0.0 }, "config": {}, "updatePolicy": "manual" }])).unwrap();
        let project = isolated
            .projects
            .save(SaveProjectRequest {
                expected_updated_at: project.project.updated_at,
                expected_revision: project.revision,
                project: project.project,
            })
            .unwrap();
        let failure_stages = MediaStageRegistry::default();
        let failed = stage_media_path(
            source,
            Some("failure.wav".into()),
            "audio",
            &project.project.id,
            "audio",
            project.revision,
            None,
            "picker",
            &isolated,
            &failure_stages,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert!(finalize_media_stage_inner(
            failed.stage_id.as_deref().unwrap(),
            &project.project.id,
            "audio",
            "audio",
            &failure_stages,
            &isolated
        )
        .is_err());
        assert!(isolated.blobs.metadata(&failed.hash).is_ok());
        cancel_media_stage_inner(
            failed.stage_id.as_deref().unwrap(),
            &failure_stages,
            &isolated,
        )
        .unwrap();
        assert!(isolated.blobs.metadata(&failed.hash).is_err());
    }

    #[test]
    fn recording_stage_manifest_survives_restart_and_expires_or_finalizes_cleanly() {
        let temp = tempfile::tempdir().unwrap();
        let persistence = Persistence::initialize(temp.path()).unwrap();
        let mut project = persistence
            .projects
            .create(CreateProjectRequest {
                name: "Recovery".into(),
            })
            .unwrap();
        project.project.graph.nodes = serde_json::from_value(json!([{ "id": "audio", "moduleId": "core.audio-input", "moduleVersion": 1, "position": { "x": 0.0, "y": 0.0 }, "config": {}, "updatePolicy": "manual" }])).unwrap();
        let project = persistence
            .projects
            .save(SaveProjectRequest {
                expected_updated_at: project.project.updated_at,
                expected_revision: project.revision,
                project: project.project,
            })
            .unwrap();
        persistence
            .database
            .upsert_project(&project.project)
            .unwrap();
        let grant = persistence
            .projects
            .media_target_grant(&project.project.id, "audio", "core.audio-input")
            .unwrap();
        let source = temp.path().join("recovery.wav");
        write_test_wav(&source);
        let stages = MediaStageRegistry::initialize(temp.path(), &persistence).unwrap();
        let staged = stage_media_path(
            source.clone(),
            Some("recovery.wav".into()),
            "audio",
            &project.project.id,
            "audio",
            0,
            Some(grant.clone()),
            "recording",
            &persistence,
            &stages,
            &AtomicBool::new(false),
        )
        .unwrap();
        let stage_id = staged.stage_id.clone().unwrap();
        let manifest = temp
            .path()
            .join("media-stages")
            .join(format!("{stage_id}.json"));
        assert!(manifest.is_file());
        drop(stages);
        drop(persistence);

        let reopened = Persistence::initialize(temp.path()).unwrap();
        assert!(reopened.blobs.metadata(&staged.hash).is_ok());
        let recovered = MediaStageRegistry::initialize(temp.path(), &reopened).unwrap();
        assert!(recovered.items.lock().unwrap().contains_key(&stage_id));
        let finalized = finalize_media_stage_inner(
            &stage_id,
            &project.project.id,
            "audio",
            "audio",
            &recovered,
            &reopened,
        )
        .unwrap();
        assert!(finalized.result_id.is_some());
        assert!(!manifest.exists());

        let discarded_source = temp.path().join("discarded-recovery.wav");
        let mut discarded_bytes = std::fs::read(&source).unwrap();
        *discarded_bytes.last_mut().unwrap() ^= 2;
        std::fs::write(&discarded_source, discarded_bytes).unwrap();
        let discarded = stage_media_path(
            discarded_source,
            Some("discarded-recovery.wav".into()),
            "audio",
            &project.project.id,
            "audio",
            0,
            Some(grant.clone()),
            "recording",
            &reopened,
            &recovered,
            &AtomicBool::new(false),
        )
        .unwrap();
        let discarded_id = discarded.stage_id.clone().unwrap();
        let discarded_manifest = temp
            .path()
            .join("media-stages")
            .join(format!("{discarded_id}.json"));
        drop(recovered);
        drop(reopened);
        let reopened = Persistence::initialize(temp.path()).unwrap();
        let recovered = MediaStageRegistry::initialize(temp.path(), &reopened).unwrap();
        cancel_media_stage_inner(&discarded_id, &recovered, &reopened).unwrap();
        assert!(!discarded_manifest.exists());
        assert!(reopened.blobs.metadata(&discarded.hash).is_err());

        let expired_source = temp.path().join("expired-recovery.wav");
        let mut expired_bytes = std::fs::read(&source).unwrap();
        *expired_bytes.last_mut().unwrap() ^= 1;
        std::fs::write(&expired_source, expired_bytes).unwrap();
        let expiring = stage_media_path(
            expired_source,
            Some("expired-recovery.wav".into()),
            "audio",
            &project.project.id,
            "audio",
            0,
            Some(grant),
            "recording",
            &reopened,
            &recovered,
            &AtomicBool::new(false),
        )
        .unwrap();
        let expiring_id = expiring.stage_id.clone().unwrap();
        let expiring_manifest = temp
            .path()
            .join("media-stages")
            .join(format!("{expiring_id}.json"));
        let mut value: Value =
            serde_json::from_slice(&std::fs::read(&expiring_manifest).unwrap()).unwrap();
        value["createdAt"] = Value::String((Utc::now() - chrono::Duration::hours(3)).to_rfc3339());
        std::fs::write(&expiring_manifest, serde_json::to_vec(&value).unwrap()).unwrap();
        drop(recovered);
        drop(reopened);
        let reopened = Persistence::initialize(temp.path()).unwrap();
        let recovered = MediaStageRegistry::initialize(temp.path(), &reopened).unwrap();
        assert!(!recovered.items.lock().unwrap().contains_key(&expiring_id));
        assert!(!expiring_manifest.exists());
        assert!(reopened.blobs.metadata(&expiring.hash).is_err());

        let temporary_source = temp.path().join("temporary-recovery.wav");
        let mut temporary_bytes = std::fs::read(&source).unwrap();
        *temporary_bytes.last_mut().unwrap() ^= 4;
        std::fs::write(&temporary_source, temporary_bytes).unwrap();
        let temporary = stage_media_path(
            temporary_source,
            Some("temporary-recovery.wav".into()),
            "audio",
            &project.project.id,
            "audio",
            0,
            Some(
                reopened
                    .projects
                    .media_target_grant(&project.project.id, "audio", "core.audio-input")
                    .unwrap(),
            ),
            "recording",
            &reopened,
            &recovered,
            &AtomicBool::new(false),
        )
        .unwrap();
        let temporary_id = temporary.stage_id.clone().unwrap();
        let completed_manifest = temp
            .path()
            .join("media-stages")
            .join(format!("{temporary_id}.json"));
        let abandoned_temporary = temp
            .path()
            .join("media-stages")
            .join(format!(".{temporary_id}.tmp"));
        std::fs::rename(&completed_manifest, &abandoned_temporary).unwrap();
        drop(recovered);
        drop(reopened);
        let reopened = Persistence::initialize(temp.path()).unwrap();
        let recovered = MediaStageRegistry::initialize(temp.path(), &reopened).unwrap();
        assert!(!abandoned_temporary.exists());
        assert!(reopened.blobs.metadata(&temporary.hash).is_err());
        assert!(!recovered.items.lock().unwrap().contains_key(&temporary_id));
    }

    #[test]
    fn media_protocol_enforces_hash_paths_ranges_and_security_headers() {
        let temp = tempfile::tempdir().unwrap();
        let persistence = Persistence::initialize(temp.path()).unwrap();
        let source = temp.path().join("clip.mp4");
        std::fs::write(&source, b"0123456789").unwrap();
        let blob = persistence
            .blobs
            .import(ImportBlobRequest {
                path: source,
                media_type: Some("video/mp4".into()),
                original_name: Some("clip.mp4".into()),
            })
            .unwrap();
        let request = |method: Method, path: &str, range: Option<&str>| {
            let mut builder = Request::builder()
                .method(method)
                .uri(format!("flowz-media://localhost/{path}"));
            if let Some(range) = range {
                builder = builder.header(header::RANGE, range);
            }
            builder.body(Vec::new()).unwrap()
        };
        let full = media_protocol_response(&request(Method::GET, &blob.hash, None), &persistence);
        assert_eq!(full.status(), StatusCode::OK);
        assert_eq!(full.body(), b"0123456789");
        assert_eq!(full.headers()[header::ACCEPT_RANGES], "bytes");
        assert_eq!(full.headers()["x-content-type-options"], "nosniff");
        let partial = media_protocol_response(
            &request(Method::GET, &blob.hash, Some("bytes=2-5")),
            &persistence,
        );
        assert_eq!(partial.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(partial.body(), b"2345");
        assert_eq!(partial.headers()[header::CONTENT_RANGE], "bytes 2-5/10");
        let head = media_protocol_response(&request(Method::HEAD, &blob.hash, None), &persistence);
        assert_eq!(head.status(), StatusCode::OK);
        assert!(head.body().is_empty());
        assert_eq!(head.headers()[header::CONTENT_LENGTH], "10");
        let ranged_head = media_protocol_response(
            &request(Method::HEAD, &blob.hash, Some("bytes=2-5")),
            &persistence,
        );
        assert_eq!(ranged_head.status(), StatusCode::PARTIAL_CONTENT);
        assert!(ranged_head.body().is_empty());
        assert_eq!(ranged_head.headers()[header::CONTENT_LENGTH], "4");
        assert_eq!(ranged_head.headers()[header::CONTENT_RANGE], "bytes 2-5/10");
        let unsatisfiable = media_protocol_response(
            &request(Method::GET, &blob.hash, Some("bytes=20-")),
            &persistence,
        );
        assert_eq!(unsatisfiable.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(unsatisfiable.headers()[header::CONTENT_RANGE], "bytes */10");
        assert_eq!(
            media_protocol_response(
                &request(Method::GET, &blob.hash, Some("garbage")),
                &persistence
            )
            .status(),
            StatusCode::RANGE_NOT_SATISFIABLE
        );
        let mut non_utf8 = request(Method::GET, &blob.hash, None);
        non_utf8.headers_mut().insert(
            header::RANGE,
            HeaderValue::from_bytes(b"bytes=\xff").unwrap(),
        );
        assert_eq!(
            media_protocol_response(&non_utf8, &persistence).status(),
            StatusCode::RANGE_NOT_SATISFIABLE
        );
        assert_eq!(
            media_protocol_response(
                &request(Method::GET, &format!("{}/extra", blob.hash), None),
                &persistence
            )
            .status(),
            StatusCode::BAD_REQUEST
        );
        let method =
            media_protocol_response(&request(Method::POST, &blob.hash, None), &persistence);
        assert_eq!(method.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(method.headers()[header::ALLOW], "GET, HEAD");
    }

    #[test]
    fn media_protocol_rejects_large_no_range_without_allocating_the_body() {
        let temp = tempfile::tempdir().unwrap();
        let persistence = Persistence::initialize(temp.path()).unwrap();
        let source = temp.path().join("large.mp4");
        std::fs::write(&source, vec![0_u8; 8 * 1024 * 1024 + 7]).unwrap();
        let blob = persistence
            .blobs
            .import(ImportBlobRequest {
                path: source,
                media_type: Some("video/mp4".into()),
                original_name: None,
            })
            .unwrap();
        let request = Request::builder()
            .method(Method::GET)
            .uri(format!("flowz-media://localhost/{}", blob.hash))
            .body(Vec::new())
            .unwrap();
        let response = media_protocol_response(&request, &persistence);
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert!(response.body().is_empty());
        assert!(!response.headers().contains_key(header::CONTENT_RANGE));
        assert_eq!(response.headers()["x-flowz-required-range"], "bytes");
        assert_eq!(
            response.headers()["x-flowz-media-size"],
            blob.size_bytes.to_string()
        );
        let head = Request::builder()
            .method(Method::HEAD)
            .uri(format!("flowz-media://localhost/{}", blob.hash))
            .body(Vec::new())
            .unwrap();
        let head = media_protocol_response(&head, &persistence);
        assert_eq!(head.status(), StatusCode::OK);
        assert!(head.body().is_empty());
        assert_eq!(
            head.headers()[header::CONTENT_LENGTH],
            blob.size_bytes.to_string()
        );
        let ranged = Request::builder()
            .method(Method::GET)
            .uri(format!("flowz-media://localhost/{}", blob.hash))
            .header(header::RANGE, format!("bytes=0-{}", blob.size_bytes - 1))
            .body(Vec::new())
            .unwrap();
        let ranged = media_protocol_response(&ranged, &persistence);
        assert_eq!(ranged.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(ranged.body().len(), 8 * 1024 * 1024);
        assert_eq!(
            ranged.headers()[header::CONTENT_RANGE],
            format!("bytes 0-8388607/{}", blob.size_bytes)
        );
    }

    #[test]
    fn media_protocol_uses_an_exact_mime_allowlist() {
        let temp = tempfile::tempdir().unwrap();
        let persistence = Persistence::initialize(temp.path()).unwrap();
        for (index, media_type) in [
            "video/mp4",
            "video/webm",
            "video/quicktime",
            "audio/mp4",
            "audio/webm",
            "audio/wav",
            "audio/flac",
            "audio/mpeg",
            "audio/ogg",
            "image/png",
            "image/jpeg",
            "image/webp",
        ]
        .into_iter()
        .enumerate()
        {
            let source = temp.path().join(format!("allowed-{index}"));
            std::fs::write(&source, [index as u8 + 1]).unwrap();
            let blob = persistence
                .blobs
                .import(ImportBlobRequest {
                    path: source,
                    media_type: Some(media_type.into()),
                    original_name: None,
                })
                .unwrap();
            let request = Request::builder()
                .method(Method::HEAD)
                .uri(format!("flowz-media://localhost/{}", blob.hash))
                .body(Vec::new())
                .unwrap();
            let response = media_protocol_response(&request, &persistence);
            assert_eq!(response.status(), StatusCode::OK, "{media_type}");
            assert_eq!(response.headers()[header::CONTENT_TYPE], media_type);
        }
        let png_source = temp.path().join("cover-cache-key.png");
        std::fs::write(&png_source, b"bounded-cover").unwrap();
        let png = persistence
            .blobs
            .import(ImportBlobRequest {
                path: png_source,
                media_type: Some("image/png".into()),
                original_name: Some("cover.png".into()),
            })
            .unwrap();
        let request = Request::builder()
            .method(Method::GET)
            .uri(format!(
                "flowz-media://localhost/{}?cover=revision-fingerprint",
                png.hash
            ))
            .body(Vec::new())
            .unwrap();
        let response = media_protocol_response(&request, &persistence);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body(), b"bounded-cover");
        let source = temp.path().join("forbidden");
        std::fs::write(&source, b"forbidden").unwrap();
        let blob = persistence
            .blobs
            .import(ImportBlobRequest {
                path: source,
                media_type: Some("video/mp4; charset=utf-8".into()),
                original_name: None,
            })
            .unwrap();
        let request = Request::builder()
            .method(Method::GET)
            .uri(format!("flowz-media://localhost/{}", blob.hash))
            .body(Vec::new())
            .unwrap();
        assert_eq!(
            media_protocol_response(&request, &persistence).status(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE
        );
    }

    #[test]
    fn provider_cost_crosses_ipc_as_integer_microunits() {
        assert_eq!(
            provider_cost_microunits(&json!({"usage": {"cost": 0.0344}})),
            Some(34_400)
        );
        assert_eq!(
            provider_cost_microunits(&json!({"usage": {"cost": "1.2345678"}})),
            Some(1_234_568)
        );
        assert_eq!(rounded_decimal_to_microunits("1e-6").unwrap(), 1);
    }

    #[test]
    fn private_reference_is_downscaled_and_keeps_alpha() {
        let image = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            2_200,
            8,
            image::Rgba([255, 0, 120, 128]),
        ));
        let mut source = std::io::Cursor::new(Vec::new());
        image
            .write_to(&mut source, image::ImageFormat::Png)
            .unwrap();
        let data_url = format!(
            "data:image/png;base64,{}",
            BASE64.encode(source.into_inner())
        );
        let optimized = optimize_reference_image(&data_url).unwrap();
        assert!(optimized.starts_with("data:image/png;base64,"));
        let (_, bytes) = decode_image_data_url(&optimized).unwrap();
        let decoded = image::load_from_memory(&bytes).unwrap();
        assert_eq!(decoded.width(), 2_048);
        assert!(decoded.color().has_alpha());
    }

    #[test]
    fn asset_thumbnail_is_a_real_bounded_png_derivative() {
        let source = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            640,
            320,
            image::Rgba([20, 40, 80, 128]),
        ));
        let mut bytes = std::io::Cursor::new(Vec::new());
        source
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        let thumbnail = create_asset_thumbnail(bytes.get_ref()).unwrap();
        let decoded = image::load_from_memory(&thumbnail).unwrap();
        assert_eq!(decoded.dimensions(), (192, 96));
        assert!(thumbnail.starts_with(b"\x89PNG\r\n\x1a\n"));
    }
}
