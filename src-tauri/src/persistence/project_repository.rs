use super::sync_directory;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

pub const PROJECT_SCHEMA_VERSION: u32 = 2;
const PROJECT_FILE: &str = "project.flowz.json";
const BACKUP_COUNT: usize = 3;

fn media_node_grant(node: &GraphNode) -> String {
    // Position, label, update policy and the rest of the graph are deliberately
    // excluded. Generation identity is the stable node id plus its module contract.
    let bytes = serde_json::to_vec(&(
        node.id.as_str(),
        node.module_id.as_str(),
        node.module_version,
    ))
    .expect("media target grant tuple is serializable");
    format!("{:x}", Sha256::digest(bytes))
}

#[derive(Clone)]
pub struct ProjectRepository {
    root: PathBuf,
    project_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    reference_lock: Arc<Mutex<()>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectDocument {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub graph: ProjectGraph,
    pub canvas: ProjectCanvas,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub groups: Vec<WorkflowGroup>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GraphNode {
    pub id: String,
    pub module_id: String,
    pub module_version: u32,
    pub position: CanvasPosition,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label_id: Option<String>,
    pub config: Map<String, Value>,
    pub update_policy: UpdatePolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasPosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GraphEdge {
    pub id: String,
    pub source_node_id: String,
    pub source_port_id: String,
    pub target_node_id: String,
    pub target_port_id: String,
    pub order: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowGroup {
    pub id: String,
    pub name: String,
    pub node_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdatePolicy {
    Manual,
    Auto,
    Frozen,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectCanvas {
    pub viewport: CanvasViewport,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasViewport {
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
}

fn empty_graph() -> ProjectGraph {
    ProjectGraph {
        nodes: vec![],
        edges: vec![],
        groups: vec![],
    }
}
fn default_canvas() -> ProjectCanvas {
    ProjectCanvas {
        viewport: CanvasViewport {
            x: 0.0,
            y: 0.0,
            zoom: 1.0,
        },
    }
}

fn validated_catalog_name(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 160 || value.chars().any(char::is_control) {
        return Err("Der Dokumentname muss 1 bis 160 sichtbare Zeichen enthalten.".into());
    }
    Ok(value.to_owned())
}

fn clear_transient_provider_state(config: &mut Map<String, Value>) {
    const TRANSIENT: &[&str] = &[
        "runId",
        "requestId",
        "providerRequestId",
        "phase",
        "status",
        "pending",
        "running",
        "resumable",
        "submittedAt",
        "startedAt",
        "finishedAt",
        "error",
        "errorCode",
        "streamState",
        "generationId",
    ];
    config.retain(|key, _| !TRANSIENT.contains(&key.as_str()));
    for value in config.values_mut() {
        clear_transient_value(value);
    }
}

fn clear_transient_value(value: &mut Value) {
    match value {
        Value::Object(object) => clear_transient_provider_state(object),
        Value::Array(items) => items.iter_mut().for_each(clear_transient_value),
        _ => {}
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateProjectRequest {
    pub name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveProjectRequest {
    pub project: ProjectDocument,
    pub expected_updated_at: DateTime<Utc>,
    pub expected_revision: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSaveResult {
    pub project: ProjectDocument,
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<u64>,
    pub diagnosis: ProjectDiagnosis,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct ProjectCatalogSummary {
    pub id: String,
    pub name: Option<String>,
    pub created_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
    pub revision: Option<u64>,
    pub diagnosis: ProjectDiagnosis,
    pub fingerprint: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectCatalogHeader {
    schema_version: u32,
    id: String,
    name: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    graph: serde::de::IgnoredAny,
    canvas: serde::de::IgnoredAny,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProjectDiagnosis {
    Healthy,
    Recovered,
    Corrupt,
    Unsupported,
}

impl ProjectRepository {
    #[cfg(test)]
    pub fn new(root: PathBuf) -> Result<Self, String> {
        Self::new_with_reference_lock(root, Arc::new(Mutex::new(())))
    }
    pub(crate) fn new_with_reference_lock(
        root: PathBuf,
        reference_lock: Arc<Mutex<()>>,
    ) -> Result<Self, String> {
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        Ok(Self {
            root,
            project_locks: Arc::new(Mutex::new(HashMap::new())),
            reference_lock,
        })
    }

    pub fn create(&self, request: CreateProjectRequest) -> Result<ProjectSaveResult, String> {
        let _references = self
            .reference_lock
            .lock()
            .map_err(|_| "Projekt-Referenzsperre ist beschädigt.".to_string())?;
        self.catalog_create_locked(Uuid::new_v4().to_string(), request.name)
    }

    pub(crate) fn catalog_create_locked(
        &self,
        id: String,
        name: String,
    ) -> Result<ProjectSaveResult, String> {
        validate_id(&id)?;
        let existing = self.root.join(&id).join(PROJECT_FILE);
        if existing.exists() {
            return self.open_without_reference_lock(&id);
        }
        let name = name.trim();
        if name.is_empty() {
            return Err("Der Projektname darf nicht leer sein.".into());
        }
        let now = Utc::now();
        let project = ProjectDocument {
            schema_version: PROJECT_SCHEMA_VERSION,
            id,
            name: name.into(),
            created_at: now,
            updated_at: now,
            graph: empty_graph(),
            canvas: default_canvas(),
        };
        validate_project(&project)?;
        let lock = self.lock_for(&project.id)?;
        let _guard = lock
            .lock()
            .map_err(|_| "Projekt-Sperre ist beschädigt.".to_string())?;
        let directory = self.root.join(&project.id);
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        atomic_write(
            &directory.join(PROJECT_FILE),
            &serde_json::to_vec_pretty(&project).map_err(|e| e.to_string())?,
        )?;
        write_revision(&directory, 1)?;
        Ok(ProjectSaveResult {
            project,
            revision: 1,
        })
    }

    pub fn list(&self) -> Result<Vec<ProjectSummary>, String> {
        let mut result = vec![];
        for entry in fs::read_dir(&self.root).map_err(|e| e.to_string())? {
            let directory = match entry {
                Ok(e) if e.path().is_dir() => e.path(),
                _ => continue,
            };
            let directory_id = directory
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("unknown")
                .to_owned();
            match self.read_with_recovery(&directory) {
                Ok((project, recovered_now)) => result.push(ProjectSummary {
                    id: project.id,
                    name: Some(project.name),
                    updated_at: Some(project.updated_at),
                    revision: Some(read_revision(&directory).unwrap_or(1)),
                    diagnosis: if recovered_now || has_recovery_quarantine(&directory) {
                        ProjectDiagnosis::Recovered
                    } else {
                        ProjectDiagnosis::Healthy
                    },
                    message: if recovered_now || has_recovery_quarantine(&directory) {
                        Some("Die primäre Projektdatei wurde aus einer validierten Sicherung wiederhergestellt.".into())
                    } else {
                        None
                    },
                }),
                Err(message) => result.push(ProjectSummary {
                    id: directory_id,
                    name: None,
                    updated_at: None,
                    revision: read_revision(&directory).ok(),
                    diagnosis: if file_has_newer_schema(&directory.join(PROJECT_FILE)) {
                        ProjectDiagnosis::Unsupported
                    } else {
                        ProjectDiagnosis::Corrupt
                    },
                    message: Some(message),
                }),
            }
        }
        result.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(result)
    }

    /// Reads the complete JSON stream for corruption detection, while discarding
    /// graph/canvas payloads instead of materializing hundreds of nodes for Home.
    pub(crate) fn catalog_list(&self) -> Result<Vec<ProjectCatalogSummary>, String> {
        let mut result = Vec::new();
        for entry in fs::read_dir(&self.root).map_err(|error| error.to_string())? {
            let directory = match entry {
                Ok(entry) if entry.path().is_dir() => entry.path(),
                _ => continue,
            };
            let directory_id = directory
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("unknown")
                .to_owned();
            let path = directory.join(PROJECT_FILE);
            let parsed = File::open(&path)
                .map_err(|error| error.to_string())
                .and_then(|file| {
                    serde_json::from_reader::<_, ProjectCatalogHeader>(file)
                        .map_err(|error| error.to_string())
                });
            match parsed {
                Ok(header)
                    if header.schema_version == PROJECT_SCHEMA_VERSION
                        && validate_id(&header.id).is_ok()
                        && !header.name.trim().is_empty() =>
                {
                    let _ = (&header.graph, &header.canvas);
                    result.push(ProjectCatalogSummary {
                        id: header.id,
                        name: Some(header.name),
                        created_at: Some(header.created_at),
                        updated_at: Some(header.updated_at),
                        revision: read_revision(&directory).ok(),
                        diagnosis: if has_recovery_quarantine(&directory) {
                            ProjectDiagnosis::Recovered
                        } else {
                            ProjectDiagnosis::Healthy
                        },
                        fingerprint: hash_file(&path).ok(),
                    });
                }
                Ok(header) if header.schema_version > PROJECT_SCHEMA_VERSION => {
                    result.push(ProjectCatalogSummary {
                        id: directory_id,
                        name: Some(header.name),
                        created_at: Some(header.created_at),
                        updated_at: Some(header.updated_at),
                        revision: read_revision(&directory).ok(),
                        diagnosis: ProjectDiagnosis::Unsupported,
                        fingerprint: hash_file(&path).ok(),
                    })
                }
                _ => result.push(ProjectCatalogSummary {
                    id: directory_id,
                    name: None,
                    created_at: None,
                    updated_at: None,
                    revision: read_revision(&directory).ok(),
                    diagnosis: ProjectDiagnosis::Corrupt,
                    fingerprint: hash_file(&path).ok(),
                }),
            }
        }
        result.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(result)
    }

    pub fn open(&self, id: &str) -> Result<ProjectSaveResult, String> {
        validate_id(id)?;
        let directory = self.root.join(id);
        let (project, _) = self.read_with_recovery(&directory)?;
        Ok(ProjectSaveResult {
            project,
            revision: read_revision(&directory).unwrap_or(1),
        })
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let _references = self
            .reference_lock
            .lock()
            .map_err(|_| "Projekt-Referenzsperre ist beschädigt.".to_string())?;
        validate_id(id)?;
        let lock = self.lock_for(id)?;
        let _guard = lock
            .lock()
            .map_err(|_| "Projekt-Sperre ist beschädigt.".to_string())?;
        let directory = self.root.join(id);
        if !directory.join(PROJECT_FILE).exists() {
            return Err("Projekt ist nicht mehr verfügbar.".into());
        }
        fs::remove_dir_all(directory).map_err(|error| error.to_string())
    }

    pub(crate) fn catalog_rename(
        &self,
        id: &str,
        name: &str,
        expected_revision: u64,
    ) -> Result<ProjectSaveResult, String> {
        let current = self.open(id)?;
        if current.revision != expected_revision {
            return Err("Speicherkonflikt: Das Dokument wurde zwischenzeitlich geändert.".into());
        }
        let mut project = current.project;
        project.name = validated_catalog_name(name)?;
        self.save(SaveProjectRequest {
            expected_updated_at: project.updated_at,
            expected_revision,
            project,
        })
    }

    #[cfg(test)]
    pub(crate) fn catalog_duplicate(
        &self,
        id: &str,
        name: Option<&str>,
        expected_revision: u64,
    ) -> Result<ProjectSaveResult, String> {
        let _references = self
            .reference_lock
            .lock()
            .map_err(|_| "Projekt-Referenzsperre ist beschädigt.".to_string())?;
        self.catalog_duplicate_locked(id, name, expected_revision, None)
    }

    pub(crate) fn catalog_duplicate_locked(
        &self,
        id: &str,
        name: Option<&str>,
        expected_revision: u64,
        target_id: Option<String>,
    ) -> Result<ProjectSaveResult, String> {
        if let Some(target_id) = target_id.as_deref() {
            validate_id(target_id)?;
            if self.root.join(target_id).join(PROJECT_FILE).exists() {
                return self.open_without_reference_lock(target_id);
            }
        }
        let source = self.open_without_reference_lock(id)?;
        if source.revision != expected_revision {
            return Err("Speicherkonflikt: Das Dokument wurde zwischenzeitlich geändert.".into());
        }
        let now = Utc::now();
        let mut project = source.project;
        project.id = target_id.unwrap_or_else(|| Uuid::new_v4().to_string());
        project.name = validated_catalog_name(name.unwrap_or(project.name.as_str()))?;
        project.created_at = now;
        project.updated_at = now;

        let node_ids = project
            .graph
            .nodes
            .iter()
            .map(|node| (node.id.clone(), Uuid::new_v4().to_string()))
            .collect::<HashMap<_, _>>();
        for node in &mut project.graph.nodes {
            node.id = node_ids[&node.id].clone();
            clear_transient_provider_state(&mut node.config);
        }
        for edge in &mut project.graph.edges {
            edge.id = Uuid::new_v4().to_string();
            edge.source_node_id = node_ids[&edge.source_node_id].clone();
            edge.target_node_id = node_ids[&edge.target_node_id].clone();
        }
        for group in &mut project.graph.groups {
            group.id = Uuid::new_v4().to_string();
            group.node_ids = group
                .node_ids
                .iter()
                .map(|id| node_ids[id].clone())
                .collect();
        }
        validate_project(&project)?;
        let directory = self.root.join(&project.id);
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        if let Err(error) = atomic_write(
            &directory.join(PROJECT_FILE),
            &serde_json::to_vec_pretty(&project).map_err(|error| error.to_string())?,
        )
        .and_then(|_| write_revision(&directory, 1))
        {
            let _ = fs::remove_dir_all(&directory);
            return Err(error);
        }
        Ok(ProjectSaveResult {
            project,
            revision: 1,
        })
    }

    pub(crate) fn catalog_backup(&self, id: &str) -> Result<(Vec<u8>, u64), String> {
        validate_id(id)?;
        let directory = self.root.join(id);
        Ok((
            fs::read(directory.join(PROJECT_FILE)).map_err(|error| error.to_string())?,
            read_revision(&directory)?,
        ))
    }

    pub(crate) fn catalog_restore(
        &self,
        id: &str,
        bytes: &[u8],
        revision: u64,
    ) -> Result<(), String> {
        validate_id(id)?;
        let directory = self.root.join(id);
        atomic_write(&directory.join(PROJECT_FILE), bytes)?;
        write_revision(&directory, revision)
    }

    pub(crate) fn catalog_stage_delete_locked(&self, id: &str) -> Result<PathBuf, String> {
        validate_id(id)?;
        let lock = self.lock_for(id)?;
        let _guard = lock
            .lock()
            .map_err(|_| "Projekt-Sperre ist beschädigt.".to_string())?;
        let source = self.root.join(id);
        if !source.join(PROJECT_FILE).exists() {
            return Err("Projekt ist nicht mehr verfügbar.".into());
        }
        let stage_root = self
            .root
            .parent()
            .unwrap_or(&self.root)
            .join("project-delete-staging");
        fs::create_dir_all(&stage_root).map_err(|error| error.to_string())?;
        let staged = stage_root.join(format!("{id}-{}", Uuid::new_v4()));
        fs::rename(&source, &staged).map_err(|error| error.to_string())?;
        sync_directory(&self.root)?;
        sync_directory(&stage_root)?;
        Ok(staged)
    }

    pub(crate) fn catalog_restore_staged_locked(
        &self,
        id: &str,
        staged: &Path,
    ) -> Result<(), String> {
        validate_id(id)?;
        let target = self.root.join(id);
        if target.exists() {
            return Err("Projekt kann nicht zurückgerollt werden: Ziel existiert bereits.".into());
        }
        fs::rename(staged, &target).map_err(|error| error.to_string())?;
        sync_directory(&self.root)
    }

    pub(crate) fn catalog_finalize_staged_delete(&self, staged: &Path) -> Result<(), String> {
        fs::remove_dir_all(staged).map_err(|error| error.to_string())?;
        if let Some(parent) = staged.parent() {
            sync_directory(parent)?;
        }
        Ok(())
    }

    fn open_without_reference_lock(&self, id: &str) -> Result<ProjectSaveResult, String> {
        validate_id(id)?;
        let directory = self.root.join(id);
        let (project, _) = self.read_with_recovery(&directory)?;
        Ok(ProjectSaveResult {
            project,
            revision: read_revision(&directory).unwrap_or(1),
        })
    }

    pub(crate) fn catalog_open_locked(&self, id: &str) -> Result<ProjectSaveResult, String> {
        self.open_without_reference_lock(id)
    }

    pub(crate) fn catalog_identity_locked(&self, id: &str) -> Result<(u64, String), String> {
        validate_id(id)?;
        let directory = self.root.join(id);
        Ok((
            read_revision(&directory).unwrap_or(1),
            hash_file(&directory.join(PROJECT_FILE))?,
        ))
    }

    pub fn save(&self, request: SaveProjectRequest) -> Result<ProjectSaveResult, String> {
        let _references = self
            .reference_lock
            .lock()
            .map_err(|_| "Projekt-Referenzsperre ist beschädigt.".to_string())?;
        self.catalog_save_locked(request)
    }

    pub(crate) fn catalog_save_locked(
        &self,
        mut request: SaveProjectRequest,
    ) -> Result<ProjectSaveResult, String> {
        normalize_legacy_media_configs(&mut request.project);
        validate_project(&request.project)?;
        let lock = self.lock_for(&request.project.id)?;
        let _guard = lock
            .lock()
            .map_err(|_| "Projekt-Sperre ist beschädigt.".to_string())?;
        let directory = self.root.join(&request.project.id);
        if !directory.join(PROJECT_FILE).exists() {
            return Err(
                "Projekt existiert nicht; Speichern legt keine Projekte implizit an.".into(),
            );
        }
        let (current, _) = self.read_with_recovery(&directory)?;
        let revision = read_revision(&directory).unwrap_or(1);
        if current.updated_at != request.expected_updated_at
            || revision != request.expected_revision
        {
            return Err(
                "Speicherkonflikt: Das Projekt wurde zwischenzeitlich geändert. Bitte neu laden."
                    .into(),
            );
        }
        if request.project.id != current.id || request.project.created_at != current.created_at {
            return Err("Projekt-ID und Erstellungszeit dürfen nicht verändert werden.".into());
        }
        rotate_validated_backups(&directory, self)?;
        let mut project = request.project;
        project.schema_version = PROJECT_SCHEMA_VERSION;
        project.updated_at = Utc::now();
        atomic_write(
            &directory.join(PROJECT_FILE),
            &serde_json::to_vec_pretty(&project).map_err(|e| e.to_string())?,
        )?;
        write_revision(&directory, revision + 1)?;
        Ok(ProjectSaveResult {
            project,
            revision: revision + 1,
        })
    }

    /// Linearizes media-result commits with project saves. The supplied operation
    /// runs while the same per-project lock used by `save` is held, so a node
    /// deletion/type change cannot race between revision validation and DB commit.
    #[allow(dead_code)]
    pub fn with_media_target<T>(
        &self,
        project_id: &str,
        node_id: &str,
        module_id: &str,
        expected_revision: u64,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        validate_id(project_id)?;
        let lock = self.lock_for(project_id)?;
        let _guard = lock
            .lock()
            .map_err(|_| "Projekt-Sperre ist beschädigt.".to_string())?;
        let directory = self.root.join(project_id);
        let (project, _) = self.read_with_recovery(&directory)?;
        let revision = read_revision(&directory).unwrap_or(1);
        if revision != expected_revision {
            return Err("Die Ziel-Node wurde während des Medienimports strukturell geändert. Bitte Import erneut starten.".into());
        }
        if !project
            .graph
            .nodes
            .iter()
            .any(|node| node.id == node_id && node.module_id == module_id)
        {
            return Err("Die Ziel-Node existiert nicht mehr oder hat einen anderen Typ.".into());
        }
        operation()
    }

    /// Issues a node-scoped grant. Canvas movement and unrelated graph edits do not
    /// invalidate it; replacing or removing the target module does.
    pub fn media_target_grant(
        &self,
        project_id: &str,
        node_id: &str,
        module_id: &str,
    ) -> Result<String, String> {
        self.with_project_lock(project_id, |project| {
            let node = project
                .graph
                .nodes
                .iter()
                .find(|node| node.id == node_id && node.module_id == module_id)
                .ok_or_else(|| {
                    "Die Ziel-Node existiert nicht mehr oder hat einen anderen Typ.".to_string()
                })?;
            Ok(media_node_grant(node))
        })
    }

    pub fn media_target_matches_grant(
        &self,
        project_id: &str,
        node_id: &str,
        module_id: &str,
        grant: &str,
    ) -> Result<bool, String> {
        self.with_project_lock(project_id, |project| {
            Ok(project
                .graph
                .nodes
                .iter()
                .find(|node| node.id == node_id && node.module_id == module_id)
                .is_some_and(|node| media_node_grant(node) == grant))
        })
    }

    pub fn with_media_target_grant<T>(
        &self,
        project_id: &str,
        node_id: &str,
        module_id: &str,
        grant: &str,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        validate_id(project_id)?;
        let lock = self.lock_for(project_id)?;
        let _guard = lock
            .lock()
            .map_err(|_| "Projekt-Sperre ist beschädigt.".to_string())?;
        let directory = self.root.join(project_id);
        let (project, _) = self.read_with_recovery(&directory)?;
        let current = project
            .graph
            .nodes
            .iter()
            .find(|node| node.id == node_id && node.module_id == module_id);
        if current.is_none_or(|node| media_node_grant(node) != grant) {
            return Err("Die Ziel-Node wurde entfernt oder in einen anderen Typ umgewandelt. Das geprüfte Medium bleibt zur Wiederherstellung erhalten.".into());
        }
        operation()
    }

    pub(crate) fn with_project_lock<T>(
        &self,
        project_id: &str,
        operation: impl FnOnce(&ProjectDocument) -> Result<T, String>,
    ) -> Result<T, String> {
        validate_id(project_id)?;
        let lock = self.lock_for(project_id)?;
        let _guard = lock
            .lock()
            .map_err(|_| "Projekt-Sperre ist beschädigt.".to_string())?;
        let directory = self.root.join(project_id);
        let (project, _) = self.read_with_recovery(&directory)?;
        operation(&project)
    }

    pub fn repair_orphans(&self) -> Result<(), String> {
        for entry in fs::read_dir(&self.root).map_err(|e| e.to_string())? {
            let directory = match entry {
                Ok(e) if e.path().is_dir() => e.path(),
                _ => continue,
            };
            if let Ok(files) = fs::read_dir(&directory) {
                for file in files.flatten() {
                    if file.path().extension().and_then(|v| v.to_str()) == Some("tmp") {
                        let _ = fs::remove_file(file.path());
                    }
                }
            }
            let _ = self.read_with_recovery(&directory); // One corrupt project never blocks startup.
        }
        Ok(())
    }

    fn read_with_recovery(&self, directory: &Path) -> Result<(ProjectDocument, bool), String> {
        let primary = directory.join(PROJECT_FILE);
        match self.read_path(&primary) {
            Ok(project) => Ok((project, false)),
            Err(primary_error) => {
                if file_has_newer_schema(&primary) {
                    return Err(primary_error);
                }
                for index in 1..=BACKUP_COUNT {
                    let backup = directory.join(format!("{PROJECT_FILE}.bak.{index}"));
                    if let Ok(project) = self.read_path(&backup) {
                        if primary.exists() {
                            quarantine(&primary, "corrupt")?;
                        }
                        atomic_write(&primary, &fs::read(&backup).map_err(|e| e.to_string())?)?;
                        return Ok((project, true));
                    }
                }
                Err(primary_error)
            }
        }
    }

    fn read_path(&self, path: &Path) -> Result<ProjectDocument, String> {
        let mut bytes = vec![];
        File::open(path)
            .and_then(|mut f| f.read_to_end(&mut bytes))
            .map_err(|e| format!("Projekt konnte nicht geöffnet werden: {e}"))?;
        let mut project: ProjectDocument = serde_json::from_slice(&bytes)
            .map_err(|e| format!("Projektdatei ist ungültig: {e}"))?;
        normalize_legacy_media_configs(&mut project);
        validate_project(&project)?;
        Ok(project)
    }

    fn lock_for(&self, id: &str) -> Result<Arc<Mutex<()>>, String> {
        let mut locks = self
            .project_locks
            .lock()
            .map_err(|_| "Projekt-Sperrverwaltung ist beschädigt.".to_string())?;
        Ok(locks
            .entry(id.to_owned())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone())
    }
}

fn normalize_legacy_media_configs(project: &mut ProjectDocument) {
    for node in &mut project.graph.nodes {
        let kind = match node.module_id.as_str() {
            "core.video-input" => "video",
            "core.audio-input" => "audio",
            _ => continue,
        };
        let Some(metadata) = node
            .config
            .get_mut("mediaMetadata")
            .and_then(Value::as_object_mut)
        else {
            continue;
        };
        if metadata.contains_key("playable") {
            continue;
        }
        let codecs: Vec<_> = metadata
            .get("codecs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        let container = metadata
            .get("container")
            .and_then(Value::as_str)
            .unwrap_or_default();
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
        let webm_mismatch = container.contains("webm")
            && codecs
                .iter()
                .any(|codec| !["vp8", "vp9", "av1", "opus", "vorbis"].contains(codec));
        let playable = !codecs.is_empty()
            && codecs.iter().all(|codec| playable_codecs.contains(codec))
            && !webm_mismatch;
        metadata.insert("playable".into(), Value::Bool(playable));
        if !playable && !metadata.contains_key("playbackWarning") {
            metadata.insert(
                "playbackWarning".into(),
                Value::String(format!(
                    "Älterer {kind}-Import: Vorschau-Kompatibilität konnte nicht sicher bestätigt werden; das Original bleibt erhalten."
                )),
            );
        }
    }
}

fn validate_project(project: &ProjectDocument) -> Result<(), String> {
    validate_id(&project.id)?;
    if project.schema_version > PROJECT_SCHEMA_VERSION {
        return Err(format!("Dieses Projekt verwendet Schema-Version {}. FlowZ unterstützt höchstens Version {PROJECT_SCHEMA_VERSION}; die Datei wurde nicht verändert.", project.schema_version));
    }
    if project.schema_version != PROJECT_SCHEMA_VERSION {
        return Err(
            "Das Rust-Repository akzeptiert ausschließlich migrierte Schema-v2-Projekte.".into(),
        );
    }
    if project.name.trim().is_empty()
        || !project.canvas.viewport.x.is_finite()
        || !project.canvas.viewport.y.is_finite()
        || !project.canvas.viewport.zoom.is_finite()
        || project.canvas.viewport.zoom <= 0.0
    {
        return Err("Projektname oder Canvas-Viewport ist ungültig.".into());
    }
    let ids: HashSet<_> = project.graph.nodes.iter().map(|n| n.id.as_str()).collect();
    if ids.len() != project.graph.nodes.len()
        || project.graph.nodes.iter().any(|n| {
            n.id.is_empty()
                || n.module_id.is_empty()
                || n.module_version == 0
                || !n.position.x.is_finite()
                || !n.position.y.is_finite()
        })
    {
        return Err("Nodes enthalten ungültige oder doppelte IDs/Werte.".into());
    }
    for node in &project.graph.nodes {
        if let Some(binding) = node.config.get("directMedia") {
            validate_direct_media_binding(&node.module_id, binding)?;
        }
        if node.module_id == "core.video-input" {
            validate_media_node_config(&node.config, "video")?;
        }
        if node.module_id == "core.audio-input" {
            validate_media_node_config(&node.config, "audio")?;
        }
        if node.module_id == "ai.transcription" {
            let allowed = ["model", "language", "timestamps"];
            let model = node
                .config
                .get("model")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let language = node
                .config
                .get("language")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if node
                .config
                .keys()
                .any(|key| !allowed.contains(&key.as_str()))
                || model.is_empty()
                || model.len() > 200
                || !(language == "auto"
                    || (language.len() == 2
                        && language
                            .chars()
                            .all(|character| character.is_ascii_lowercase())))
                || !node.config.get("timestamps").is_some_and(Value::is_boolean)
            {
                return Err("Transkriptionskonfiguration ist ungültig.".into());
            }
        }
    }
    const JS_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
    if project.graph.edges.iter().any(|e| {
        e.id.is_empty()
            || e.source_port_id.is_empty()
            || e.target_port_id.is_empty()
            || e.order > JS_MAX_SAFE_INTEGER
            || !ids.contains(e.source_node_id.as_str())
            || !ids.contains(e.target_node_id.as_str())
    }) {
        return Err("Eine Verbindung verweist auf einen unbekannten Node.".into());
    }
    let edge_ids: HashSet<_> = project
        .graph
        .edges
        .iter()
        .map(|edge| edge.id.as_str())
        .collect();
    if edge_ids.len() != project.graph.edges.len() {
        return Err("Verbindungen enthalten doppelte IDs.".into());
    }
    let mut target_orders = HashSet::new();
    if project.graph.edges.iter().any(|edge| {
        !target_orders.insert((
            edge.target_node_id.as_str(),
            edge.target_port_id.as_str(),
            edge.order,
        ))
    }) {
        return Err("Verbindungen enthalten doppelte Reihenfolgen am selben Ziel-Port.".into());
    }
    let group_ids: HashSet<_> = project
        .graph
        .groups
        .iter()
        .map(|group| group.id.as_str())
        .collect();
    if group_ids.len() != project.graph.groups.len()
        || project.graph.groups.iter().any(|group| {
            group.id.is_empty()
                || group.name.trim().is_empty()
                || group.node_ids.iter().any(|id| !ids.contains(id.as_str()))
        })
    {
        return Err("Gruppen enthalten ungültige IDs oder Node-Verweise.".into());
    }
    let mut grouped_nodes = HashSet::new();
    for group in &project.graph.groups {
        let mut members_in_group = HashSet::new();
        for node_id in &group.node_ids {
            if !members_in_group.insert(node_id.as_str()) {
                return Err(format!(
                    "Node {node_id} kommt mehrfach in Gruppe {} vor.",
                    group.id
                ));
            }
            if !grouped_nodes.insert(node_id.as_str()) {
                return Err(format!("Node {node_id} gehört zu mehr als einer Gruppe."));
            }
        }
    }
    reject_secrets(&serde_json::to_value(project).map_err(|e| e.to_string())?)
}

fn validate_direct_media_binding(module_id: &str, value: &Value) -> Result<(), String> {
    const MODULES: [&str; 7] = [
        "ai.image-analysis",
        "image.upscale",
        "image.background-removal",
        "image.transform",
        "image.trim-transparent",
        "ai.image-generation",
        "brand.logo-design",
    ];
    if !MODULES.contains(&module_id) {
        return Err("Direkte Bildreferenz ist für dieses Modul nicht zulässig.".into());
    }
    let object = value
        .as_object()
        .ok_or("Direkte Bildreferenz muss ein Objekt sein.")?;
    let exact = |object: &Map<String, Value>, allowed: &[&str]| {
        object.len() == allowed.len() && object.keys().all(|key| allowed.contains(&key.as_str()))
    };
    let bounded_id = |value: Option<&Value>| {
        value.and_then(Value::as_str).is_some_and(|text| {
            !text.is_empty()
                && text.len() <= 512
                && !text.chars().any(|character| character.is_control())
        })
    };
    if !exact(
        object,
        &[
            "schemaVersion",
            "kind",
            "blobHash",
            "mediaType",
            "priority",
            "source",
        ],
    ) || object.get("schemaVersion").and_then(Value::as_u64) != Some(1)
        || object.get("kind").and_then(Value::as_str) != Some("image")
        || !object
            .get("blobHash")
            .and_then(Value::as_str)
            .is_some_and(|hash| {
                hash.len() == 64
                    && hash
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
        || !object
            .get("mediaType")
            .and_then(Value::as_str)
            .is_some_and(|mime| {
                mime.starts_with("image/")
                    && mime.len() > 6
                    && mime.len() <= 86
                    && mime
                        .bytes()
                        .skip(6)
                        .all(|byte| byte.is_ascii_alphanumeric() || b".+-".contains(&byte))
            })
        || !matches!(
            object.get("priority").and_then(Value::as_str),
            Some("fallback" | "override")
        )
    {
        return Err("Direkte Bildreferenz verletzt den CAS-Vertrag.".into());
    }
    let source = object
        .get("source")
        .and_then(Value::as_object)
        .ok_or("Direkte Bildreferenz hat keine Provenienz.")?;
    match source.get("kind").and_then(Value::as_str) {
        Some("asset-version")
            if exact(source, &["kind", "assetId", "versionId", "version"])
                && bounded_id(source.get("assetId"))
                && bounded_id(source.get("versionId"))
                && source
                    .get("version")
                    .and_then(Value::as_u64)
                    .is_some_and(|version| (1..=9_007_199_254_740_991).contains(&version)) =>
        {
            Ok(())
        }
        Some("project-result")
            if exact(
                source,
                &["kind", "projectId", "projectRevision", "resultId"],
            ) && bounded_id(source.get("projectId"))
                && bounded_id(source.get("resultId"))
                && source
                    .get("projectRevision")
                    .and_then(Value::as_u64)
                    .is_some_and(|revision| revision <= 9_007_199_254_740_991) =>
        {
            Ok(())
        }
        _ => Err("Direkte Bildreferenz hat keine gültige revisionsgebundene Provenienz.".into()),
    }
}

fn validate_media_node_config(config: &Map<String, Value>, kind: &str) -> Result<(), String> {
    if config.is_empty() {
        return Ok(());
    }
    let allowed = [
        "blobHash",
        "posterHash",
        "mediaType",
        "mediaMetadata",
        "fileName",
    ];
    if config.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(format!("{kind}-Import enthält unbekannte Konfiguration."));
    }
    let hash = |value: Option<&Value>| {
        value.and_then(Value::as_str).is_some_and(|value| {
            value.len() == 64
                && value.chars().all(|c| c.is_ascii_hexdigit())
                && value == value.to_ascii_lowercase()
        })
    };
    if !hash(config.get("blobHash")) {
        return Err(format!("{kind}-Import enthält keine gültige Blob-ID."));
    }
    if kind == "audio" && config.contains_key("posterHash")
        || config
            .get("posterHash")
            .is_some_and(|value| !hash(Some(value)))
    {
        return Err("Ungültige Poster-ID am Medienimport.".into());
    }
    let file_name = config.get("fileName").and_then(Value::as_str).unwrap_or("");
    if file_name.is_empty() || file_name.len() > 255 || file_name.contains(['/', '\\', '\r', '\n'])
    {
        return Err("Ungültiger Medien-Dateiname.".into());
    }
    let mime = config
        .get("mediaType")
        .and_then(Value::as_str)
        .unwrap_or("");
    let allowed_mimes: &[&str] = if kind == "video" {
        &["video/mp4", "video/webm", "video/quicktime"]
    } else {
        &[
            "audio/mp4",
            "audio/webm",
            "audio/wav",
            "audio/flac",
            "audio/mpeg",
            "audio/ogg",
        ]
    };
    if !allowed_mimes.contains(&mime) {
        return Err("Ungültiger Medien-MIME-Typ.".into());
    }
    let metadata = config
        .get("mediaMetadata")
        .and_then(Value::as_object)
        .ok_or("Medienmetadaten fehlen.")?;
    let metadata_allowed = [
        "kind",
        "container",
        "codecs",
        "durationSeconds",
        "width",
        "height",
        "fps",
        "sampleRate",
        "channels",
        "playable",
        "playbackWarning",
    ];
    if metadata
        .keys()
        .any(|key| !metadata_allowed.contains(&key.as_str()))
        || metadata.get("kind").and_then(Value::as_str) != Some(kind)
    {
        return Err("Medienmetadaten passen nicht zum Node-Typ.".into());
    }
    let positive = |key: &str, max: f64| {
        metadata
            .get(key)
            .and_then(Value::as_f64)
            .is_some_and(|value| value.is_finite() && value > 0.0 && value <= max)
    };
    if !positive("durationSeconds", 604_800.0)
        || metadata.get("playable").and_then(Value::as_bool).is_none()
    {
        return Err("Mediendauer oder Abspielstatus ist ungültig.".into());
    }
    let container = metadata
        .get("container")
        .and_then(Value::as_str)
        .unwrap_or("");
    let codecs = metadata
        .get("codecs")
        .and_then(Value::as_array)
        .ok_or("Medien-Codecs fehlen.")?;
    if container.is_empty()
        || container.len() > 120
        || codecs.is_empty()
        || codecs.len() > 16
        || codecs.iter().any(|value| {
            value
                .as_str()
                .is_none_or(|value| value.is_empty() || value.len() > 64)
        })
    {
        return Err("Container oder Codec-Liste ist ungültig.".into());
    }
    let warning = metadata.get("playbackWarning");
    if warning.is_some_and(|value| {
        value
            .as_str()
            .is_none_or(|text| text.is_empty() || text.len() > 300)
    }) || metadata.get("playable") == Some(&Value::Bool(true)) && warning.is_some()
    {
        return Err("Ungültiger Vorschauhinweis.".into());
    }
    if kind == "video" {
        if !positive("width", 32_768.0)
            || !positive("height", 32_768.0)
            || metadata
                .get("width")
                .and_then(Value::as_f64)
                .unwrap_or(f64::INFINITY)
                * metadata
                    .get("height")
                    .and_then(Value::as_f64)
                    .unwrap_or(f64::INFINITY)
                > 134_217_728.0
            || !positive("fps", 1_000.0)
            || metadata.contains_key("sampleRate")
            || metadata.contains_key("channels")
        {
            return Err("Video-Spurmetadaten sind ungültig.".into());
        }
    } else if !positive("sampleRate", 768_000.0)
        || !positive("channels", 64.0)
        || metadata.contains_key("width")
        || metadata.contains_key("height")
        || metadata.contains_key("fps")
    {
        return Err("Audio-Spurmetadaten sind ungültig.".into());
    }
    Ok(())
}

fn has_recovery_quarantine(directory: &Path) -> bool {
    fs::read_dir(directory).ok().is_some_and(|entries| {
        entries.flatten().any(|entry| {
            entry.file_name().to_string_lossy().contains("corrupt")
                && entry.file_name().to_string_lossy().ends_with(".quarantine")
        })
    })
}

fn validate_id(id: &str) -> Result<(), String> {
    Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| "Ungültige Projekt-ID.".into())
}

fn reject_secrets(value: &Value) -> Result<(), String> {
    const FIELDS: &[&str] = &[
        "apikey",
        "apiaccesskey",
        "token",
        "apitoken",
        "bearertoken",
        "accesstoken",
        "refreshtoken",
        "authorization",
        "password",
        "passwd",
        "providersecret",
        "clientsecret",
        "privatekey",
        "credential",
        "openrouterkey",
        "falkey",
        "providerkey",
    ];
    match value {
        Value::Object(object) => {
            for (key, child) in object {
                let key_normalized: String = key
                    .chars()
                    .filter(|c| c.is_ascii_alphanumeric())
                    .flat_map(char::to_lowercase)
                    .collect();
                if FIELDS.contains(&key_normalized.as_str()) || key_normalized.ends_with("apikey") {
                    return Err(format!("Das Feld „{key}“ sieht wie ein Secret aus und darf nicht gespeichert werden."));
                }
                reject_secrets(child)?;
            }
        }
        Value::Array(items) => {
            for item in items {
                reject_secrets(item)?;
            }
        }
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.starts_with("sk-or-")
                || trimmed.starts_with("sk-")
                || trimmed.starts_with("ghp_")
                || trimmed.starts_with("github_pat_")
                || trimmed.starts_with("AKIA")
                || trimmed.starts_with("xoxb-")
                || trimmed.starts_with("Bearer ")
                || trimmed.contains("-----BEGIN PRIVATE KEY-----")
            {
                return Err("Ein Secret-Wert darf nicht im Projekt gespeichert werden.".into());
            }
        }
        _ => {}
    }
    Ok(())
}

fn file_has_newer_schema(path: &Path) -> bool {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| value.get("schemaVersion").and_then(Value::as_u64))
        .is_some_and(|version| version > PROJECT_SCHEMA_VERSION as u64)
}

fn rotate_validated_backups(
    directory: &Path,
    repository: &ProjectRepository,
) -> Result<(), String> {
    let primary = directory.join(PROJECT_FILE);
    repository.read_path(&primary)?;
    let oldest = directory.join(format!("{PROJECT_FILE}.bak.{BACKUP_COUNT}"));
    if oldest.exists() {
        fs::remove_file(oldest).map_err(|e| e.to_string())?;
    }
    for index in (1..BACKUP_COUNT).rev() {
        let from = directory.join(format!("{PROJECT_FILE}.bak.{index}"));
        if from.exists() && repository.read_path(&from).is_ok() {
            fs::rename(
                &from,
                directory.join(format!("{PROJECT_FILE}.bak.{}", index + 1)),
            )
            .map_err(|e| e.to_string())?;
        }
    }
    atomic_write(
        &directory.join(format!("{PROJECT_FILE}.bak.1")),
        &fs::read(primary).map_err(|e| e.to_string())?,
    )
}

fn revision_path(directory: &Path) -> PathBuf {
    directory.join("revision")
}
fn read_revision(directory: &Path) -> Result<u64, String> {
    fs::read_to_string(revision_path(directory))
        .map_err(|e| e.to_string())?
        .trim()
        .parse()
        .map_err(|e: std::num::ParseIntError| e.to_string())
}
fn write_revision(directory: &Path, revision: u64) -> Result<(), String> {
    atomic_write(&revision_path(directory), revision.to_string().as_bytes())
}
fn quarantine(path: &Path, reason: &str) -> Result<(), String> {
    fs::rename(
        path,
        path.with_extension(format!(
            "{reason}.{}.quarantine",
            Utc::now().timestamp_millis()
        )),
    )
    .map_err(|e| e.to_string())
}

fn atomic_write(destination: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = destination.parent().ok_or("Ungültiger Speicherpfad.")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        destination
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or("flowz"),
        Uuid::new_v4()
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        fs::rename(&temporary, destination).map_err(|e| e.to_string())?;
        sync_directory(parent)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn repo_project(repo: &ProjectRepository) -> ProjectSaveResult {
        repo.create(CreateProjectRequest {
            name: "Fixture".into(),
        })
        .unwrap()
    }
    #[test]
    fn direct_media_is_strict_cas_only_and_revision_bound() {
        let valid = serde_json::json!({"schemaVersion":1,"kind":"image","blobHash":"a".repeat(64),"mediaType":"image/png","priority":"fallback","source":{"kind":"project-result","projectId":"project","projectRevision":4,"resultId":"result"}});
        assert!(validate_direct_media_binding("ai.image-analysis", &valid).is_ok());
        let mut path = valid.clone();
        path["blobHash"] = Value::String("/tmp/private.png".into());
        assert!(validate_direct_media_binding("ai.image-analysis", &path).is_err());
        let mut unknown = valid.clone();
        unknown.as_object_mut().unwrap().insert(
            "url".into(),
            Value::String("https://example.test/image.png".into()),
        );
        assert!(validate_direct_media_binding("ai.image-analysis", &unknown).is_err());
        assert!(validate_direct_media_binding("core.text-input", &valid).is_err());
    }
    #[test]
    fn media_configs_are_strictly_bounded_and_kind_safe() {
        assert!(validate_media_node_config(&Map::new(), "video").is_ok());
        let valid = serde_json::json!({"blobHash":"a".repeat(64),"posterHash":"b".repeat(64),"mediaType":"video/mp4","fileName":"clip.mp4","mediaMetadata":{"kind":"video","container":"mov,mp4","codecs":["h264"],"durationSeconds":2.0,"width":1920,"height":1080,"fps":25.0,"playable":true}}).as_object().unwrap().clone();
        assert!(validate_media_node_config(&valid, "video").is_ok());
        let mut invalid = valid.clone();
        invalid.insert("fileName".into(), Value::String("../clip.mp4".into()));
        assert!(validate_media_node_config(&invalid, "video").is_err());
        let mut invalid = valid.clone();
        invalid.insert("mediaType".into(), Value::String("audio/mp4".into()));
        assert!(validate_media_node_config(&invalid, "video").is_err());
    }
    #[test]
    fn legacy_media_snapshot_without_playable_is_normalized_in_module_v1() {
        let temp = tempfile::tempdir().unwrap();
        let repo = ProjectRepository::new(temp.path().join("projects")).unwrap();
        let mut record = repo_project(&repo);
        record.project.graph.nodes.push(GraphNode {
            id: "media".into(), module_id: "core.video-input".into(), module_version: 1,
            position: CanvasPosition { x: 0.0, y: 0.0 }, label: None,label_id:None,
            config: serde_json::json!({"blobHash":"a".repeat(64),"posterHash":"b".repeat(64),"mediaType":"video/mp4","fileName":"clip.mp4","mediaMetadata":{"kind":"video","container":"mov,mp4","codecs":["h264"],"durationSeconds":2.0,"width":1920,"height":1080,"fps":25.0}}).as_object().unwrap().clone(),
            update_policy: UpdatePolicy::Manual,
        });
        let expected_updated_at = record.project.updated_at;
        let saved = repo
            .save(SaveProjectRequest {
                project: record.project,
                expected_updated_at,
                expected_revision: record.revision,
            })
            .unwrap();
        let metadata = saved.project.graph.nodes[0].config["mediaMetadata"]
            .as_object()
            .unwrap();
        assert_eq!(metadata.get("playable"), Some(&Value::Bool(true)));
        assert_eq!(saved.project.graph.nodes[0].module_version, 1);
    }
    #[test]
    fn media_target_grant_is_revision_and_module_bound() {
        let temp = tempfile::tempdir().unwrap();
        let repo = ProjectRepository::new(temp.path().join("projects")).unwrap();
        let mut record = repo_project(&repo);
        record.project.graph.nodes.push(GraphNode {
            id: "media".into(),
            module_id: "core.video-input".into(),
            module_version: 1,
            position: CanvasPosition { x: 0.0, y: 0.0 },
            label: None,
            label_id: None,
            config: Map::new(),
            update_policy: UpdatePolicy::Manual,
        });
        let saved = repo
            .save(SaveProjectRequest {
                expected_updated_at: record.project.updated_at,
                expected_revision: record.revision,
                project: record.project,
            })
            .unwrap();
        assert_eq!(
            repo.with_media_target(
                &saved.project.id,
                "media",
                "core.video-input",
                saved.revision,
                || Ok(7)
            )
            .unwrap(),
            7
        );
        let mut changed = saved.project.clone();
        changed.graph.nodes[0].module_id = "core.audio-input".into();
        let changed = repo
            .save(SaveProjectRequest {
                expected_updated_at: saved.project.updated_at,
                expected_revision: saved.revision,
                project: changed,
            })
            .unwrap();
        let called = std::sync::atomic::AtomicBool::new(false);
        assert!(repo
            .with_media_target(
                &changed.project.id,
                "media",
                "core.video-input",
                saved.revision,
                || {
                    called.store(true, std::sync::atomic::Ordering::SeqCst);
                    Ok(())
                }
            )
            .is_err());
        assert!(!called.load(std::sync::atomic::Ordering::SeqCst));
        assert!(repo
            .with_media_target(
                &changed.project.id,
                "media",
                "core.video-input",
                changed.revision,
                || Ok(())
            )
            .is_err());
    }
    #[test]
    fn node_scoped_media_grant_tolerates_unrelated_saves_but_not_target_replacement() {
        let temp = tempfile::tempdir().unwrap();
        let repo = ProjectRepository::new(temp.path().join("projects")).unwrap();
        let mut record = repo_project(&repo);
        record.project.graph.nodes.push(GraphNode {
            id: "audio".into(),
            module_id: "core.audio-input".into(),
            module_version: 1,
            position: CanvasPosition { x: 0.0, y: 0.0 },
            label: None,
            label_id: None,
            config: Map::new(),
            update_policy: UpdatePolicy::Manual,
        });
        let saved = repo
            .save(SaveProjectRequest {
                expected_updated_at: record.project.updated_at,
                expected_revision: record.revision,
                project: record.project,
            })
            .unwrap();
        let grant = repo
            .media_target_grant(&saved.project.id, "audio", "core.audio-input")
            .unwrap();
        let mut unrelated = saved.project.clone();
        unrelated.canvas.viewport.x = 42.0;
        let unrelated = repo
            .save(SaveProjectRequest {
                expected_updated_at: saved.project.updated_at,
                expected_revision: saved.revision,
                project: unrelated,
            })
            .unwrap();
        assert!(repo
            .media_target_matches_grant(&unrelated.project.id, "audio", "core.audio-input", &grant)
            .unwrap());
        assert_eq!(
            repo.with_media_target_grant(
                &unrelated.project.id,
                "audio",
                "core.audio-input",
                &grant,
                || Ok(9)
            )
            .unwrap(),
            9
        );
        let mut replaced = unrelated.project.clone();
        replaced
            .graph
            .nodes
            .iter_mut()
            .find(|node| node.id == "audio")
            .unwrap()
            .module_id = "core.text-input".into();
        let replaced = repo
            .save(SaveProjectRequest {
                expected_updated_at: unrelated.project.updated_at,
                expected_revision: unrelated.revision,
                project: replaced,
            })
            .unwrap();
        assert!(!repo
            .media_target_matches_grant(&replaced.project.id, "audio", "core.audio-input", &grant)
            .unwrap());
        assert!(repo
            .with_media_target_grant(
                &replaced.project.id,
                "audio",
                "core.audio-input",
                &grant,
                || Ok(())
            )
            .is_err());
    }
    #[test]
    fn transcription_config_is_strict_and_symmetric_with_typescript() {
        let temp = tempfile::tempdir().unwrap();
        let repo = ProjectRepository::new(temp.path().join("projects")).unwrap();
        let mut record = repo_project(&repo);
        record.project.graph.nodes.push(GraphNode { id: "stt".into(), module_id: "ai.transcription".into(), module_version: 1, position: CanvasPosition { x: 0.0, y: 0.0 }, label: None,label_id:None, config: serde_json::from_value(serde_json::json!({"model":"openai/whisper-1","language":"auto","timestamps":false})).unwrap(), update_policy: UpdatePolicy::Manual });
        let saved = repo
            .save(SaveProjectRequest {
                expected_updated_at: record.project.updated_at,
                expected_revision: record.revision,
                project: record.project,
            })
            .unwrap();
        let revision = saved.revision;
        let mut invalid = saved.project;
        invalid
            .graph
            .nodes
            .last_mut()
            .unwrap()
            .config
            .insert("language".into(), Value::String("de-DE".into()));
        assert!(repo
            .save(SaveProjectRequest {
                expected_updated_at: invalid.updated_at,
                expected_revision: revision,
                project: invalid.clone(),
            })
            .is_err());
        invalid
            .graph
            .nodes
            .last_mut()
            .unwrap()
            .config
            .insert("language".into(), Value::String("auto".into()));
        invalid
            .graph
            .nodes
            .last_mut()
            .unwrap()
            .config
            .insert("model".into(), Value::String("x".repeat(201)));
        assert!(repo
            .save(SaveProjectRequest {
                expected_updated_at: invalid.updated_at,
                expected_revision: revision,
                project: invalid,
            })
            .is_err());
    }
    #[test]
    fn typescript_schema_v2_fixture_is_compatible() {
        let fixture = include_str!("../../tests/fixtures/project-v2.json");
        let project: ProjectDocument = serde_json::from_str(fixture).unwrap();
        assert_eq!(project.schema_version, 2);
        assert_eq!(project.graph.nodes[0].module_id, "core.text-input");
        let encoded = serde_json::to_value(project).unwrap();
        assert!(encoded.pointer("/canvas/viewport/zoom").is_some());
        assert!(encoded.pointer("/graph/groups").is_some());
    }
    #[test]
    fn schema_v2_fixture_roundtrip_and_revision_conflict() {
        let temp = tempfile::tempdir().unwrap();
        let repo = ProjectRepository::new(temp.path().join("projects")).unwrap();
        let mut record = repo_project(&repo);
        record.project.graph.nodes.push(GraphNode {
            id: "n1".into(),
            module_id: "core.text-input".into(),
            module_version: 1,
            position: CanvasPosition { x: 1.0, y: 2.0 },
            label: None,
            label_id: None,
            config: Map::new(),
            update_policy: UpdatePolicy::Manual,
        });
        let saved = repo
            .save(SaveProjectRequest {
                project: record.project.clone(),
                expected_updated_at: record.project.updated_at,
                expected_revision: record.revision,
            })
            .unwrap();
        assert_eq!(
            repo.open(&saved.project.id)
                .unwrap()
                .project
                .graph
                .nodes
                .len(),
            1
        );
        assert!(repo
            .save(SaveProjectRequest {
                project: saved.project.clone(),
                expected_updated_at: saved.project.updated_at,
                expected_revision: 1
            })
            .unwrap_err()
            .contains("Speicherkonflikt"));
    }
    #[test]
    fn corrupt_primary_recovers_validated_backup() {
        let temp = tempfile::tempdir().unwrap();
        let repo = ProjectRepository::new(temp.path().join("projects")).unwrap();
        let record = repo_project(&repo);
        let saved = repo
            .save(SaveProjectRequest {
                project: record.project.clone(),
                expected_updated_at: record.project.updated_at,
                expected_revision: 1,
            })
            .unwrap();
        fs::write(
            repo.root.join(&saved.project.id).join(PROJECT_FILE),
            b"broken",
        )
        .unwrap();
        assert_eq!(
            repo.open(&saved.project.id).unwrap().project.name,
            "Fixture"
        );
    }
    #[test]
    fn refuses_newer_schema_without_overwriting() {
        let temp = tempfile::tempdir().unwrap();
        let repo = ProjectRepository::new(temp.path().join("projects")).unwrap();
        let record = repo_project(&repo);
        let saved = repo
            .save(SaveProjectRequest {
                project: record.project.clone(),
                expected_updated_at: record.project.updated_at,
                expected_revision: record.revision,
            })
            .unwrap();
        let path = repo.root.join(&saved.project.id).join(PROJECT_FILE);
        let mut raw: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        raw["schemaVersion"] = (PROJECT_SCHEMA_VERSION + 1).into();
        fs::write(&path, serde_json::to_vec(&raw).unwrap()).unwrap();
        let before = fs::read(&path).unwrap();
        assert!(repo
            .open(&saved.project.id)
            .unwrap_err()
            .contains("höchstens"));
        assert_eq!(fs::read(path).unwrap(), before);
    }

    #[test]
    fn rust_json_omits_absent_typescript_optional_fields() {
        let temp = tempfile::tempdir().unwrap();
        let repo = ProjectRepository::new(temp.path().join("projects")).unwrap();
        let mut project = repo_project(&repo).project;
        project.graph.nodes.push(GraphNode {
            id: "node".into(),
            module_id: "core.text-input".into(),
            module_version: 1,
            position: CanvasPosition { x: 0.0, y: 0.0 },
            label: None,
            label_id: None,
            config: Map::new(),
            update_policy: UpdatePolicy::Manual,
        });
        project.graph.groups.push(WorkflowGroup {
            id: "group".into(),
            name: "Group".into(),
            node_ids: vec!["node".into()],
            color: None,
            description: None,
        });
        let encoded = serde_json::to_value(project).unwrap();
        assert!(encoded.pointer("/graph/nodes/0/label").is_none());
        assert!(encoded.pointer("/graph/nodes/0/groupId").is_none());
        assert!(encoded.pointer("/graph/groups/0/color").is_none());
        assert!(encoded.pointer("/graph/groups/0/description").is_none());
    }

    #[test]
    fn edge_order_is_js_safe_and_unique_per_target_port() {
        let fixture = include_str!("../../tests/fixtures/project-v2.json");
        let mut project: ProjectDocument = serde_json::from_str(fixture).unwrap();
        project.graph.edges.push(GraphEdge {
            id: "edge-2".into(),
            source_node_id: "text-1".into(),
            source_port_id: "text".into(),
            target_node_id: "generate-1".into(),
            target_port_id: "text".into(),
            order: 0,
        });
        assert!(validate_project(&project)
            .unwrap_err()
            .contains("Reihenfolgen"));
        project.graph.edges[1].order = 9_007_199_254_740_992;
        assert!(validate_project(&project).is_err());
    }

    #[test]
    fn rejects_zero_module_version_and_blank_group_name() {
        let fixture = include_str!("../../tests/fixtures/project-v2.json");
        let mut project: ProjectDocument = serde_json::from_str(fixture).unwrap();
        project.graph.nodes[0].module_version = 0;
        assert!(validate_project(&project).is_err());

        let mut project: ProjectDocument = serde_json::from_str(fixture).unwrap();
        project.graph.groups[0].name = "   ".into();
        assert!(validate_project(&project).is_err());
    }

    #[test]
    fn rejects_duplicate_and_cross_group_membership() {
        let fixture = include_str!("../../tests/fixtures/project-v2.json");
        let mut project: ProjectDocument = serde_json::from_str(fixture).unwrap();
        let node_id = project.graph.groups[0].node_ids[0].clone();
        project.graph.groups[0].node_ids.push(node_id.clone());
        assert!(validate_project(&project).unwrap_err().contains("mehrfach"));

        let mut project: ProjectDocument = serde_json::from_str(fixture).unwrap();
        project.graph.groups.push(WorkflowGroup {
            id: "second-group".into(),
            name: "Zweite Gruppe".into(),
            node_ids: vec![node_id],
            color: None,
            description: None,
        });
        assert!(validate_project(&project)
            .unwrap_err()
            .contains("mehr als einer"));
    }

    #[test]
    fn provider_credential_fields_are_rejected() {
        for field in ["falKey", "providerKey", "openrouterKey"] {
            let temp = tempfile::tempdir().unwrap();
            let repo = ProjectRepository::new(temp.path().join("projects")).unwrap();
            let mut project = repo_project(&repo).project;
            let mut config = Map::new();
            config.insert(field.into(), Value::String("not-even-a-real-secret".into()));
            project.graph.nodes.push(GraphNode {
                id: "node".into(),
                module_id: "core.text-input".into(),
                module_version: 1,
                position: CanvasPosition { x: 0.0, y: 0.0 },
                label: None,
                label_id: None,
                config,
                update_policy: UpdatePolicy::Manual,
            });
            assert!(validate_project(&project).unwrap_err().contains("Secret"));
        }
    }

    #[test]
    fn secret_filter_allows_key_related_ui_fields_and_plain_words() {
        let temp = tempfile::tempdir().unwrap();
        let repo = ProjectRepository::new(temp.path().join("projects")).unwrap();
        let mut project = repo_project(&repo).project;
        let mut config = Map::new();
        config.insert("hotkey".into(), Value::String("key".into()));
        config.insert("keyboardKey".into(), Value::String("authorization".into()));
        config.insert("monkey".into(), Value::String("provider key".into()));
        config.insert(
            "key".into(),
            Value::String("ordinary structured output field".into()),
        );
        config.insert("designToken".into(), Value::String("spacing-lg".into()));
        config.insert("colorToken".into(), Value::String("brand-primary".into()));
        config.insert("isSecret".into(), Value::Bool(false));
        project.graph.nodes.push(GraphNode {
            id: "node".into(),
            module_id: "core.text-input".into(),
            module_version: 1,
            position: CanvasPosition { x: 0.0, y: 0.0 },
            label: None,
            label_id: None,
            config,
            update_policy: UpdatePolicy::Manual,
        });
        assert!(validate_project(&project).is_ok());
    }

    #[test]
    fn secret_filter_rejects_credential_fields_and_real_secret_formats() {
        for field in ["apiKey", "token", "privateKey", "openrouterKey", "falKey"] {
            let temp = tempfile::tempdir().unwrap();
            let repo = ProjectRepository::new(temp.path().join("projects")).unwrap();
            let mut project = repo_project(&repo).project;
            project.graph.nodes.push(GraphNode {
                id: "node".into(),
                module_id: "core.text-input".into(),
                module_version: 1,
                position: CanvasPosition { x: 0.0, y: 0.0 },
                label: None,
                label_id: None,
                config: Map::from_iter([(field.into(), Value::String("placeholder".into()))]),
                update_policy: UpdatePolicy::Manual,
            });
            assert!(validate_project(&project).unwrap_err().contains("Secret"));
        }

        let temp = tempfile::tempdir().unwrap();
        let repo = ProjectRepository::new(temp.path().join("projects")).unwrap();
        let mut project = repo_project(&repo).project;
        project.graph.nodes.push(GraphNode {
            id: "node".into(),
            module_id: "core.text-input".into(),
            module_version: 1,
            position: CanvasPosition { x: 0.0, y: 0.0 },
            label: None,
            label_id: None,
            config: Map::from_iter([(
                "description".into(),
                Value::String("sk-or-live-secret".into()),
            )]),
            update_policy: UpdatePolicy::Manual,
        });
        assert!(validate_project(&project).unwrap_err().contains("Secret"));
    }

    #[test]
    fn concurrent_saves_are_serialized_per_project() {
        use std::sync::{Arc, Barrier};
        use std::thread;

        let temp = tempfile::tempdir().unwrap();
        let repo = Arc::new(ProjectRepository::new(temp.path().join("projects")).unwrap());
        let record = repo_project(&repo);
        let barrier = Arc::new(Barrier::new(3));
        let handles: Vec<_> = (0..2)
            .map(|index| {
                let repo = Arc::clone(&repo);
                let barrier = Arc::clone(&barrier);
                let mut project = record.project.clone();
                project.name = format!("Writer {index}");
                let request = SaveProjectRequest {
                    project,
                    expected_updated_at: record.project.updated_at,
                    expected_revision: record.revision,
                };
                thread::spawn(move || {
                    barrier.wait();
                    repo.save(request)
                })
            })
            .collect();
        barrier.wait();
        let results: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(results.iter().filter(|result| result.is_err()).count(), 1);
        assert_eq!(repo.open(&record.project.id).unwrap().revision, 2);
    }

    #[test]
    fn list_reports_recovered_unsupported_and_corrupt_projects() {
        let temp = tempfile::tempdir().unwrap();
        let repo = ProjectRepository::new(temp.path().join("projects")).unwrap();

        let recovered = repo_project(&repo);
        let recovered = repo
            .save(SaveProjectRequest {
                project: recovered.project.clone(),
                expected_updated_at: recovered.project.updated_at,
                expected_revision: recovered.revision,
            })
            .unwrap();
        fs::write(
            repo.root.join(&recovered.project.id).join(PROJECT_FILE),
            b"broken",
        )
        .unwrap();

        let unsupported = repo_project(&repo);
        let unsupported_path = repo.root.join(&unsupported.project.id).join(PROJECT_FILE);
        let mut raw: Value = serde_json::from_slice(&fs::read(&unsupported_path).unwrap()).unwrap();
        raw["schemaVersion"] = (PROJECT_SCHEMA_VERSION + 1).into();
        fs::write(&unsupported_path, serde_json::to_vec(&raw).unwrap()).unwrap();

        let corrupt_id = Uuid::new_v4().to_string();
        let corrupt_dir = repo.root.join(&corrupt_id);
        fs::create_dir_all(&corrupt_dir).unwrap();
        fs::write(corrupt_dir.join(PROJECT_FILE), b"not json").unwrap();

        let summaries = repo.list().unwrap();
        let diagnosis = |id: &str| {
            summaries
                .iter()
                .find(|summary| summary.id == id)
                .unwrap()
                .diagnosis
                .clone()
        };
        assert_eq!(
            diagnosis(&recovered.project.id),
            ProjectDiagnosis::Recovered
        );
        assert_eq!(
            diagnosis(&unsupported.project.id),
            ProjectDiagnosis::Unsupported
        );
        assert_eq!(diagnosis(&corrupt_id), ProjectDiagnosis::Corrupt);
    }
}
