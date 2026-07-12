use super::{
    ApplyArtboardOperationBatch, CreateArtboardWorkspace, Persistence, ProjectDiagnosis,
    SaveProjectRequest,
};
use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DocumentKind {
    Flow,
    Artboard,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogRecord {
    pub id: String,
    pub kind: DocumentKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_opened_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
    pub health: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover: Option<DocumentCoverRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentCoverRecord {
    pub blob_hash: String,
    pub content_fingerprint: String,
    pub width: u32,
    pub height: u32,
    pub media_type: String,
    pub generated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentCoverCommitRequest {
    pub document_id: String,
    pub kind: DocumentKind,
    pub expected_revision: u64,
    pub content_fingerprint: String,
    pub width: u32,
    pub height: u32,
    pub media_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowCoverNode {
    id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    color: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowCoverEdge {
    source_id: String,
    target_id: String,
    color: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowCoverGroup {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    color: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowCoverSource {
    nodes: Vec<FlowCoverNode>,
    edges: Vec<FlowCoverEdge>,
    groups: Vec<FlowCoverGroup>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogCreateRequest {
    pub kind: DocumentKind,
    pub name: String,
    pub operation_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogRenameRequest {
    pub id: String,
    pub kind: DocumentKind,
    pub name: String,
    pub expected_revision: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogDuplicateRequest {
    pub id: String,
    pub kind: DocumentKind,
    pub name: Option<String>,
    pub expected_revision: u64,
    pub operation_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogDeleteRequest {
    pub id: String,
    pub kind: DocumentKind,
    pub expected_revision: u64,
    pub confirmation_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentReference {
    pub flow_id: String,
    pub flow_name: String,
    pub node_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogDeleteResult {
    pub deleted: bool,
    pub requires_confirmation: bool,
    pub references: Vec<DocumentReference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirmation_fingerprint: Option<String>,
}

fn validate_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 160 || name.chars().any(char::is_control) {
        return Err("Der Dokumentname muss 1 bis 160 sichtbare Zeichen enthalten.".into());
    }
    Ok(name.to_owned())
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._:-".contains(character))
}

fn require_id(id: &str, label: &str) -> Result<(), String> {
    if valid_id(id) {
        Ok(())
    } else {
        Err(format!("{label} ist ungültig."))
    }
}

fn fingerprint(value: &Value) -> Result<String, String> {
    let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn valid_fingerprint(value: &str) -> bool {
    value.len() == 64
        && value
            .chars()
            .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase())
}

fn bounded_number(value: &str, max_abs: f64) -> bool {
    value
        .parse::<f64>()
        .is_ok_and(|number| number.is_finite() && number.abs() <= max_abs)
}

fn bounded_number_list(value: &str, expected: Option<usize>, max_abs: f64) -> bool {
    let values = value
        .split(|character: char| character == ',' || character.is_ascii_whitespace())
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>();
    expected.is_none_or(|count| values.len() == count)
        && !values.is_empty()
        && values.iter().all(|item| bounded_number(item, max_abs))
}

fn safe_color(value: &str) -> bool {
    matches!(value.len(), 4 | 7 | 9)
        && value.starts_with('#')
        && value[1..]
            .chars()
            .all(|character| character.is_ascii_hexdigit())
}

fn safe_path(value: &str) -> bool {
    if value.is_empty()
        || value.len() > 64 * 1024
        || value
            .chars()
            .any(|character| !character.is_ascii_digit() && !"MCVH., -".contains(character))
    {
        return false;
    }
    let numbers = value
        .split(|character: char| {
            character == ','
                || character.is_ascii_whitespace()
                || matches!(character, 'M' | 'C' | 'V' | 'H')
        })
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>();
    !numbers.is_empty()
        && numbers
            .iter()
            .all(|item| bounded_number(item, 10_000_000.0))
}

fn safe_svg_attributes(tag: &str, attributes: &[(&str, &str)]) -> bool {
    let allowed: &[&str] = match tag {
        "rect" => &[
            "x",
            "y",
            "width",
            "height",
            "rx",
            "fill",
            "fill-opacity",
            "stroke",
            "stroke-opacity",
            "stroke-width",
        ],
        "path" => &[
            "d",
            "fill",
            "stroke",
            "stroke-width",
            "stroke-linecap",
            "opacity",
        ],
        "g" => &["opacity"],
        "circle" => &["cx", "cy", "r", "fill"],
        _ => return false,
    };
    let mut names = std::collections::HashSet::new();
    attributes.iter().all(|(name, value)| {
        allowed.contains(name)
            && names.insert(*name)
            && match *name {
                "fill" | "stroke" => *value == "none" || safe_color(value),
                "stroke-linecap" => *value == "round",
                "d" => safe_path(value),
                "opacity" | "fill-opacity" | "stroke-opacity" => value
                    .parse::<f64>()
                    .is_ok_and(|number| number.is_finite() && (0.0..=1.0).contains(&number)),
                "stroke-width" | "r" | "rx" => value
                    .parse::<f64>()
                    .is_ok_and(|number| number.is_finite() && (0.0..=64.0).contains(&number)),
                "width" | "height" => value.parse::<f64>().is_ok_and(|number| {
                    number.is_finite() && (0.0..=10_000_000.0).contains(&number)
                }),
                _ => bounded_number(value, 10_000_000.0),
            }
    })
}

fn safe_cover_svg(bytes: &[u8], width: u32, height: u32) -> bool {
    if bytes.is_empty() || bytes.len() > 256 * 1024 {
        return false;
    }
    let Ok(source) = std::str::from_utf8(bytes) else {
        return false;
    };
    let source = source.trim();
    if !source.starts_with("<svg") || !source.ends_with("</svg>") || source.contains('&') {
        return false;
    }
    let document = Html::parse_fragment(source);
    let svg_selector = Selector::parse("svg").expect("static SVG selector");
    let all_selector = Selector::parse("*").expect("static universal selector");
    let mut roots = document.select(&svg_selector);
    let Some(root) = roots.next() else {
        return false;
    };
    if roots.next().is_some() {
        return false;
    }
    let attributes = root.value().attrs().collect::<Vec<_>>();
    let root_attribute = |name: &str| {
        attributes
            .iter()
            .find_map(|(candidate, value)| (*candidate == name).then_some(*value))
    };
    let root_names_are_safe = attributes.len() >= 4
        && attributes.len() <= 5
        && attributes.iter().all(|(name, _)| {
            matches!(
                *name,
                "xmlns" | "width" | "height" | "viewBox" | "preserveAspectRatio"
            )
        });
    let exact_root = root_names_are_safe
        && root_attribute("xmlns") == Some("http://www.w3.org/2000/svg")
        && root_attribute("width") == Some(width.to_string().as_str())
        && root_attribute("height") == Some(height.to_string().as_str())
        && root_attribute("preserveAspectRatio").is_none_or(|value| value == "xMidYMid meet")
        && root_attribute("viewBox").is_some_and(|view_box| {
            let values = view_box.split_ascii_whitespace().collect::<Vec<_>>();
            values.len() == 4
                && values.iter().all(|item| bounded_number(item, 10_000_000.0))
                && bounded_number_list(&values[2..].join(" "), Some(2), 10_000_000.0)
                && values[2].parse::<f64>().is_ok_and(|number| number > 0.0)
                && values[3].parse::<f64>().is_ok_and(|number| number > 0.0)
        });
    exact_root
        && root.select(&all_selector).all(|element| {
            let tag = element.value().name();
            tag != "svg" && safe_svg_attributes(tag, &element.value().attrs().collect::<Vec<_>>())
        })
}

fn module_cover_color(module_id: &str) -> &'static str {
    if module_id.contains("image") || module_id.contains("video") {
        "#EC4899"
    } else if module_id.contains("brand") || module_id.contains("artboard") {
        "#2DD4BF"
    } else if module_id.contains("audio") || module_id.contains("transcription") {
        "#F59E0B"
    } else {
        "#38BDF8"
    }
}

fn document_kind_key(kind: DocumentKind) -> &'static str {
    match kind {
        DocumentKind::Flow => "flow",
        DocumentKind::Artboard => "artboard",
    }
}

fn stable_catalog_id(operation_id: &str, action: &str, kind: DocumentKind, role: &str) -> String {
    let mut bytes: [u8; 16] = Sha256::digest(
        format!(
            "flowz-catalog-v1:{action}:{}:{operation_id}:{role}",
            document_kind_key(kind)
        )
        .as_bytes(),
    )[..16]
        .try_into()
        .expect("SHA-256 always contains 16 UUID bytes");
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes).to_string()
}

impl Persistence {
    fn reserve_catalog_operation_locked(
        &self,
        operation_id: &str,
        action: &str,
        kind: DocumentKind,
        request_hash: &str,
    ) -> Result<String, String> {
        let document_id = stable_catalog_id(operation_id, action, kind, "document");
        self.database.with_catalog_connection(|connection| {
            let tx = connection.transaction()?;
            let existing = tx
                .query_row(
                    "SELECT action,document_kind,request_hash,document_id,deleted_at FROM catalog_operations WHERE operation_id=?1",
                    [operation_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, Option<String>>(4)?)),
                )
                .optional()?;
            if let Some((stored_action, stored_kind, stored_hash, stored_id, deleted_at)) = existing {
                if stored_action != action
                    || stored_kind != document_kind_key(kind)
                    || stored_hash != request_hash
                    || stored_id != document_id
                {
                    return Err(rusqlite::Error::InvalidParameterName(
                        "IDEMPOTENCY_PAYLOAD_CONFLICT".into(),
                    ));
                }
                if deleted_at.is_some() {
                    return Err(rusqlite::Error::InvalidParameterName(
                        "IDEMPOTENCY_TARGET_WAS_DELETED".into(),
                    ));
                }
                tx.commit()?;
                return Ok(stored_id);
            }
            tx.execute(
                "INSERT INTO catalog_operations(operation_id,action,document_kind,request_hash,document_id,created_at) VALUES(?1,?2,?3,?4,?5,?6)",
                params![operation_id, action, document_kind_key(kind), request_hash, document_id, Utc::now().to_rfc3339()],
            )?;
            tx.commit()?;
            Ok(document_id)
        })
    }

    fn artboard_catalog_record_locked(&self, id: &str) -> Result<Option<CatalogRecord>, String> {
        self.database.with_catalog_connection(|connection| {
            connection.query_row(
                "SELECT w.name,w.created_at,w.updated_at,r.revision_number,r.workspace_json FROM artboard_workspaces w JOIN artboard_branches b ON b.workspace_id=w.id AND b.name='Main' JOIN artboard_revisions r ON r.id=b.head_revision_id WHERE w.id=?1",
                [id],
                |row| {
                    let workspace_raw: String = row.get(4)?;
                    let workspace: Value = serde_json::from_str(&workspace_raw).map_err(|error| rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, error.into()))?;
                    let hash = fingerprint(&workspace).map_err(|error| rusqlite::Error::ToSqlConversionFailure(error.into()))?;
                    Ok(CatalogRecord { id: id.into(), kind: DocumentKind::Artboard, name: Some(row.get(0)?), created_at: Some(row.get(1)?), updated_at: Some(row.get(2)?), last_opened_at: None, revision: Some(row.get::<_, i64>(3)? as u64), fingerprint: Some(hash), health: "healthy".into(), cover: None })
                },
            ).optional()
        })
    }

    fn document_cover_locked(
        &self,
        id: &str,
        kind: DocumentKind,
        revision: u64,
        content_fingerprint: &str,
    ) -> Result<Option<DocumentCoverRecord>, String> {
        self.database.with_connection(|connection| {
            connection.query_row(
                "SELECT blob_hash,content_fingerprint,width,height,media_type,generated_at
                 FROM document_covers
                 WHERE document_id=?1 AND document_kind=?2 AND revision=?3 AND content_fingerprint=?4",
                params![id, document_kind_key(kind), revision as i64, content_fingerprint],
                |row| Ok(DocumentCoverRecord {
                    blob_hash: row.get(0)?, content_fingerprint: row.get(1)?,
                    width: row.get::<_, i64>(2)? as u32, height: row.get::<_, i64>(3)? as u32,
                    media_type: row.get(4)?, generated_at: row.get(5)?,
                }),
            ).optional()
        })
    }

    fn document_cover_blob_locked(
        &self,
        id: &str,
        kind: DocumentKind,
    ) -> Result<Option<String>, String> {
        self.database.with_catalog_connection(|connection| {
            connection
                .query_row(
                    "SELECT blob_hash FROM document_covers WHERE document_id=?1 AND document_kind=?2",
                    params![id, document_kind_key(kind)],
                    |row| row.get(0),
                )
                .optional()
        })
    }

    fn release_cover_blob_locked(&self, hash: Option<String>) {
        if let Some(hash) = hash {
            if self
                .database
                .release_blob_if_unreferenced(&hash)
                .unwrap_or(false)
            {
                // The relational truth is already safe. A failed physical
                // removal is repaired as an untracked CAS object on restart.
                let _ = self.blobs.remove_untracked(&hash);
            }
        }
    }

    pub fn document_flow_cover_source(
        &self,
        id: &str,
        expected_revision: u64,
        content_fingerprint: &str,
    ) -> Result<FlowCoverSource, String> {
        require_id(id, "documentId")?;
        if !valid_fingerprint(content_fingerprint) {
            return Err("Cover-Fingerprint ist ungültig.".into());
        }
        let (record, current_fingerprint) = self.projects.cover_source(id)?;
        if record.revision != expected_revision || current_fingerprint != content_fingerprint {
            return Err("COVER_SOURCE_STALE".into());
        }
        let nodes = record
            .project
            .graph
            .nodes
            .iter()
            .map(|node| FlowCoverNode {
                id: node.id.clone(),
                x: node.position.x,
                y: node.position.y,
                width: 310.0,
                height: 220.0,
                color: module_cover_color(&node.module_id).into(),
            })
            .collect::<Vec<_>>();
        let positions = record
            .project
            .graph
            .nodes
            .iter()
            .map(|node| (node.id.as_str(), (node.position.x, node.position.y)))
            .collect::<HashMap<_, _>>();
        let edges = record
            .project
            .graph
            .edges
            .iter()
            .map(|edge| FlowCoverEdge {
                source_id: edge.source_node_id.clone(),
                target_id: edge.target_node_id.clone(),
                color: "#64748B".into(),
            })
            .collect();
        let groups = record
            .project
            .graph
            .groups
            .iter()
            .filter_map(|group| {
                let members = group
                    .node_ids
                    .iter()
                    .filter_map(|id| positions.get(id.as_str()))
                    .collect::<Vec<_>>();
                if members.is_empty() {
                    return None;
                }
                let min_x = members
                    .iter()
                    .map(|item| item.0)
                    .fold(f64::INFINITY, f64::min)
                    - 28.0;
                let min_y = members
                    .iter()
                    .map(|item| item.1)
                    .fold(f64::INFINITY, f64::min)
                    - 54.0;
                let max_x = members
                    .iter()
                    .map(|item| item.0 + 310.0)
                    .fold(f64::NEG_INFINITY, f64::max)
                    + 28.0;
                let max_y = members
                    .iter()
                    .map(|item| item.1 + 220.0)
                    .fold(f64::NEG_INFINITY, f64::max)
                    + 28.0;
                Some(FlowCoverGroup {
                    x: min_x,
                    y: min_y,
                    width: max_x - min_x,
                    height: max_y - min_y,
                    color: group.color.clone().unwrap_or_else(|| "#A855F7".into()),
                })
            })
            .collect();
        Ok(FlowCoverSource {
            nodes,
            edges,
            groups,
        })
    }

    pub fn document_cover_commit(
        &self,
        request: DocumentCoverCommitRequest,
    ) -> Result<DocumentCoverRecord, String> {
        require_id(&request.document_id, "documentId")?;
        if request.expected_revision == 0
            || !valid_fingerprint(&request.content_fingerprint)
            || request.width == 0
            || request.height == 0
            || request.width > 512
            || request.height > 512
        {
            return Err("Cover-Provenienz oder Abmessungen sind ungültig.".into());
        }
        let _guard = self
            .reference_lock
            .lock()
            .map_err(|_| "Dokument-Referenzsperre ist beschädigt.".to_string())?;
        match request.kind {
            DocumentKind::Flow => {
                let current = self.projects.catalog_open_locked(&request.document_id)?;
                let (revision, current_fingerprint) = self
                    .projects
                    .catalog_identity_locked(&request.document_id)?;
                if current.revision != revision
                    || revision != request.expected_revision
                    || current_fingerprint != request.content_fingerprint
                {
                    return Err("COVER_COMMIT_STALE".into());
                }
            }
            DocumentKind::Artboard => {
                let current = self.database.with_catalog_connection(|connection| {
                    connection.query_row(
                        "SELECT r.revision_number,r.workspace_json FROM artboard_workspaces w JOIN artboard_branches b ON b.workspace_id=w.id AND b.name='Main' JOIN artboard_revisions r ON r.id=b.head_revision_id WHERE w.id=?1",
                        [&request.document_id],
                        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
                    ).optional()
                })?;
                let Some((revision, raw)) = current else {
                    return Err("COVER_COMMIT_STALE".into());
                };
                let workspace: Value = serde_json::from_str(&raw)
                    .map_err(|_| "Artboard ist beschädigt.".to_string())?;
                if revision as u64 != request.expected_revision
                    || fingerprint(&workspace)? != request.content_fingerprint
                {
                    return Err("COVER_COMMIT_STALE".into());
                }
            }
        }
        // A render produced for an obsolete document identity is discarded
        // before parsing or decoding its payload. Current identities still
        // pass through the complete fail-closed content validation below,
        // while the shared reference lock prevents a revision race between
        // this preflight and the CAS/database commit.
        match (request.kind, request.media_type.as_str()) {
            (DocumentKind::Flow, "image/svg+xml")
                if safe_cover_svg(&request.bytes, request.width, request.height) => {}
            (DocumentKind::Artboard, "image/png") if request.bytes.len() <= 2 * 1024 * 1024 => {
                let decoded = image::load_from_memory(&request.bytes)
                    .map_err(|_| "Artboard-Cover ist kein dekodierbares PNG.".to_string())?;
                if !request.bytes.starts_with(b"\x89PNG\r\n\x1a\n")
                    || decoded.width() != request.width
                    || decoded.height() != request.height
                {
                    return Err(
                        "Artboard-Cover und deklarierte Abmessungen stimmen nicht überein.".into(),
                    );
                }
            }
            _ => {
                return Err(
                    "Cover-Medientyp oder Inhalt ist für diesen Dokumenttyp nicht erlaubt.".into(),
                )
            }
        }
        let previous_cover_hash =
            self.document_cover_blob_locked(&request.document_id, request.kind)?;
        let blob = self.blobs.import_bytes(
            &request.bytes,
            request.media_type.clone(),
            Some(format!("{} Cover", document_kind_key(request.kind))),
        )?;
        let generated_at = Utc::now().to_rfc3339();
        self.database.with_catalog_connection(|connection| {
            let tx = connection.transaction()?;
            tx.execute(
                "INSERT INTO blobs(hash,size_bytes,media_type,relative_path,created_at) VALUES(?1,?2,?3,?4,?5)
                 ON CONFLICT(hash) DO UPDATE SET size_bytes=excluded.size_bytes,media_type=excluded.media_type,relative_path=excluded.relative_path",
                params![blob.hash, blob.size_bytes as i64, blob.media_type, blob.relative_path, blob.created_at.to_rfc3339()],
            )?;
            if request.kind == DocumentKind::Artboard {
                let current = tx.query_row(
                    "SELECT r.revision_number,r.workspace_json FROM artboard_workspaces w JOIN artboard_branches b ON b.workspace_id=w.id AND b.name='Main' JOIN artboard_revisions r ON r.id=b.head_revision_id WHERE w.id=?1",
                    [&request.document_id], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
                ).optional()?;
                let Some((revision, raw)) = current else { return Err(rusqlite::Error::QueryReturnedNoRows) };
                let workspace: Value = serde_json::from_str(&raw).map_err(|error| rusqlite::Error::FromSqlConversionFailure(1, rusqlite::types::Type::Text, error.into()))?;
                let current_fingerprint = fingerprint(&workspace).map_err(|error| rusqlite::Error::ToSqlConversionFailure(error.into()))?;
                if revision as u64 != request.expected_revision || current_fingerprint != request.content_fingerprint {
                    return Err(rusqlite::Error::InvalidParameterName("COVER_COMMIT_STALE".into()));
                }
            }
            tx.execute(
                "INSERT INTO document_covers(document_id,document_kind,revision,content_fingerprint,blob_hash,width,height,media_type,generated_at)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)
                 ON CONFLICT(document_id,document_kind) DO UPDATE SET revision=excluded.revision,content_fingerprint=excluded.content_fingerprint,blob_hash=excluded.blob_hash,width=excluded.width,height=excluded.height,media_type=excluded.media_type,generated_at=excluded.generated_at",
                params![request.document_id, document_kind_key(request.kind), request.expected_revision as i64, request.content_fingerprint, blob.hash, request.width as i64, request.height as i64, request.media_type, generated_at],
            )?;
            tx.commit()
        })?;
        if previous_cover_hash.as_deref() != Some(blob.hash.as_str()) {
            self.release_cover_blob_locked(previous_cover_hash);
        }
        Ok(DocumentCoverRecord {
            blob_hash: blob.hash,
            content_fingerprint: request.content_fingerprint,
            width: request.width,
            height: request.height,
            media_type: request.media_type,
            generated_at,
        })
    }
}

impl Persistence {
    pub fn document_catalog_list(&self) -> Result<Vec<CatalogRecord>, String> {
        let mut records = self
            .projects
            .catalog_list()?
            .into_iter()
            .map(|summary| CatalogRecord {
                id: summary.id,
                kind: DocumentKind::Flow,
                name: summary.name,
                created_at: summary.created_at.map(|value| value.to_rfc3339()),
                updated_at: summary.updated_at.map(|value| value.to_rfc3339()),
                last_opened_at: None,
                revision: summary.revision,
                fingerprint: summary.fingerprint,
                health: match summary.diagnosis {
                    ProjectDiagnosis::Healthy => "healthy",
                    ProjectDiagnosis::Recovered => "recovered",
                    ProjectDiagnosis::Corrupt => "corrupt",
                    ProjectDiagnosis::Unsupported => "unsupported",
                }
                .into(),
                cover: None,
            })
            .collect::<Vec<_>>();
        let mut artboards = self.database.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT w.id,w.name,w.created_at,w.updated_at,r.revision_number,r.workspace_json
                 FROM artboard_workspaces w
                 LEFT JOIN artboard_branches b ON b.workspace_id=w.id AND b.name='Main'
                 LEFT JOIN artboard_revisions r ON r.id=b.head_revision_id
                 ORDER BY w.updated_at DESC,w.id",
            )?;
            let records = statement
                .query_map([], |row| {
                    let workspace_raw: Option<String> = row.get(5)?;
                    let hash = workspace_raw
                        .as_deref()
                        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                        .and_then(|workspace| fingerprint(&workspace).ok());
                    let healthy_hash = hash.as_deref().is_some_and(valid_fingerprint);
                    Ok(CatalogRecord {
                        id: row.get(0)?,
                        kind: DocumentKind::Artboard,
                        name: Some(row.get(1)?),
                        created_at: Some(row.get(2)?),
                        updated_at: Some(row.get(3)?),
                        last_opened_at: None,
                        revision: row.get::<_, Option<i64>>(4)?.map(|value| value as u64),
                        fingerprint: healthy_hash.then_some(hash).flatten(),
                        health: if healthy_hash { "healthy" } else { "corrupt" }.into(),
                        cover: None,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(records)
        })?;
        records.append(&mut artboards);
        for record in &mut records {
            if record.health != "healthy" {
                continue;
            }
            if let (Some(revision), Some(content_fingerprint)) =
                (record.revision, record.fingerprint.as_deref())
            {
                record.cover = self.document_cover_locked(
                    &record.id,
                    record.kind,
                    revision,
                    content_fingerprint,
                )?;
            }
        }
        records.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(records)
    }

    pub fn document_catalog_create(
        &self,
        request: CatalogCreateRequest,
    ) -> Result<CatalogRecord, String> {
        let name = validate_name(&request.name)?;
        if let Some(operation_id) = request.operation_id.as_deref() {
            require_id(operation_id, "operationId")?;
        }
        let _reference_guard = self
            .reference_lock
            .lock()
            .map_err(|_| "Dokument-Referenzsperre ist beschädigt.".to_string())?;
        let stable_id = if let Some(operation_id) = request.operation_id.as_deref() {
            let request_hash = fingerprint(&json!({
                "action":"create","kind":document_kind_key(request.kind),"name":name
            }))?;
            Some(self.reserve_catalog_operation_locked(
                operation_id,
                "create",
                request.kind,
                &request_hash,
            )?)
        } else {
            None
        };
        match request.kind {
            DocumentKind::Flow => {
                let record = self.projects.catalog_create_locked(
                    stable_id.unwrap_or_else(|| Uuid::new_v4().to_string()),
                    name,
                )?;
                self.database
                    .catalog_upsert_project_locked(&record.project)?;
                Ok(flow_record(&self.projects, &record))
            }
            DocumentKind::Artboard => {
                self.create_standalone_artboard_locked(&name, request.operation_id, stable_id)
            }
        }
    }

    fn create_standalone_artboard_locked(
        &self,
        name: &str,
        operation_id: Option<String>,
        workspace_id: Option<String>,
    ) -> Result<CatalogRecord, String> {
        let workspace_id = workspace_id.unwrap_or_else(|| Uuid::new_v4().to_string());
        if let Some(record) = self.artboard_catalog_record_locked(&workspace_id)? {
            return Ok(record);
        }
        let stable = |role: &str| {
            operation_id.as_deref().map_or_else(
                || Uuid::new_v4().to_string(),
                |id| stable_catalog_id(id, "create", DocumentKind::Artboard, role),
            )
        };
        let board_id = stable("board");
        let document_id = stable("artboard-document");
        let branch_id = stable("branch");
        let revision_id = stable("revision");
        let snapshot_id = stable("snapshot");
        let now = Utc::now().to_rfc3339();
        let workspace = empty_workspace(
            &workspace_id,
            &board_id,
            &document_id,
            &branch_id,
            &revision_id,
            &snapshot_id,
            name,
            &now,
        );
        let revision =
            self.database
                .catalog_create_artboard_workspace_locked(CreateArtboardWorkspace {
                    workspace_id: workspace_id.clone(),
                    project_id: None,
                    node_id: None,
                    name: name.into(),
                    branch_id,
                    revision_id,
                    operation_id: operation_id.unwrap_or_else(|| Uuid::new_v4().to_string()),
                    workspace: workspace.clone(),
                    input_snapshot: None,
                    created_at: now.clone(),
                })?;
        Ok(CatalogRecord {
            id: workspace_id,
            kind: DocumentKind::Artboard,
            name: Some(name.into()),
            created_at: Some(now.clone()),
            updated_at: Some(now),
            last_opened_at: None,
            revision: Some(revision.revision_number as u64),
            fingerprint: Some(fingerprint(&workspace)?),
            health: "healthy".into(),
            cover: None,
        })
    }

    pub fn document_catalog_rename(
        &self,
        request: CatalogRenameRequest,
    ) -> Result<CatalogRecord, String> {
        require_id(&request.id, "id")?;
        let name = validate_name(&request.name)?;
        match request.kind {
            DocumentKind::Flow => {
                let backup = self.projects.catalog_backup(&request.id)?;
                let record =
                    self.projects
                        .catalog_rename(&request.id, &name, request.expected_revision)?;
                if let Err(error) = self.database.upsert_project(&record.project) {
                    let _ = self
                        .projects
                        .catalog_restore(&request.id, &backup.0, backup.1);
                    return Err(error);
                }
                Ok(flow_record(&self.projects, &record))
            }
            DocumentKind::Artboard => {
                let (branch_id, head_revision_id, revision, created_at, workspace_raw) = self.database.with_connection(|connection| {
                    connection.query_row(
                        "SELECT b.id,r.id,r.revision_number,w.created_at,r.workspace_json FROM artboard_workspaces w JOIN artboard_branches b ON b.workspace_id=w.id AND b.name='Main' JOIN artboard_revisions r ON r.id=b.head_revision_id WHERE w.id=?1",
                        [&request.id],
                        |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_, i64>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?)),
                    )
                })?;
                if revision as u64 != request.expected_revision {
                    return Err(
                        "Speicherkonflikt: Das Dokument wurde zwischenzeitlich geändert.".into(),
                    );
                }
                let now = Utc::now().to_rfc3339();
                let mut workspace: Value = serde_json::from_str(&workspace_raw)
                    .map_err(|_| "Artboard ist beschädigt.".to_string())?;
                workspace["name"] = Value::String(name.clone());
                let active_snapshot = workspace
                    .get("boards")
                    .and_then(Value::as_object)
                    .and_then(|boards| {
                        workspace
                            .get("activeBoardId")
                            .and_then(Value::as_str)
                            .and_then(|id| boards.get(id))
                    })
                    .and_then(|board| board.get("inputSnapshot"))
                    .cloned();
                let has_bindings = active_snapshot
                    .as_ref()
                    .and_then(|value| value.get("bindings"))
                    .and_then(Value::as_object)
                    .is_some_and(|items| !items.is_empty());
                let next_revision_id = Uuid::new_v4().to_string();
                let result =
                    self.database
                        .apply_artboard_operation_batch(ApplyArtboardOperationBatch {
                            workspace_id: request.id.clone(),
                            branch_id,
                            revision_id: next_revision_id,
                            operation_id: Uuid::new_v4().to_string(),
                            expected_revision_id: head_revision_id,
                            expected_revision_number: revision,
                            operations: vec![json!({"type":"renameWorkspace","name":name})],
                            workspace: workspace.clone(),
                            input_snapshot: has_bindings.then_some(active_snapshot.unwrap()),
                            created_at: now.clone(),
                        })?;
                Ok(CatalogRecord {
                    id: request.id,
                    kind: DocumentKind::Artboard,
                    name: Some(name),
                    created_at: Some(created_at),
                    updated_at: Some(now),
                    last_opened_at: None,
                    revision: Some(result.revision_number as u64),
                    fingerprint: Some(fingerprint(&workspace)?),
                    health: "healthy".into(),
                    cover: None,
                })
            }
        }
    }

    pub fn document_catalog_duplicate(
        &self,
        request: CatalogDuplicateRequest,
    ) -> Result<CatalogRecord, String> {
        require_id(&request.id, "id")?;
        if let Some(operation_id) = request.operation_id.as_deref() {
            require_id(operation_id, "operationId")?;
        }
        let _reference_guard = self
            .reference_lock
            .lock()
            .map_err(|_| "Dokument-Referenzsperre ist beschädigt.".to_string())?;
        let stable_id = if let Some(operation_id) = request.operation_id.as_deref() {
            let request_hash = fingerprint(&json!({
                "action":"duplicate","kind":document_kind_key(request.kind),"sourceId":request.id,
                "expectedRevision":request.expected_revision,"name":request.name.as_deref()
            }))?;
            Some(self.reserve_catalog_operation_locked(
                operation_id,
                "duplicate",
                request.kind,
                &request_hash,
            )?)
        } else {
            None
        };
        match request.kind {
            DocumentKind::Flow => {
                let record = self.projects.catalog_duplicate_locked(
                    &request.id,
                    request.name.as_deref(),
                    request.expected_revision,
                    stable_id,
                )?;
                self.database
                    .catalog_upsert_project_locked(&record.project)?;
                Ok(flow_record(&self.projects, &record))
            }
            DocumentKind::Artboard => self.duplicate_artboard_locked(request, stable_id),
        }
    }

    fn duplicate_artboard_locked(
        &self,
        request: CatalogDuplicateRequest,
        stable_workspace_id: Option<String>,
    ) -> Result<CatalogRecord, String> {
        if let Some(id) = stable_workspace_id.as_deref() {
            if let Some(record) = self.artboard_catalog_record_locked(id)? {
                return Ok(record);
            }
        }
        let (project_id, old_name, revision_number, raw) = self.database.with_catalog_connection(|connection| {
            connection.query_row(
                "SELECT w.project_id,w.name,r.revision_number,r.workspace_json FROM artboard_workspaces w JOIN artboard_branches b ON b.workspace_id=w.id AND b.name='Main' JOIN artboard_revisions r ON r.id=b.head_revision_id WHERE w.id=?1",
                [&request.id],
                |row| Ok((row.get::<_,Option<String>>(0)?,row.get::<_,String>(1)?,row.get::<_,i64>(2)?,row.get::<_,String>(3)?)),
            )
        })?;
        if revision_number as u64 != request.expected_revision {
            return Err("Speicherkonflikt: Das Dokument wurde zwischenzeitlich geändert.".into());
        }
        let name = validate_name(
            request
                .name
                .as_deref()
                .unwrap_or(&format!("{old_name} Kopie")),
        )?;
        let source: Value =
            serde_json::from_str(&raw).map_err(|_| "Artboard ist beschädigt.".to_string())?;
        let ids = DuplicateArtboardIds::new(
            &source,
            stable_workspace_id,
            request.operation_id.as_deref(),
        )?;
        let now = Utc::now().to_rfc3339();
        let workspace = ids.remap(source, &name, &now)?;
        let active_snapshot = workspace
            .get("boards")
            .and_then(Value::as_object)
            .and_then(|boards| {
                workspace
                    .get("activeBoardId")
                    .and_then(Value::as_str)
                    .and_then(|id| boards.get(id))
            })
            .and_then(|board| board.get("inputSnapshot"))
            .cloned();
        let has_bindings = active_snapshot
            .as_ref()
            .and_then(|value| value.get("bindings"))
            .and_then(Value::as_object)
            .is_some_and(|items| !items.is_empty());
        let revision =
            self.database
                .catalog_create_artboard_workspace_locked(CreateArtboardWorkspace {
                    workspace_id: ids.workspace_id.clone(),
                    project_id,
                    node_id: None,
                    name: name.clone(),
                    branch_id: ids.branch_id.clone(),
                    revision_id: ids.revision_id.clone(),
                    operation_id: request
                        .operation_id
                        .unwrap_or_else(|| Uuid::new_v4().to_string()),
                    workspace: workspace.clone(),
                    input_snapshot: has_bindings.then_some(active_snapshot.unwrap()),
                    created_at: now.clone(),
                })?;
        Ok(CatalogRecord {
            id: ids.workspace_id,
            kind: DocumentKind::Artboard,
            name: Some(name),
            created_at: Some(now.clone()),
            updated_at: Some(now),
            last_opened_at: None,
            revision: Some(revision.revision_number as u64),
            fingerprint: Some(fingerprint(&workspace)?),
            health: "healthy".into(),
            cover: None,
        })
    }

    pub fn document_catalog_delete(
        &self,
        request: CatalogDeleteRequest,
    ) -> Result<CatalogDeleteResult, String> {
        require_id(&request.id, "id")?;
        let _reference_guard = self
            .reference_lock
            .lock()
            .map_err(|_| "Dokument-Referenzsperre ist beschädigt.".to_string())?;
        #[cfg(test)]
        if let Some((entered, release)) = self
            .catalog_delete_test_hook
            .lock()
            .map_err(|_| "Katalog-Testbarriere ist beschädigt.".to_string())?
            .take()
        {
            entered.wait();
            release.wait();
        }
        match request.kind {
            DocumentKind::Flow => {
                let current = self.projects.open(&request.id)?;
                if current.revision != request.expected_revision {
                    return Err(
                        "Speicherkonflikt: Das Dokument wurde zwischenzeitlich geändert.".into(),
                    );
                }
                let cover_hash =
                    self.document_cover_blob_locked(&request.id, DocumentKind::Flow)?;
                let staged = self.projects.catalog_stage_delete_locked(&request.id)?;
                if let Err(error) = self.database.with_catalog_connection(|connection| {
                    let tx = connection.transaction()?;
                    tx.execute(
                        "UPDATE catalog_operations SET deleted_at=?2 WHERE document_id=?1",
                        params![&request.id, Utc::now().to_rfc3339()],
                    )?;
                    tx.execute(
                        "DELETE FROM document_covers WHERE document_id=?1 AND document_kind='flow'",
                        [&request.id],
                    )?;
                    let removed = tx.execute("DELETE FROM projects WHERE id=?1", [&request.id])?;
                    if removed != 1 {
                        return Err(rusqlite::Error::QueryReturnedNoRows);
                    }
                    tx.commit()
                }) {
                    let rollback = self
                        .projects
                        .catalog_restore_staged_locked(&request.id, &staged);
                    return Err(match rollback {
                        Ok(()) => error,
                        Err(rollback) => format!(
                            "{error} Zusätzlich ist das Flow-Rollback fehlgeschlagen: {rollback}"
                        ),
                    });
                }
                let _ = self.projects.catalog_finalize_staged_delete(&staged);
                self.release_cover_blob_locked(cover_hash);
                Ok(CatalogDeleteResult {
                    deleted: true,
                    requires_confirmation: false,
                    references: vec![],
                    confirmation_fingerprint: None,
                })
            }
            DocumentKind::Artboard => self.delete_artboard(request),
        }
    }

    fn delete_artboard(
        &self,
        request: CatalogDeleteRequest,
    ) -> Result<CatalogDeleteResult, String> {
        let revision: i64 = self.database.with_catalog_connection(|connection| connection.query_row(
            "SELECT r.revision_number FROM artboard_workspaces w JOIN artboard_branches b ON b.workspace_id=w.id AND b.name='Main' JOIN artboard_revisions r ON r.id=b.head_revision_id WHERE w.id=?1", [&request.id], |row| row.get(0)))?;
        if revision as u64 != request.expected_revision {
            return Err("Speicherkonflikt: Das Dokument wurde zwischenzeitlich geändert.".into());
        }
        let mut affected = Vec::new();
        let mut projects = Vec::new();
        for summary in self.projects.list()? {
            let record = self.projects.open(&summary.id).map_err(|error| {
                format!(
                    "Artboard kann nicht sicher gelöscht werden: Flow {} konnte nicht auf Referenzen geprüft werden ({error}).",
                    summary.id
                )
            })?;
            let mut document = record.project.clone();
            let mut changed = false;
            for node in &mut document.graph.nodes {
                if remove_workspace_reference(&mut node.config, &request.id) {
                    changed = true;
                    affected.push(DocumentReference {
                        flow_id: document.id.clone(),
                        flow_name: document.name.clone(),
                        node_id: node.id.clone(),
                    });
                }
            }
            if changed {
                projects.push((record, document));
            }
        }
        affected.sort_by(|left, right| {
            left.flow_id
                .cmp(&right.flow_id)
                .then_with(|| left.node_id.cmp(&right.node_id))
        });
        let confirmation_fingerprint = fingerprint(&json!(affected
            .iter()
            .map(|reference| (&reference.flow_id, &reference.node_id))
            .collect::<Vec<_>>()))?;
        if !affected.is_empty()
            && request.confirmation_fingerprint.as_deref()
                != Some(confirmation_fingerprint.as_str())
        {
            return Ok(CatalogDeleteResult {
                deleted: false,
                requires_confirmation: true,
                references: affected,
                confirmation_fingerprint: Some(confirmation_fingerprint),
            });
        }
        let cover_hash = self.document_cover_blob_locked(&request.id, DocumentKind::Artboard)?;
        let mut saved = Vec::new();
        for (record, document) in projects {
            let backup = self.projects.catalog_backup(&document.id)?;
            match self.projects.catalog_save_locked(SaveProjectRequest {
                project: document.clone(),
                expected_updated_at: record.project.updated_at,
                expected_revision: record.revision,
            }) {
                Ok(_) => saved.push((document.id, backup)),
                Err(error) => {
                    return Err(rollback_error(&self.projects, saved, error));
                }
            }
        }
        if let Err(error) = self.database.with_catalog_connection(|connection| {
            let tx = connection.transaction()?;
            tx.execute("UPDATE artboard_board_revisions SET parent_board_revision_id=NULL,derived_from_board_revision_id=NULL WHERE workspace_id=?1",[&request.id])?;
            tx.execute("UPDATE artboard_revisions SET parent_revision_id=NULL,input_snapshot_id=NULL WHERE workspace_id=?1",[&request.id])?;
            tx.execute("DELETE FROM document_covers WHERE document_id=?1 AND document_kind='artboard'", [&request.id])?;
            let removed =
                tx.execute("DELETE FROM artboard_workspaces WHERE id=?1", [&request.id])?;
            if removed != 1 {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
            tx.execute(
                "UPDATE catalog_operations SET deleted_at=?2 WHERE document_id=?1",
                params![&request.id, Utc::now().to_rfc3339()],
            )?;
            tx.commit()
        }) {
            return Err(rollback_error(&self.projects, saved, error));
        }
        self.release_cover_blob_locked(cover_hash);
        Ok(CatalogDeleteResult {
            deleted: true,
            requires_confirmation: false,
            references: affected,
            confirmation_fingerprint: None,
        })
    }
}

fn rollback_projects(
    repository: &super::ProjectRepository,
    saved: Vec<(String, (Vec<u8>, u64))>,
) -> Result<(), String> {
    let mut failures = Vec::new();
    for (id, (bytes, revision)) in saved.into_iter().rev() {
        if let Err(error) = repository.catalog_restore(&id, &bytes, revision) {
            failures.push(format!("{id}: {error}"));
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

fn rollback_error(
    repository: &super::ProjectRepository,
    saved: Vec<(String, (Vec<u8>, u64))>,
    original: String,
) -> String {
    match rollback_projects(repository, saved) {
        Ok(()) => original,
        Err(rollback) => format!(
            "{original} Zusätzlich ist das Zurückrollen gespeicherter Flows fehlgeschlagen: {rollback}"
        ),
    }
}

fn flow_record(
    repository: &super::ProjectRepository,
    record: &super::ProjectSaveResult,
) -> CatalogRecord {
    CatalogRecord {
        id: record.project.id.clone(),
        kind: DocumentKind::Flow,
        name: Some(record.project.name.clone()),
        created_at: Some(record.project.created_at.to_rfc3339()),
        updated_at: Some(record.project.updated_at.to_rfc3339()),
        last_opened_at: None,
        revision: Some(record.revision),
        fingerprint: repository
            .catalog_identity_locked(&record.project.id)
            .ok()
            .map(|(_, hash)| hash),
        health: "healthy".into(),
        cover: None,
    }
}

#[allow(clippy::too_many_arguments)]
fn empty_workspace(
    workspace_id: &str,
    board_id: &str,
    document_id: &str,
    branch_id: &str,
    revision_id: &str,
    snapshot_id: &str,
    name: &str,
    now: &str,
) -> Value {
    json!({"schemaVersion":1,"id":workspace_id,"name":name,"boards":{board_id:{"id":board_id,"name":"Artboard 1","activeRevisionId":revision_id,"document":{"schemaVersion":1,"id":document_id,"name":"Artboard 1","format":{"preset":"instagram-post","width":1080,"height":1080},"paint":{"kind":"solid","color":"#FFFFFF"},"rootLayerIds":[],"layers":{},"bindings":{},"tokenRefs":{}},"inputSnapshot":{"id":snapshot_id,"createdAt":now,"bindings":{}},"ancestry":{"branchId":branch_id},"createdAt":now}},"placements":{board_id:{"x":64,"y":64}},"selectedBoardIds":[board_id],"activeBoardId":board_id,"pasteboard":{"margin":64,"gap":64,"grid":8}})
}

fn remove_workspace_reference(config: &mut Map<String, Value>, workspace_id: &str) -> bool {
    let keys = config
        .iter()
        .filter(|(key, value)| {
            (key.eq_ignore_ascii_case("workspaceId")
                || key.eq_ignore_ascii_case("artboardWorkspaceId"))
                && value.as_str() == Some(workspace_id)
        })
        .map(|(key, _)| key.clone())
        .collect::<Vec<_>>();
    let mut changed = !keys.is_empty();
    for key in keys {
        config.remove(&key);
    }
    for value in config.values_mut() {
        changed |= remove_workspace_reference_value(value, workspace_id);
    }
    changed
}
#[allow(clippy::unnecessary_fold)] // all nested objects must be visited and cleaned
fn remove_workspace_reference_value(value: &mut Value, workspace_id: &str) -> bool {
    match value {
        Value::Object(map) => remove_workspace_reference(map, workspace_id),
        Value::Array(items) => items.iter_mut().fold(false, |changed, item| {
            remove_workspace_reference_value(item, workspace_id) || changed
        }),
        _ => false,
    }
}

struct DuplicateArtboardIds {
    workspace_id: String,
    branch_id: String,
    revision_id: String,
    board_revisions: HashMap<String, String>,
    boards: HashMap<String, String>,
    documents: HashMap<String, String>,
    snapshots: HashMap<String, String>,
    layers: HashMap<String, String>,
    bindings: HashMap<String, String>,
}
impl DuplicateArtboardIds {
    fn new(
        source: &Value,
        workspace_id: Option<String>,
        operation_id: Option<&str>,
    ) -> Result<Self, String> {
        let boards = source
            .get("boards")
            .and_then(Value::as_object)
            .ok_or("Artboard.boards fehlt.")?;
        let stable = |role: &str| {
            operation_id.map_or_else(
                || Uuid::new_v4().to_string(),
                |id| stable_catalog_id(id, "duplicate", DocumentKind::Artboard, role),
            )
        };
        let mut result = Self {
            workspace_id: workspace_id.unwrap_or_else(|| stable("document")),
            branch_id: stable("branch"),
            revision_id: stable("revision"),
            board_revisions: HashMap::new(),
            boards: HashMap::new(),
            documents: HashMap::new(),
            snapshots: HashMap::new(),
            layers: HashMap::new(),
            bindings: HashMap::new(),
        };
        for (id, board) in boards {
            result
                .boards
                .insert(id.clone(), stable(&format!("board:{id}")));
            result
                .board_revisions
                .insert(id.clone(), stable(&format!("board-revision:{id}")));
            if let Some(id) = board.pointer("/document/id").and_then(Value::as_str) {
                result
                    .documents
                    .insert(id.into(), stable(&format!("artboard-document:{id}")));
            }
            if let Some(id) = board.pointer("/inputSnapshot/id").and_then(Value::as_str) {
                result
                    .snapshots
                    .insert(id.into(), stable(&format!("snapshot:{id}")));
            }
            if let Some(layers) = board.pointer("/document/layers").and_then(Value::as_object) {
                for id in layers.keys() {
                    result
                        .layers
                        .entry(id.clone())
                        .or_insert_with(|| stable(&format!("layer:{id}")));
                }
            }
            if let Some(bindings) = board
                .pointer("/document/bindings")
                .and_then(Value::as_object)
            {
                for id in bindings.keys() {
                    result
                        .bindings
                        .entry(id.clone())
                        .or_insert_with(|| stable(&format!("binding:{id}")));
                }
            }
        }
        Ok(result)
    }
    fn remap(&self, mut value: Value, name: &str, now: &str) -> Result<Value, String> {
        value["id"] = json!(self.workspace_id);
        value["name"] = json!(name);
        let old_boards = value["boards"]
            .as_object_mut()
            .ok_or("Artboard.boards fehlt.")?;
        let entries = std::mem::take(old_boards);
        let mut next = Map::new();
        for (old_id, mut board) in entries {
            let new_id = self.boards[&old_id].clone();
            board["id"] = json!(new_id);
            board["activeRevisionId"] = json!(self.board_revisions[&old_id]);
            board["createdAt"] = json!(now);
            if let Some(old) = board.pointer("/document/id").and_then(Value::as_str) {
                board["document"]["id"] = json!(self.documents[old]);
            }
            if let Some(old) = board.pointer("/inputSnapshot/id").and_then(Value::as_str) {
                board["inputSnapshot"]["id"] = json!(self.snapshots[old]);
                board["inputSnapshot"]["createdAt"] = json!(now);
            }
            board["ancestry"] = json!({"branchId":self.branch_id});
            remap_document(&mut board["document"], &self.layers, &self.bindings)?;
            remap_bindings(&mut board["inputSnapshot"]["bindings"], &self.bindings)?;
            next.insert(new_id, board);
        }
        value["boards"] = Value::Object(next);
        remap_map_keys(&mut value["placements"], &self.boards)?;
        remap_string_array(&mut value["selectedBoardIds"], &self.boards);
        if let Some(old) = value["activeBoardId"].as_str() {
            value["activeBoardId"] = json!(self.boards.get(old).ok_or("Aktives Board fehlt.")?);
        }
        Ok(value)
    }
}
fn remap_document(
    document: &mut Value,
    layers: &HashMap<String, String>,
    bindings: &HashMap<String, String>,
) -> Result<(), String> {
    remap_map_keys(&mut document["layers"], layers)?;
    remap_map_keys(&mut document["bindings"], bindings)?;
    remap_string_array(&mut document["rootLayerIds"], layers);
    if let Some(items) = document["layers"].as_object_mut() {
        for (id, layer) in items {
            layer["id"] = json!(id);
            remap_string_array(&mut layer["childIds"], layers);
            if let Some(old) = layer.get("bindingId").and_then(Value::as_str) {
                if let Some(new) = bindings.get(old) {
                    layer["bindingId"] = json!(new);
                }
            }
        }
    }
    if let Some(items) = document["bindings"].as_object_mut() {
        for (id, binding) in items {
            binding["id"] = json!(id);
        }
    }
    Ok(())
}

fn remap_bindings(value: &mut Value, bindings: &HashMap<String, String>) -> Result<(), String> {
    remap_map_keys(value, bindings)?;
    if let Some(items) = value.as_object_mut() {
        for (id, binding) in items {
            binding["id"] = json!(id);
        }
    }
    Ok(())
}
fn remap_map_keys(value: &mut Value, ids: &HashMap<String, String>) -> Result<(), String> {
    let map = value.as_object_mut().ok_or("Artboard-Zuordnung fehlt.")?;
    let entries = std::mem::take(map);
    for (old, item) in entries {
        map.insert(
            ids.get(&old)
                .cloned()
                .ok_or("Artboard-ID-Zuordnung fehlt.")?,
            item,
        );
    }
    Ok(())
}
fn remap_string_array(value: &mut Value, ids: &HashMap<String, String>) {
    if let Some(items) = value.as_array_mut() {
        for item in items {
            if let Some(old) = item.as_str() {
                if let Some(new) = ids.get(old) {
                    *item = json!(new);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::project_repository::{
        CanvasPosition, CreateProjectRequest, GraphNode, SaveProjectRequest, UpdatePolicy,
    };
    use image::{DynamicImage, ImageFormat};
    use std::io::Cursor;

    fn persistence() -> (tempfile::TempDir, Persistence) {
        let temp = tempfile::tempdir().unwrap();
        let persistence = Persistence::initialize(temp.path()).unwrap();
        (temp, persistence)
    }

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Cursor::new(Vec::new());
        DynamicImage::new_rgba8(width, height)
            .write_to(&mut bytes, ImageFormat::Png)
            .unwrap();
        bytes.into_inner()
    }

    #[test]
    fn flow_cover_svg_accepts_only_the_bounded_renderer_subset() {
        let valid = r##"<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300" viewBox="-32 -32 544 364" preserveAspectRatio="xMidYMid meet"><rect x="0" y="0" width="480" height="300" rx="18" fill="#100D10"/><path d="M0 0 C10 0 20 10 30 10" fill="none" stroke="#38BDF8" stroke-width="5" stroke-linecap="round" opacity=".72"/><g opacity=".5"><circle cx="20" cy="20" r="9" fill="#EC4899"/></g></svg>"##;
        assert!(safe_cover_svg(valid.as_bytes(), 480, 300));
        for malicious in [
            valid.replace("http://www.w3.org/2000/svg", "https://evil.invalid/svg"),
            valid.replace("<rect ", "<rect onload =\"alert(1)\" "),
            valid.replace("<rect ", "<image href=\"https://evil.invalid/a.png\" "),
            valid.replace("<rect ", "<script>1</script><rect "),
            valid.replace(
                "viewBox=\"-32 -32 544 364\"",
                "viewBox=\"0 0 999999999 300\"",
            ),
            valid.replace("width=\"480\"", "width=\"479\""),
            valid.replace("fill=\"#100D10\"", "fill=\"url(data:image/png,evil)\""),
        ] {
            assert!(
                !safe_cover_svg(malicious.as_bytes(), 480, 300),
                "accepted: {malicious}"
            );
        }
    }

    #[test]
    fn flow_cover_is_revision_bound_persisted_and_stale_work_fails_closed() {
        let (_temp, persistence) = persistence();
        let created = persistence
            .document_catalog_create(CatalogCreateRequest {
                kind: DocumentKind::Flow,
                name: "Cover Flow".into(),
                operation_id: Some("cover-flow-create".into()),
            })
            .unwrap();
        let revision = created.revision.unwrap();
        let fingerprint = created.fingerprint.clone().unwrap();
        let source = persistence
            .document_flow_cover_source(&created.id, revision, &fingerprint)
            .unwrap();
        assert!(source.nodes.is_empty());
        let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300" viewBox="0 0 480 300"><rect width="480" height="300" fill="#100D10"/></svg>"##.to_vec();
        let cover = persistence
            .document_cover_commit(DocumentCoverCommitRequest {
                document_id: created.id.clone(),
                kind: DocumentKind::Flow,
                expected_revision: revision,
                content_fingerprint: fingerprint.clone(),
                width: 480,
                height: 300,
                media_type: "image/svg+xml".into(),
                bytes: svg,
            })
            .unwrap();
        assert_eq!(cover.content_fingerprint, fingerprint);
        let listed = persistence
            .document_catalog_list()
            .unwrap()
            .into_iter()
            .find(|item| item.id == created.id)
            .unwrap();
        assert_eq!(
            listed.cover.as_ref().map(|item| item.blob_hash.as_str()),
            Some(cover.blob_hash.as_str())
        );
        let renamed = persistence
            .document_catalog_rename(CatalogRenameRequest {
                id: created.id.clone(),
                kind: DocumentKind::Flow,
                name: "Changed".into(),
                expected_revision: revision,
            })
            .unwrap();
        let stale_error = persistence
            .document_cover_commit(DocumentCoverCommitRequest {
                document_id: created.id.clone(),
                kind: DocumentKind::Flow,
                expected_revision: revision,
                content_fingerprint: fingerprint.clone(),
                width: 480,
                height: 300,
                media_type: "image/svg+xml".into(),
                bytes: br#"<svg width="480" height="300"></svg>"#.to_vec(),
            })
            .unwrap_err();
        assert_eq!(stale_error, "COVER_COMMIT_STALE");

        let current_invalid_error = persistence
            .document_cover_commit(DocumentCoverCommitRequest {
                document_id: created.id.clone(),
                kind: DocumentKind::Flow,
                expected_revision: renamed.revision.unwrap(),
                content_fingerprint: renamed.fingerprint.unwrap(),
                width: 480,
                height: 300,
                media_type: "image/svg+xml".into(),
                bytes: br#"<svg width="480" height="300"></svg>"#.to_vec(),
            })
            .unwrap_err();
        assert!(current_invalid_error.contains("Medientyp oder Inhalt"));

        let listed = persistence
            .document_catalog_list()
            .unwrap()
            .into_iter()
            .find(|item| item.id == created.id)
            .unwrap();
        assert!(
            listed.cover.is_none(),
            "a stale cover must not bind to the new revision"
        );
    }

    #[test]
    fn cover_replacement_and_document_delete_release_only_unreferenced_cas() {
        let (_temp, persistence) = persistence();
        let created = persistence
            .document_catalog_create(CatalogCreateRequest {
                kind: DocumentKind::Flow,
                name: "Cover GC".into(),
                operation_id: Some("cover-gc-create".into()),
            })
            .unwrap();
        let request = |fill: &str| {
            DocumentCoverCommitRequest {
            document_id: created.id.clone(), kind: DocumentKind::Flow,
            expected_revision: created.revision.unwrap(), content_fingerprint: created.fingerprint.clone().unwrap(),
            width: 480, height: 300, media_type: "image/svg+xml".into(),
            bytes: format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300" viewBox="0 0 480 300"><rect width="480" height="300" fill="{fill}"/></svg>"#).into_bytes(),
        }
        };
        let first = persistence
            .document_cover_commit(request("#111111"))
            .unwrap();
        let second = persistence
            .document_cover_commit(request("#222222"))
            .unwrap();
        assert_ne!(first.blob_hash, second.blob_hash);
        assert!(!persistence
            .database
            .contains_blob(&first.blob_hash)
            .unwrap());
        assert!(persistence
            .database
            .contains_blob(&second.blob_hash)
            .unwrap());
        persistence
            .document_catalog_delete(CatalogDeleteRequest {
                id: created.id,
                kind: DocumentKind::Flow,
                expected_revision: created.revision.unwrap(),
                confirmation_fingerprint: None,
            })
            .unwrap();
        assert!(!persistence
            .database
            .contains_blob(&second.blob_hash)
            .unwrap());
    }

    #[test]
    fn stale_artboard_cover_is_rejected_before_any_blob_is_imported() {
        let (_temp, persistence) = persistence();
        let created = persistence
            .document_catalog_create(CatalogCreateRequest {
                kind: DocumentKind::Artboard,
                name: "Stale Cover".into(),
                operation_id: Some("stale-cover-create".into()),
            })
            .unwrap();
        let before = persistence.blobs.repair_orphans().unwrap().len();
        let error = persistence
            .document_cover_commit(DocumentCoverCommitRequest {
                document_id: created.id,
                kind: DocumentKind::Artboard,
                expected_revision: created.revision.unwrap() + 1,
                content_fingerprint: created.fingerprint.unwrap(),
                width: 2,
                height: 3,
                media_type: "image/png".into(),
                bytes: png(2, 3),
            })
            .unwrap_err();
        assert!(error.contains("STALE"));
        assert_eq!(persistence.blobs.repair_orphans().unwrap().len(), before);
    }

    #[test]
    fn standalone_artboard_can_be_renamed_duplicated_and_deleted() {
        let (_temp, persistence) = persistence();
        let created = persistence
            .document_catalog_create(CatalogCreateRequest {
                kind: DocumentKind::Artboard,
                name: "Social Kit".into(),
                operation_id: Some("create-social-kit".into()),
            })
            .unwrap();
        assert_eq!(created.revision, Some(1));
        let renamed = persistence
            .document_catalog_rename(CatalogRenameRequest {
                id: created.id.clone(),
                kind: DocumentKind::Artboard,
                name: "Launch Kit".into(),
                expected_revision: 1,
            })
            .unwrap();
        assert_eq!(renamed.revision, Some(2));
        let duplicate = persistence
            .document_catalog_duplicate(CatalogDuplicateRequest {
                id: created.id.clone(),
                kind: DocumentKind::Artboard,
                name: None,
                expected_revision: 2,
                operation_id: Some("duplicate-launch-kit".into()),
            })
            .unwrap();
        assert_ne!(duplicate.id, created.id);
        assert_eq!(duplicate.revision, Some(1));
        let deleted = persistence
            .document_catalog_delete(CatalogDeleteRequest {
                id: created.id,
                kind: DocumentKind::Artboard,
                expected_revision: 2,
                confirmation_fingerprint: None,
            })
            .unwrap();
        assert!(deleted.deleted);
        assert!(persistence
            .document_catalog_list()
            .unwrap()
            .iter()
            .any(|record| record.id == duplicate.id));
    }

    #[test]
    fn catalog_create_and_duplicate_are_retry_idempotent_and_payload_bound() {
        let (_temp, persistence) = persistence();
        let flow_request = || CatalogCreateRequest {
            kind: DocumentKind::Flow,
            name: "Idempotenter Flow".into(),
            operation_id: Some("create-flow-once".into()),
        };
        let flow = persistence.document_catalog_create(flow_request()).unwrap();
        let flow_retry = persistence.document_catalog_create(flow_request()).unwrap();
        assert_eq!(flow.id, flow_retry.id);
        assert!(persistence
            .document_catalog_create(CatalogCreateRequest {
                kind: DocumentKind::Flow,
                name: "Andere Payload".into(),
                operation_id: Some("create-flow-once".into()),
            })
            .unwrap_err()
            .contains("IDEMPOTENCY_PAYLOAD_CONFLICT"));

        let duplicate_request = || CatalogDuplicateRequest {
            id: flow.id.clone(),
            kind: DocumentKind::Flow,
            name: Some("Flow Kopie".into()),
            expected_revision: flow.revision.unwrap(),
            operation_id: Some("duplicate-flow-once".into()),
        };
        let duplicate = persistence
            .document_catalog_duplicate(duplicate_request())
            .unwrap();
        let duplicate_retry = persistence
            .document_catalog_duplicate(duplicate_request())
            .unwrap();
        assert_eq!(duplicate.id, duplicate_retry.id);

        let artboard_request = || CatalogCreateRequest {
            kind: DocumentKind::Artboard,
            name: "Idempotentes Artboard".into(),
            operation_id: Some("create-artboard-once".into()),
        };
        let artboard = persistence
            .document_catalog_create(artboard_request())
            .unwrap();
        let artboard_retry = persistence
            .document_catalog_create(artboard_request())
            .unwrap();
        assert_eq!(artboard.id, artboard_retry.id);

        let artboard_duplicate_request = || CatalogDuplicateRequest {
            id: artboard.id.clone(),
            kind: DocumentKind::Artboard,
            name: None,
            expected_revision: artboard.revision.unwrap(),
            operation_id: Some("duplicate-artboard-once".into()),
        };
        let artboard_duplicate = persistence
            .document_catalog_duplicate(artboard_duplicate_request())
            .unwrap();
        let artboard_duplicate_retry = persistence
            .document_catalog_duplicate(artboard_duplicate_request())
            .unwrap();
        assert_eq!(artboard_duplicate.id, artboard_duplicate_retry.id);

        let (flows, artboards, operations): (i64, i64, i64) = persistence
            .database
            .with_connection(|connection| {
                Ok((
                    connection.query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))?,
                    connection.query_row(
                        "SELECT COUNT(*) FROM artboard_workspaces",
                        [],
                        |row| row.get(0),
                    )?,
                    connection.query_row("SELECT COUNT(*) FROM catalog_operations", [], |row| {
                        row.get(0)
                    })?,
                ))
            })
            .unwrap();
        assert_eq!((flows, artboards, operations), (2, 2, 4));
    }

    #[test]
    fn deleting_flow_removes_relational_metadata_and_tombstones_its_operation() {
        let (_temp, persistence) = persistence();
        let flow = persistence
            .document_catalog_create(CatalogCreateRequest {
                kind: DocumentKind::Flow,
                name: "Löschbarer Flow".into(),
                operation_id: Some("create-deletable-flow".into()),
            })
            .unwrap();
        let before: (i64, i64) = persistence
            .database
            .with_connection(|connection| {
                Ok((
                    connection.query_row(
                        "SELECT COUNT(*) FROM projects WHERE id=?1",
                        [&flow.id],
                        |row| row.get(0),
                    )?,
                    connection.query_row(
                        "SELECT COUNT(*) FROM catalog_operations WHERE document_id=?1",
                        [&flow.id],
                        |row| row.get(0),
                    )?,
                ))
            })
            .unwrap();
        assert_eq!(before, (1, 1));
        persistence
            .document_catalog_delete(CatalogDeleteRequest {
                id: flow.id.clone(),
                kind: DocumentKind::Flow,
                expected_revision: flow.revision.unwrap(),
                confirmation_fingerprint: None,
            })
            .unwrap();
        let after: (i64, i64, i64) = persistence
            .database
            .with_connection(|connection| {
                Ok((
                    connection.query_row(
                        "SELECT COUNT(*) FROM projects WHERE id=?1",
                        [&flow.id],
                        |row| row.get(0),
                    )?,
                    connection.query_row(
                        "SELECT COUNT(*) FROM catalog_operations WHERE document_id=?1",
                        [&flow.id],
                        |row| row.get(0),
                    )?,
                    connection.query_row(
                        "SELECT COUNT(*) FROM catalog_operations WHERE document_id=?1 AND deleted_at IS NOT NULL",
                        [&flow.id],
                        |row| row.get(0),
                    )?,
                ))
            })
            .unwrap();
        assert_eq!(after, (0, 1, 1));
        assert!(persistence.projects.open(&flow.id).is_err());
        assert!(persistence
            .document_catalog_create(CatalogCreateRequest {
                kind: DocumentKind::Flow,
                name: "Löschbarer Flow".into(),
                operation_id: Some("create-deletable-flow".into()),
            })
            .unwrap_err()
            .contains("IDEMPOTENCY_TARGET_WAS_DELETED"));
    }

    #[test]
    fn flow_duplicate_remaps_graph_ids_and_drops_transient_provider_state() {
        let (_temp, persistence) = persistence();
        let created = persistence
            .projects
            .create(CreateProjectRequest {
                name: "Flow".into(),
            })
            .unwrap();
        let mut project = created.project;
        project.graph.nodes.push(GraphNode {
            id: "source-node".into(),
            module_id: "test.node".into(),
            module_version: 1,
            position: CanvasPosition { x: 0.0, y: 0.0 },
            label: None,
            label_id: None,
            config: serde_json::from_value(
                json!({"prompt":"safe","runId":"paid-run","nested":{"status":"running"}}),
            )
            .unwrap(),
            update_policy: UpdatePolicy::Manual,
        });
        let saved = persistence
            .projects
            .save(SaveProjectRequest {
                expected_updated_at: project.updated_at,
                expected_revision: 1,
                project,
            })
            .unwrap();
        let duplicate = persistence
            .projects
            .catalog_duplicate(&saved.project.id, Some("Flow Kopie"), saved.revision)
            .unwrap();
        assert_ne!(duplicate.project.id, saved.project.id);
        assert_ne!(duplicate.project.graph.nodes[0].id, "source-node");
        assert_eq!(
            duplicate.project.graph.nodes[0]
                .config
                .get("prompt")
                .and_then(Value::as_str),
            Some("safe")
        );
        assert!(!duplicate.project.graph.nodes[0]
            .config
            .contains_key("runId"));
        assert!(duplicate.project.graph.nodes[0].config["nested"]
            .get("status")
            .is_none());
    }

    #[test]
    fn artboard_duplicate_remaps_snapshot_bindings_with_document_bindings() {
        let source = json!({
            "schemaVersion": 1,
            "id": "workspace-old",
            "name": "Gebunden",
            "boards": {
                "board-old": {
                    "id": "board-old",
                    "name": "Board",
                    "activeRevisionId": "revision-old",
                    "document": {
                        "schemaVersion": 1,
                        "id": "document-old",
                        "name": "Board",
                        "format": {"preset":"instagram-post","width":1080,"height":1080},
                        "paint": {"kind":"solid","color":"#FFFFFF"},
                        "rootLayerIds": ["image-old"],
                        "layers": {
                            "image-old": {
                                "id":"image-old","type":"image","name":"Bild","locked":false,
                                "visible":true,"version":1,
                                "geometry":{"x":0,"y":0,"width":1080,"height":1080,"rotation":0},
                                "bindingId":"binding-old","fit":"cover"
                            }
                        },
                        "bindings": {
                            "binding-old": {
                                "id":"binding-old",
                                "source":{"projectId":"project","nodeId":"node","portId":"image","resultId":"result"},
                                "snapshot":{"kind":"cas","hash":"a".repeat(64)},
                                "mode":"pinned"
                            }
                        },
                        "tokenRefs": {}
                    },
                    "inputSnapshot": {
                        "id":"snapshot-old","createdAt":"2026-07-12T10:00:00Z",
                        "bindings": {
                            "binding-old": {
                                "id":"binding-old",
                                "source":{"projectId":"project","nodeId":"node","portId":"image","resultId":"result"},
                                "snapshot":{"kind":"cas","hash":"a".repeat(64)},
                                "mode":"pinned"
                            }
                        }
                    },
                    "ancestry":{"branchId":"branch-old"},
                    "createdAt":"2026-07-12T10:00:00Z"
                }
            },
            "placements":{"board-old":{"x":64,"y":64}},
            "selectedBoardIds":["board-old"],
            "activeBoardId":"board-old",
            "pasteboard":{"margin":64,"gap":64,"grid":8}
        });
        let ids = DuplicateArtboardIds::new(&source, None, None).unwrap();
        let duplicate = ids
            .remap(source, "Gebunden Kopie", "2026-07-12T11:00:00Z")
            .unwrap();
        let board = &duplicate["boards"][&ids.boards["board-old"]];
        let new_binding = &ids.bindings["binding-old"];
        assert_eq!(
            board["document"]["layers"][&ids.layers["image-old"]]["bindingId"],
            json!(new_binding)
        );
        assert_eq!(
            board["document"]["bindings"][new_binding],
            board["inputSnapshot"]["bindings"][new_binding]
        );
        assert_eq!(
            board["inputSnapshot"]["bindings"][new_binding]["id"],
            json!(new_binding)
        );
    }

    #[test]
    fn catalog_handles_500_headers_without_materializing_graphs_and_marks_corruption() {
        let (temp, persistence) = persistence();
        for index in 0..500 {
            persistence
                .projects
                .create(CreateProjectRequest {
                    name: format!("Flow {index}"),
                })
                .unwrap();
        }
        let corrupt = temp.path().join("projects").join("corrupt-flow");
        std::fs::create_dir_all(&corrupt).unwrap();
        std::fs::write(corrupt.join("project.flowz.json"), b"{not-json").unwrap();
        std::fs::write(corrupt.join("revision"), b"7").unwrap();
        let records = persistence.document_catalog_list().unwrap();
        assert_eq!(
            records
                .iter()
                .filter(|record| record.kind == DocumentKind::Flow)
                .count(),
            501
        );
        assert_eq!(
            records
                .iter()
                .find(|record| record.id == "corrupt-flow")
                .unwrap()
                .health,
            "corrupt"
        );
    }

    #[test]
    fn deleting_linked_artboard_requires_confirmation_and_unlinks_flow() {
        let (_temp, persistence) = persistence();
        let artboard = persistence
            .document_catalog_create(CatalogCreateRequest {
                kind: DocumentKind::Artboard,
                name: "Linked".into(),
                operation_id: None,
            })
            .unwrap();
        let created = persistence
            .projects
            .create(CreateProjectRequest {
                name: "Flow".into(),
            })
            .unwrap();
        let mut project = created.project;
        project.graph.nodes.push(GraphNode {
            id: "artboard-node".into(),
            module_id: "brand.artboard".into(),
            module_version: 1,
            position: CanvasPosition { x: 0.0, y: 0.0 },
            label: None,
            label_id: None,
            config: serde_json::from_value(json!({"workspaceId":artboard.id})).unwrap(),
            update_policy: UpdatePolicy::Manual,
        });
        let saved = persistence
            .projects
            .save(SaveProjectRequest {
                expected_updated_at: project.updated_at,
                expected_revision: 1,
                project,
            })
            .unwrap();
        let preview = persistence
            .document_catalog_delete(CatalogDeleteRequest {
                id: artboard.id.clone(),
                kind: DocumentKind::Artboard,
                expected_revision: 1,
                confirmation_fingerprint: None,
            })
            .unwrap();
        assert!(!preview.deleted);
        assert!(preview.requires_confirmation);
        assert_eq!(preview.references.len(), 1);
        let stale_confirmation = persistence
            .document_catalog_delete(CatalogDeleteRequest {
                id: artboard.id.clone(),
                kind: DocumentKind::Artboard,
                expected_revision: 1,
                confirmation_fingerprint: Some("stale-reference-preview".into()),
            })
            .unwrap();
        assert!(!stale_confirmation.deleted);
        assert!(stale_confirmation.requires_confirmation);
        assert_eq!(
            stale_confirmation.confirmation_fingerprint,
            preview.confirmation_fingerprint
        );
        let deleted = persistence
            .document_catalog_delete(CatalogDeleteRequest {
                id: artboard.id,
                kind: DocumentKind::Artboard,
                expected_revision: 1,
                confirmation_fingerprint: preview.confirmation_fingerprint,
            })
            .unwrap();
        assert!(deleted.deleted);
        let flow = persistence.projects.open(&saved.project.id).unwrap();
        assert!(!flow.project.graph.nodes[0]
            .config
            .contains_key("workspaceId"));
    }

    #[test]
    fn artboard_delete_serializes_unlink_against_a_concurrent_stale_save() {
        let (_temp, persistence) = persistence();
        let persistence = std::sync::Arc::new(persistence);
        let artboard = persistence
            .document_catalog_create(CatalogCreateRequest {
                kind: DocumentKind::Artboard,
                name: "Konkurrenz".into(),
                operation_id: None,
            })
            .unwrap();
        let created = persistence
            .projects
            .create(CreateProjectRequest {
                name: "Flow".into(),
            })
            .unwrap();
        let mut project = created.project;
        project.graph.nodes.push(GraphNode {
            id: "artboard-node".into(),
            module_id: "brand.artboard".into(),
            module_version: 1,
            position: CanvasPosition { x: 0.0, y: 0.0 },
            label: None,
            label_id: None,
            config: serde_json::from_value(json!({"workspaceId":artboard.id})).unwrap(),
            update_policy: UpdatePolicy::Manual,
        });
        let saved = persistence
            .projects
            .save(SaveProjectRequest {
                expected_updated_at: project.updated_at,
                expected_revision: 1,
                project,
            })
            .unwrap();
        let confirmation_fingerprint = persistence
            .document_catalog_delete(CatalogDeleteRequest {
                id: artboard.id.clone(),
                kind: DocumentKind::Artboard,
                expected_revision: 1,
                confirmation_fingerprint: None,
            })
            .unwrap()
            .confirmation_fingerprint;
        let entered = std::sync::Arc::new(std::sync::Barrier::new(2));
        let release = std::sync::Arc::new(std::sync::Barrier::new(2));
        *persistence.catalog_delete_test_hook.lock().unwrap() =
            Some((entered.clone(), release.clone()));

        let delete_persistence = persistence.clone();
        let delete_id = artboard.id.clone();
        let delete = std::thread::spawn(move || {
            delete_persistence.document_catalog_delete(CatalogDeleteRequest {
                id: delete_id,
                kind: DocumentKind::Artboard,
                expected_revision: 1,
                confirmation_fingerprint,
            })
        });
        entered.wait();

        let save_persistence = persistence.clone();
        let stale_project = saved.project.clone();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let save = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            save_persistence.projects.save(SaveProjectRequest {
                expected_updated_at: stale_project.updated_at,
                expected_revision: saved.revision,
                project: stale_project,
            })
        });
        started_rx.recv().unwrap();
        release.wait();

        assert!(delete.join().unwrap().unwrap().deleted);
        assert!(save
            .join()
            .unwrap()
            .unwrap_err()
            .contains("Speicherkonflikt"));
        let current = persistence.projects.open(&saved.project.id).unwrap();
        assert!(!current.project.graph.nodes[0]
            .config
            .contains_key("workspaceId"));
    }

    #[test]
    fn deleting_artboard_fails_closed_when_a_flow_cannot_be_checked() {
        let (temp, persistence) = persistence();
        let artboard = persistence
            .document_catalog_create(CatalogCreateRequest {
                kind: DocumentKind::Artboard,
                name: "Sicher löschen".into(),
                operation_id: None,
            })
            .unwrap();
        let corrupt = temp.path().join("projects").join("corrupt-flow");
        std::fs::create_dir_all(&corrupt).unwrap();
        std::fs::write(corrupt.join("project.flowz.json"), b"{not-json").unwrap();
        std::fs::write(corrupt.join("revision"), b"1").unwrap();

        let error = persistence
            .document_catalog_delete(CatalogDeleteRequest {
                id: artboard.id.clone(),
                kind: DocumentKind::Artboard,
                expected_revision: 1,
                confirmation_fingerprint: None,
            })
            .unwrap_err();
        assert!(error.contains("nicht sicher gelöscht"));
        assert!(persistence
            .document_catalog_list()
            .unwrap()
            .iter()
            .any(|record| record.id == artboard.id));
    }
}
