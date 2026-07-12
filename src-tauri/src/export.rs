use crate::persistence::Persistence;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

const MAX_TEXT_EXPORT: usize = 32 * 1024 * 1024;
const MAX_LIST_ITEMS: usize = 500;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportItem {
    pub text: Option<String>,
    pub blob_hash: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportRequest {
    pub project_id: String,
    pub grant_id: String,
    pub project: String,
    pub node: String,
    pub run: String,
    pub name_template: String,
    pub overwrite: String,
    pub items: Vec<ExportItem>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub files: Vec<String>,
    pub folder: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FolderGrant {
    id: String,
    #[serde(default)]
    project_id: String,
    #[serde(default)]
    artboard_document_id: Option<String>,
    canonical_path: PathBuf,
    display_name: String,
}

#[derive(Clone)]
pub struct ExportGrantStore {
    file: PathBuf,
    grants: Arc<Mutex<HashMap<String, FolderGrant>>>,
}

impl ExportGrantStore {
    pub fn initialize(app_data: &Path) -> Result<Self, String> {
        let file = app_data.join("export-folder-grants.json");
        let grants = if file.exists() {
            serde_json::from_slice::<Vec<FolderGrant>>(&fs::read(&file).map_err(|e| e.to_string())?)
                .map_err(|_| "Exportordner-Freigaben sind beschädigt.".to_string())?
                .into_iter()
                .map(|g| (g.id.clone(), g))
                .collect()
        } else {
            HashMap::new()
        };
        Ok(Self {
            file,
            grants: Arc::new(Mutex::new(grants)),
        })
    }
    fn persist(&self, grants: &HashMap<String, FolderGrant>) -> Result<(), String> {
        let parent = self.file.parent().ok_or("Ungültiger Grant-Speicher.")?;
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let temporary = parent.join(format!(".export-grants-{}.tmp", Uuid::new_v4()));
        let bytes =
            serde_json::to_vec(&grants.values().collect::<Vec<_>>()).map_err(|e| e.to_string())?;
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(&temporary, &self.file).map_err(|e| e.to_string())
    }
    fn issue(&self, project_id: &str, path: PathBuf) -> Result<FolderGrant, String> {
        let canonical_path = fs::canonicalize(path)
            .map_err(|_| "Der Exportordner ist nicht verfügbar.".to_string())?;
        if !canonical_path.is_dir() {
            return Err("Das Exportziel ist kein Ordner.".into());
        }
        let grant = FolderGrant {
            id: Uuid::new_v4().to_string(),
            project_id: project_id.into(),
            artboard_document_id: None,
            display_name: canonical_path
                .file_name()
                .and_then(|v| v.to_str())
                .unwrap_or("Exportordner")
                .into(),
            canonical_path,
        };
        let mut grants = self
            .grants
            .lock()
            .map_err(|_| "Grant-Speicher ist nicht verfügbar.".to_string())?;
        grants.retain(|_, item| item.project_id != project_id);
        grants.insert(grant.id.clone(), grant.clone());
        self.persist(&grants)?;
        Ok(grant)
    }
    fn issue_artboard(&self, document_id: &str, path: PathBuf) -> Result<FolderGrant, String> {
        let canonical_path = fs::canonicalize(path)
            .map_err(|_| "Der Exportordner ist nicht verfügbar.".to_string())?;
        if !canonical_path.is_dir() {
            return Err("Das Exportziel ist kein Ordner.".into());
        }
        let grant = FolderGrant {
            id: Uuid::new_v4().to_string(),
            project_id: String::new(),
            artboard_document_id: Some(document_id.into()),
            display_name: canonical_path
                .file_name()
                .and_then(|v| v.to_str())
                .unwrap_or("Exportordner")
                .into(),
            canonical_path,
        };
        let mut grants = self
            .grants
            .lock()
            .map_err(|_| "Grant-Speicher ist nicht verfügbar.".to_string())?;
        grants.retain(|_, item| item.artboard_document_id.as_deref() != Some(document_id));
        grants.insert(grant.id.clone(), grant.clone());
        self.persist(&grants)?;
        Ok(grant)
    }
    fn resolve(&self, project_id: &str, grant_id: &str) -> Result<FolderGrant, String> {
        Uuid::parse_str(grant_id).map_err(|_| "Ungültige Exportordner-Freigabe.".to_string())?;
        let grant = self
            .grants
            .lock()
            .map_err(|_| "Grant-Speicher ist nicht verfügbar.".to_string())?
            .get(grant_id)
            .cloned()
            .ok_or("Der Exportordner muss erneut freigegeben werden.")?;
        if grant.project_id != project_id {
            return Err("Die Exportordner-Freigabe gehört zu einem anderen Projekt.".into());
        }
        Ok(grant)
    }
    fn resolve_artboard(&self, document_id: &str, grant_id: &str) -> Result<FolderGrant, String> {
        Uuid::parse_str(grant_id).map_err(|_| "Ungültige Exportordner-Freigabe.".to_string())?;
        let grant = self
            .grants
            .lock()
            .map_err(|_| "Grant-Speicher ist nicht verfügbar.".to_string())?
            .get(grant_id)
            .cloned()
            .ok_or("Der Exportordner muss erneut freigegeben werden.")?;
        if grant.artboard_document_id.as_deref() != Some(document_id) {
            return Err(
                "Die Exportordner-Freigabe gehört zu einem anderen Artboard-Dokument.".into(),
            );
        }
        Ok(grant)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderGrantResponse {
    grant_id: String,
    display_name: String,
}

#[tauri::command]
pub fn export_pick_folder(
    project_id: String,
    app: tauri::AppHandle,
    grants: tauri::State<'_, ExportGrantStore>,
    persistence: tauri::State<'_, Persistence>,
) -> Result<Option<FolderGrantResponse>, String> {
    persistence.projects.open(&project_id)?;
    let selected = app
        .dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|folder| folder.into_path().ok());
    selected
        .map(|path| {
            grants
                .issue(&project_id, path)
                .map(|grant| FolderGrantResponse {
                    grant_id: grant.id,
                    display_name: grant.display_name,
                })
        })
        .transpose()
}

fn safe_token(value: &str, fallback: &str) -> String {
    let value = value.trim();
    let mut result = String::with_capacity(value.len().min(80));
    for character in value.chars().take(80) {
        if character.is_alphanumeric() || matches!(character, '-' | '_') {
            result.push(character);
        } else if character.is_whitespace() && !result.ends_with('-') {
            result.push('-');
        }
    }
    let result = result.trim_matches(['-', '_']);
    if result.is_empty() {
        fallback.into()
    } else {
        result.into()
    }
}

fn extension(item: &ExportItem, media_type: Option<&str>) -> &'static str {
    if let Some(text) = &item.text {
        let start = text.trim_start().to_ascii_lowercase();
        return if start.starts_with("<!doctype html") || start.starts_with("<html") {
            "html"
        } else {
            "md"
        };
    }
    match media_type.unwrap_or_default() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "video/quicktime" => "mov",
        "audio/mpeg" => "mp3",
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/mp4" => "m4a",
        "audio/ogg" => "ogg",
        _ => "bin",
    }
}

fn render_name(
    request: &ExportRequest,
    index: usize,
    item: &ExportItem,
    media_type: Option<&str>,
) -> String {
    let timestamp: DateTime<Utc> = Utc::now();
    let mut name = request.name_template.clone();
    for (token, value) in [
        ("{project}", safe_token(&request.project, "projekt")),
        ("{node}", safe_token(&request.node, "node")),
        ("{date}", timestamp.format("%Y-%m-%d").to_string()),
        ("{run}", safe_token(&request.run, "run")),
        ("{index}", format!("{:02}", index + 1)),
    ] {
        name = name.replace(token, &value);
    }
    let stem = safe_token(
        name.trim_end_matches(&format!(".{}", extension(item, media_type))),
        "export",
    );
    format!("{stem}.{}", extension(item, media_type))
}

fn next_destination(folder: &Path, requested: &str, overwrite: &str) -> Result<PathBuf, String> {
    let candidate = folder.join(requested);
    if candidate.parent() != Some(folder) {
        return Err("Der Exportname verlässt den gewählten Ordner.".into());
    }
    if overwrite == "replace" {
        return Ok(candidate);
    }
    if !candidate.exists() {
        return Ok(candidate);
    }
    if overwrite == "error" {
        return Err(format!("„{requested}“ existiert bereits."));
    }
    let path = Path::new(requested);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("export");
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("bin");
    for suffix in 2..=10_000 {
        let candidate = folder.join(format!("{stem}-{suffix}.{ext}"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("Es konnte kein freier Dateiname gefunden werden.".into())
}

fn atomic_write(
    folder: &Path,
    destination: &Path,
    bytes: &[u8],
    replace: bool,
) -> Result<(), String> {
    let temporary = folder.join(format!(".flowz-export-{}.tmp", Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    drop(file);
    let result = if replace {
        fs::rename(&temporary, destination)
    } else {
        fs::hard_link(&temporary, destination).and_then(|_| fs::remove_file(&temporary))
    };
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|error| error.to_string())
}

#[tauri::command]
pub fn export_write(
    request: ExportRequest,
    persistence: tauri::State<'_, Persistence>,
    grants: tauri::State<'_, ExportGrantStore>,
) -> Result<ExportResult, String> {
    if request.items.is_empty() || request.items.len() > MAX_LIST_ITEMS {
        return Err("Exportiere 1–500 Elemente pro Lauf.".into());
    }
    if !matches!(request.overwrite.as_str(), "rename" | "replace" | "error") {
        return Err("Ungültige Überschreibregel.".into());
    }
    if request.name_template.trim().is_empty() || request.name_template.chars().count() > 180 {
        return Err("Das Namensschema muss 1–180 Zeichen lang sein.".into());
    }
    persistence.projects.open(&request.project_id)?;
    let grant = grants.resolve(&request.project_id, &request.grant_id)?;
    let folder = fs::canonicalize(&grant.canonical_path)
        .map_err(|_| "Der Exportordner ist nicht mehr verfügbar.".to_string())?;
    if !folder.is_dir() {
        return Err("Das Exportziel ist kein Ordner.".into());
    }
    let mut written = Vec::with_capacity(request.items.len());
    for (index, item) in request.items.iter().enumerate() {
        if item.text.is_some() == item.blob_hash.is_some() {
            return Err(
                "Jedes Exportelement braucht genau Text oder ein gespeichertes Medium.".into(),
            );
        }
        let media_type = if item.text.is_some() {
            None
        } else {
            Some(
                persistence
                    .database
                    .blob_media_type(item.blob_hash.as_deref().unwrap())?,
            )
        };
        let bytes = if let Some(text) = &item.text {
            if text.len() > MAX_TEXT_EXPORT {
                return Err("Ein Textexport ist größer als 32 MiB.".into());
            }
            text.as_bytes().to_vec()
        } else {
            persistence.blobs.read(item.blob_hash.as_deref().unwrap())?
        };
        let name = render_name(&request, index, item, media_type.as_deref());
        let destination = next_destination(&folder, &name, &request.overwrite)?;
        let canonical_parent =
            fs::canonicalize(destination.parent().unwrap()).map_err(|error| error.to_string())?;
        if canonical_parent != folder {
            return Err("Das Exportziel wurde außerhalb des gewählten Ordners aufgelöst.".into());
        }
        atomic_write(
            &folder,
            &destination,
            &bytes,
            request.overwrite == "replace",
        )?;
        written.push(destination.to_string_lossy().into_owned());
    }
    Ok(ExportResult {
        files: written,
        folder: folder.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn export_reveal(
    project_id: String,
    grant_id: String,
    path: String,
    grants: tauri::State<'_, ExportGrantStore>,
) -> Result<(), String> {
    let grant = grants.resolve(&project_id, &grant_id)?;
    let path = fs::canonicalize(path)
        .map_err(|_| "Die exportierte Datei ist nicht mehr verfügbar.".to_string())?;
    let folder = fs::canonicalize(grant.canonical_path)
        .map_err(|_| "Der Exportordner ist nicht mehr verfügbar.".to_string())?;
    if path.parent() != Some(folder.as_path()) {
        return Err("Die Datei gehört nicht zu dieser Exportordner-Freigabe.".into());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(path)
            .spawn()
            .map_err(|error| error.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        return Err(
            "Im Dateimanager anzeigen ist auf dieser Plattform noch nicht verfügbar.".into(),
        );
    }
    Ok(())
}

const MAX_ARTBOARD_EXPORTS: usize = 32;
// Base64 avoids the several-times-larger JSON number arrays previously sent
// over IPC. The decoded batch is bounded before any file is staged.
const MAX_ARTBOARD_EXPORT_BYTES: usize = 64 * 1024 * 1024;
const MAX_ARTBOARD_PNG_BASE64: usize = ((32 * 1024 * 1024) / 3) * 4 + 8;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtboardExportBoard {
    board_id: String,
    board_revision_id: String,
    name: String,
    png_base64: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtboardExportRequest {
    document_id: String,
    workspace_id: String,
    revision_id: String,
    grant_id: String,
    overwrite: String,
    include_manifest: bool,
    boards: Vec<ArtboardExportBoard>,
}

#[derive(Debug)]
struct PreparedFile {
    name: String,
    bytes: Vec<u8>,
}

fn next_reserved_destination(
    folder: &Path,
    requested: &str,
    overwrite: &str,
    reserved: &mut HashSet<PathBuf>,
) -> Result<PathBuf, String> {
    let base = folder.join(requested);
    if base.parent() != Some(folder) {
        return Err("Der Exportname verlässt den gewählten Ordner.".into());
    }
    if overwrite == "replace" {
        if base.exists() && !base.is_file() {
            return Err(format!("„{requested}“ ist keine ersetzbare Datei."));
        }
        if !reserved.insert(base.clone()) {
            return Err(format!(
                "Der Dateiname „{requested}“ kommt im Export doppelt vor."
            ));
        }
        return Ok(base);
    }
    if overwrite == "error" {
        if base.exists() || !reserved.insert(base.clone()) {
            return Err(format!("„{requested}“ existiert bereits."));
        }
        return Ok(base);
    }
    if !base.exists() && reserved.insert(base.clone()) {
        return Ok(base);
    }
    let path = Path::new(requested);
    let stem = path
        .file_stem()
        .and_then(|v| v.to_str())
        .unwrap_or("artboard");
    let ext = path.extension().and_then(|v| v.to_str()).unwrap_or("png");
    for suffix in 2..=10_000 {
        let candidate = folder.join(format!("{stem}-{suffix}.{ext}"));
        if !candidate.exists() && reserved.insert(candidate.clone()) {
            return Ok(candidate);
        }
    }
    Err("Es konnte kein freier Dateiname gefunden werden.".into())
}

fn atomic_batch_write(
    folder: &Path,
    files: Vec<PreparedFile>,
    overwrite: &str,
) -> Result<Vec<PathBuf>, String> {
    let mut reserved = HashSet::new();
    let destinations = files
        .iter()
        .map(|file| next_reserved_destination(folder, &file.name, overwrite, &mut reserved))
        .collect::<Result<Vec<_>, _>>()?;
    let mut staged = Vec::with_capacity(files.len());
    for file in &files {
        let path = folder.join(format!(".flowz-artboard-export-{}.tmp", Uuid::new_v4()));
        let mut handle = match OpenOptions::new().create_new(true).write(true).open(&path) {
            Ok(handle) => handle,
            Err(error) => {
                for prior in &staged {
                    let _ = fs::remove_file(prior);
                }
                return Err(error.to_string());
            }
        };
        if let Err(error) = handle
            .write_all(&file.bytes)
            .and_then(|_| handle.sync_all())
        {
            let _ = fs::remove_file(&path);
            for prior in &staged {
                let _ = fs::remove_file(prior);
            }
            return Err(error.to_string());
        }
        staged.push(path);
    }
    let mut backups: Vec<(PathBuf, PathBuf)> = Vec::new();
    let mut committed: Vec<PathBuf> = Vec::new();
    let commit_result = (|| -> Result<(), String> {
        for (stage, destination) in staged.iter().zip(&destinations) {
            if overwrite == "replace" {
                if destination.exists() {
                    let backup =
                        folder.join(format!(".flowz-artboard-backup-{}.tmp", Uuid::new_v4()));
                    fs::rename(destination, &backup).map_err(|e| e.to_string())?;
                    backups.push((destination.clone(), backup));
                }
                fs::rename(stage, destination).map_err(|e| e.to_string())?;
            } else {
                fs::hard_link(stage, destination).map_err(|e| e.to_string())?;
                committed.push(destination.clone());
                fs::remove_file(stage).map_err(|e| e.to_string())?;
                continue;
            }
            committed.push(destination.clone());
        }
        Ok(())
    })();
    if let Err(error) = commit_result {
        for stage in &staged {
            let _ = fs::remove_file(stage);
        }
        for path in committed.iter().rev() {
            let _ = fs::remove_file(path);
        }
        for (destination, backup) in backups.iter().rev() {
            let _ = fs::rename(backup, destination);
        }
        return Err(error);
    }
    for (_, backup) in backups {
        let _ = fs::remove_file(backup);
    }
    let _ = std::fs::File::open(folder).and_then(|f| f.sync_all());
    Ok(destinations)
}

fn verified_artboard_files(
    request: &ArtboardExportRequest,
    persistence: &Persistence,
) -> Result<Vec<PreparedFile>, String> {
    for (value, label) in [
        (&request.document_id, "documentId"),
        (&request.workspace_id, "workspaceId"),
        (&request.revision_id, "revisionId"),
    ] {
        if !super::artboard_composite::valid_id_for_export(value) {
            return Err(format!("{label} ist ungültig."));
        }
    }
    if request.document_id != request.workspace_id {
        return Err("Artboard-Dokument und Workspace stimmen nicht überein.".into());
    }
    if request.boards.is_empty() || request.boards.len() > MAX_ARTBOARD_EXPORTS {
        return Err("Exportiere 1 bis 32 Artboards pro Lauf.".into());
    }
    if !matches!(request.overwrite.as_str(), "rename" | "replace" | "error") {
        return Err("Ungültige Überschreibregel.".into());
    }
    let record = persistence
        .database
        .open_artboard_workspace(&request.document_id)?
        .ok_or("Das Artboard-Dokument existiert nicht mehr.")?;
    if record.id != request.workspace_id {
        return Err("Der Workspace gehört nicht zu diesem Artboard-Dokument.".into());
    }
    let revision = persistence
        .database
        .artboard_revision(&request.revision_id)?
        .ok_or("Die Artboard-Revision existiert nicht mehr.")?;
    if revision.workspace_id != request.workspace_id {
        return Err("Die Revision gehört nicht zu diesem Artboard-Dokument.".into());
    }
    let workspace = revision
        .workspace
        .as_object()
        .ok_or("Die gespeicherte Artboard-Revision ist beschädigt.")?;
    if workspace.get("id").and_then(serde_json::Value::as_str)
        != Some(request.workspace_id.as_str())
    {
        return Err("Die gespeicherte Workspace-ID stimmt nicht überein.".into());
    }
    let boards = workspace
        .get("boards")
        .and_then(serde_json::Value::as_object)
        .ok_or("Die gespeicherten Artboards fehlen.")?;
    let mut ids = HashSet::new();
    let mut total = 0usize;
    let mut prepared =
        Vec::with_capacity(request.boards.len() + usize::from(request.include_manifest));
    for item in &request.boards {
        if !super::artboard_composite::valid_id_for_export(&item.board_id)
            || !super::artboard_composite::valid_id_for_export(&item.board_revision_id)
            || !ids.insert(item.board_id.as_str())
        {
            return Err("Artboard-IDs sind ungültig oder doppelt.".into());
        }
        if item.png_base64.len() > MAX_ARTBOARD_PNG_BASE64 {
            return Err("Ein Artboard-PNG überschreitet das sichere IPC-Limit.".into());
        }
        let png_bytes = BASE64
            .decode(&item.png_base64)
            .map_err(|_| "Das Artboard-PNG ist nicht gültig Base64-kodiert.".to_string())?;
        total = total
            .checked_add(png_bytes.len())
            .ok_or("Der Artboard-Export ist zu groß.")?;
        if total > MAX_ARTBOARD_EXPORT_BYTES {
            return Err("Der Artboard-Export überschreitet das IPC-Limit von 64 MiB.".into());
        }
        let board = boards
            .get(&item.board_id)
            .and_then(serde_json::Value::as_object)
            .ok_or("Ein ausgewähltes Artboard gehört nicht zu dieser Revision.")?;
        if board.get("id").and_then(serde_json::Value::as_str) != Some(item.board_id.as_str())
            || board
                .get("activeRevisionId")
                .and_then(serde_json::Value::as_str)
                != Some(item.board_revision_id.as_str())
        {
            return Err("Die Board-Revision ist nicht mehr aktuell.".into());
        }
        let stored: (String, String, String) =
            persistence.database.with_connection(|connection| {
                connection.query_row(
            "SELECT workspace_id,board_id,board_json FROM artboard_board_revisions WHERE id=?1",
            [&item.board_revision_id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?)))
            })?;
        let stored_board: serde_json::Value = serde_json::from_str(&stored.2)
            .map_err(|_| "Die immutable Board-Revision ist beschädigt.".to_string())?;
        if stored.0 != request.workspace_id
            || stored.1 != item.board_id
            || stored_board != serde_json::Value::Object(board.clone())
        {
            return Err(
                "Die Board-Revision ist nicht eindeutig an dieses Dokument und Board gebunden."
                    .into(),
            );
        }
        let format = board
            .get("document")
            .and_then(|v| v.get("format"))
            .and_then(serde_json::Value::as_object)
            .ok_or("Das Artboard-Format fehlt.")?;
        let expected_width = format
            .get("width")
            .and_then(serde_json::Value::as_u64)
            .and_then(|v| u32::try_from(v).ok())
            .ok_or("Die Artboard-Breite ist ungültig.")?;
        let expected_height = format
            .get("height")
            .and_then(serde_json::Value::as_u64)
            .and_then(|v| u32::try_from(v).ok())
            .ok_or("Die Artboard-Höhe ist ungültig.")?;
        let (width, height) = super::artboard_composite::validate_png(&png_bytes)?;
        if (width, height) != (expected_width, expected_height) {
            return Err(
                "Die PNG-Abmessungen stimmen nicht mit der gespeicherten Board-Revision überein."
                    .into(),
            );
        }
        let board_name = board
            .get("name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or(&item.name);
        let stem = format!(
            "{}-{}",
            safe_token(&record.name, "artboard"),
            safe_token(board_name, "board")
        );
        prepared.push(PreparedFile {
            name: format!("{stem}.png"),
            bytes: png_bytes,
        });
    }
    if request.include_manifest {
        let mut asset_hashes = HashSet::new();
        for board in boards.values().filter_map(serde_json::Value::as_object) {
            if let Some(bindings) = board
                .get("document")
                .and_then(|v| v.get("bindings"))
                .and_then(serde_json::Value::as_object)
            {
                for binding in bindings.values() {
                    if let Some(snapshot) = binding.get("snapshot") {
                        if let Some(hash) = snapshot
                            .get("hash")
                            .or_else(|| snapshot.get("artifactHash"))
                            .and_then(serde_json::Value::as_str)
                        {
                            asset_hashes.insert(hash.to_owned());
                        }
                    }
                }
            }
            if let Some(layers) = board
                .get("document")
                .and_then(|v| v.get("layers"))
                .and_then(serde_json::Value::as_object)
            {
                for layer in layers.values() {
                    if let Some(hash) = layer.get("casHash").and_then(serde_json::Value::as_str) {
                        asset_hashes.insert(hash.to_owned());
                    }
                }
            }
        }
        let mut asset_hashes = asset_hashes.into_iter().collect::<Vec<_>>();
        asset_hashes.sort();
        // Keep the portable manifest contract identical to the domain serializer;
        // document/revision IDs are security inputs, not an import-time legacy envelope.
        let manifest = serde_json::json!({"format":"flowz-artboard","version":1,"workspace":revision.workspace,"assetHashes":asset_hashes});
        let bytes = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
        if bytes.len() > MAX_TEXT_EXPORT {
            return Err("Das Artboard-Manifest ist größer als 32 MiB.".into());
        }
        prepared.push(PreparedFile {
            name: format!("{}.flowz-artboard", safe_token(&record.name, "artboard")),
            bytes,
        });
    }
    Ok(prepared)
}

#[tauri::command]
pub fn artboard_export_pick_folder(
    document_id: String,
    app: tauri::AppHandle,
    grants: tauri::State<'_, ExportGrantStore>,
    persistence: tauri::State<'_, Persistence>,
) -> Result<Option<FolderGrantResponse>, String> {
    persistence
        .database
        .open_artboard_workspace(&document_id)?
        .ok_or("Das Artboard-Dokument existiert nicht mehr.")?;
    app.dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|folder| folder.into_path().ok())
        .map(|path| {
            grants
                .issue_artboard(&document_id, path)
                .map(|grant| FolderGrantResponse {
                    grant_id: grant.id,
                    display_name: grant.display_name,
                })
        })
        .transpose()
}

#[tauri::command]
pub fn artboard_export_write(
    request: ArtboardExportRequest,
    persistence: tauri::State<'_, Persistence>,
    grants: tauri::State<'_, ExportGrantStore>,
) -> Result<ExportResult, String> {
    let files = verified_artboard_files(&request, &persistence)?;
    let grant = grants.resolve_artboard(&request.document_id, &request.grant_id)?;
    let folder = fs::canonicalize(&grant.canonical_path)
        .map_err(|_| "Der Exportordner ist nicht mehr verfügbar.".to_string())?;
    if !folder.is_dir() {
        return Err("Das Exportziel ist kein Ordner.".into());
    }
    let written = atomic_batch_write(&folder, files, &request.overwrite)?;
    Ok(ExportResult {
        files: written
            .into_iter()
            .map(|v| v.to_string_lossy().into_owned())
            .collect(),
        folder: folder.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn artboard_export_reveal(
    document_id: String,
    grant_id: String,
    path: String,
    grants: tauri::State<'_, ExportGrantStore>,
) -> Result<(), String> {
    let grant = grants.resolve_artboard(&document_id, &grant_id)?;
    let path = fs::canonicalize(path)
        .map_err(|_| "Die exportierte Datei ist nicht mehr verfügbar.".to_string())?;
    let folder = fs::canonicalize(grant.canonical_path)
        .map_err(|_| "Der Exportordner ist nicht mehr verfügbar.".to_string())?;
    if path.parent() != Some(folder.as_path()) {
        return Err("Die Datei gehört nicht zu dieser Artboard-Ordnerfreigabe.".into());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        return Err(
            "Im Dateimanager anzeigen ist auf dieser Plattform noch nicht verfügbar.".into(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn token_sanitizing_blocks_paths() {
        assert_eq!(safe_token("../../ Meine Marke /", "x"), "Meine-Marke");
    }
    #[test]
    fn names_expand_without_paths() {
        let request = ExportRequest {
            project_id: "p".into(),
            grant_id: "g".into(),
            project: "P / eins".into(),
            node: "Bild".into(),
            run: "r".into(),
            name_template: "{project}_{node}_{index}".into(),
            overwrite: "rename".into(),
            items: vec![],
        };
        let name = render_name(
            &request,
            1,
            &ExportItem {
                text: Some("x".into()),
                blob_hash: None,
            },
            None,
        );
        assert_eq!(name, "P-eins_Bild_02.md");
        assert!(!name.contains('/'));
    }
    #[test]
    fn collision_renames() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.md"), b"old").unwrap();
        assert_eq!(
            next_destination(dir.path(), "a.md", "rename").unwrap(),
            dir.path().join("a-2.md")
        );
    }
    #[test]
    fn atomic_create_never_replaces_without_permission() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.md");
        fs::write(&path, b"old").unwrap();
        assert!(atomic_write(dir.path(), &path, b"new", false).is_err());
        assert_eq!(fs::read(path).unwrap(), b"old");
    }
    #[test]
    fn opaque_grants_persist_and_are_project_scoped() {
        let app = tempfile::tempdir().unwrap();
        let folder = tempfile::tempdir().unwrap();
        let store = ExportGrantStore::initialize(app.path()).unwrap();
        let grant = store.issue("project-a", folder.path().to_owned()).unwrap();
        assert!(store.resolve("project-b", &grant.id).is_err());
        let reopened = ExportGrantStore::initialize(app.path()).unwrap();
        assert_eq!(
            reopened
                .resolve("project-a", &grant.id)
                .unwrap()
                .canonical_path,
            fs::canonicalize(folder.path()).unwrap()
        );
        assert!(
            !fs::read_to_string(app.path().join("export-folder-grants.json"))
                .unwrap()
                .contains("project.flowz")
        );
    }
    #[test]
    fn each_cas_item_uses_its_authoritative_mime_extension() {
        let item = ExportItem {
            text: None,
            blob_hash: Some("a".repeat(64)),
        };
        assert_eq!(extension(&item, Some("image/webp")), "webp");
        assert_eq!(extension(&item, Some("video/quicktime")), "mov");
        assert_eq!(
            extension(
                &ExportItem {
                    text: Some("<!doctype html><html></html>".into()),
                    blob_hash: None
                },
                None
            ),
            "html"
        );
    }
    #[test]
    fn artboard_grants_are_document_scoped() {
        let app = tempfile::tempdir().unwrap();
        let folder = tempfile::tempdir().unwrap();
        let store = ExportGrantStore::initialize(app.path()).unwrap();
        let grant = store
            .issue_artboard("artboard-a", folder.path().to_owned())
            .unwrap();
        assert!(store.resolve_artboard("artboard-b", &grant.id).is_err());
        assert!(store.resolve("artboard-a", &grant.id).is_err());
        assert_eq!(
            store
                .resolve_artboard("artboard-a", &grant.id)
                .unwrap()
                .canonical_path,
            fs::canonicalize(folder.path()).unwrap()
        );
    }
    #[test]
    fn artboard_batch_renames_internal_collisions_and_commits_all_files() {
        let folder = tempfile::tempdir().unwrap();
        let paths = atomic_batch_write(
            folder.path(),
            vec![
                PreparedFile {
                    name: "Campaign-Post.png".into(),
                    bytes: b"one".to_vec(),
                },
                PreparedFile {
                    name: "Campaign-Post.png".into(),
                    bytes: b"two".to_vec(),
                },
            ],
            "rename",
        )
        .unwrap();
        assert_eq!(
            paths,
            vec![
                folder.path().join("Campaign-Post.png"),
                folder.path().join("Campaign-Post-2.png")
            ]
        );
        assert_eq!(fs::read(&paths[0]).unwrap(), b"one");
        assert_eq!(fs::read(&paths[1]).unwrap(), b"two");
        assert!(fs::read_dir(folder.path()).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".flowz-artboard")));
    }
    #[test]
    fn artboard_batch_replaces_only_when_requested() {
        let folder = tempfile::tempdir().unwrap();
        let destination = folder.path().join("a.png");
        fs::write(&destination, b"old").unwrap();
        assert!(atomic_batch_write(
            folder.path(),
            vec![PreparedFile {
                name: "a.png".into(),
                bytes: b"new".to_vec()
            }],
            "error"
        )
        .is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"old");
        atomic_batch_write(
            folder.path(),
            vec![PreparedFile {
                name: "a.png".into(),
                bytes: b"new".to_vec(),
            }],
            "replace",
        )
        .unwrap();
        assert_eq!(fs::read(destination).unwrap(), b"new");
    }
    #[test]
    fn artboard_error_mode_preflights_the_entire_batch_without_partial_files() {
        let folder = tempfile::tempdir().unwrap();
        fs::write(folder.path().join("existing.png"), b"old").unwrap();
        let result = atomic_batch_write(
            folder.path(),
            vec![
                PreparedFile {
                    name: "new.png".into(),
                    bytes: b"new".to_vec(),
                },
                PreparedFile {
                    name: "existing.png".into(),
                    bytes: b"replace".to_vec(),
                },
            ],
            "error",
        );
        assert!(result.is_err());
        assert!(!folder.path().join("new.png").exists());
        assert_eq!(
            fs::read(folder.path().join("existing.png")).unwrap(),
            b"old"
        );
    }
    fn artboard_workspace_json() -> serde_json::Value {
        serde_json::json!({"schemaVersion":1,"id":"workspace-1","name":"Campaign","boards":{"board-1":{"id":"board-1","name":"Post","activeRevisionId":"board-revision-1","document":{"schemaVersion":1,"id":"document-1","name":"Post","format":{"preset":"instagram-post","width":1080,"height":1080},"paint":{"kind":"solid","color":"#FFFFFF"},"rootLayerIds":[],"layers":{},"bindings":{},"tokenRefs":{}},"inputSnapshot":{"id":"snapshot-1","createdAt":"2026-07-12T10:00:00Z","bindings":{}},"ancestry":{"branchId":"branch-main"},"createdAt":"2026-07-12T10:00:00Z"}},"placements":{"board-1":{"x":64,"y":64}},"selectedBoardIds":["board-1"],"activeBoardId":"board-1","pasteboard":{"margin":64,"gap":64,"grid":8}})
    }
    fn png(width: u32, height: u32) -> Vec<u8> {
        use image::{DynamicImage, ImageFormat, RgbaImage};
        use std::io::Cursor;
        let mut output = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(RgbaImage::new(width, height))
            .write_to(&mut output, ImageFormat::Png)
            .unwrap();
        output.into_inner()
    }
    #[test]
    fn artboard_export_is_bound_to_persisted_revision_board_and_dimensions() {
        use crate::persistence::{CreateArtboardWorkspace, Persistence};
        let root = tempfile::tempdir().unwrap();
        let persistence = Persistence::initialize(root.path()).unwrap();
        persistence
            .database
            .create_artboard_workspace(CreateArtboardWorkspace {
                workspace_id: "workspace-1".into(),
                project_id: None,
                node_id: None,
                name: "Campaign".into(),
                branch_id: "branch-main".into(),
                revision_id: "revision-1".into(),
                operation_id: "create-1".into(),
                workspace: artboard_workspace_json(),
                input_snapshot: None,
                created_at: "2026-07-12T10:00:00Z".into(),
            })
            .unwrap();
        let mut request = ArtboardExportRequest {
            document_id: "workspace-1".into(),
            workspace_id: "workspace-1".into(),
            revision_id: "revision-1".into(),
            grant_id: Uuid::new_v4().to_string(),
            overwrite: "rename".into(),
            include_manifest: true,
            boards: vec![ArtboardExportBoard {
                board_id: "board-1".into(),
                board_revision_id: "board-revision-1".into(),
                name: "ignored-client-name".into(),
                png_base64: BASE64.encode(png(1080, 1080)),
            }],
        };
        let files = verified_artboard_files(&request, &persistence).unwrap();
        assert_eq!(
            files
                .iter()
                .map(|item| item.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Campaign-Post.png", "Campaign.flowz-artboard"]
        );
        let manifest: serde_json::Value = serde_json::from_slice(&files[1].bytes).unwrap();
        assert_eq!(manifest["format"], "flowz-artboard");
        assert_eq!(manifest["version"], 1);
        assert_eq!(manifest["workspace"]["id"], "workspace-1");
        assert_eq!(manifest["workspace"]["activeBoardId"], "board-1");
        assert_eq!(
            manifest["workspace"]["selectedBoardIds"],
            serde_json::json!(["board-1"])
        );
        request.boards[0].board_revision_id = "stale-revision".into();
        assert!(verified_artboard_files(&request, &persistence)
            .unwrap_err()
            .contains("nicht mehr aktuell"));
        request.boards[0].board_revision_id = "board-revision-1".into();
        request.boards[0].png_base64 = BASE64.encode(png(32, 32));
        assert!(verified_artboard_files(&request, &persistence)
            .unwrap_err()
            .contains("Abmessungen"));
    }
}
