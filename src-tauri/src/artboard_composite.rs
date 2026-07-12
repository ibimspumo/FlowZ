use crate::persistence::{
    ArtboardCompositeCommit, Persistence, RecordArtboardCompositeBatch, StoredResult,
};
use chrono::Utc;
use image::{codecs::png::PngDecoder, ImageDecoder};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, io::Cursor};

const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
const MAX_PNG_BYTES: usize = 32 * 1024 * 1024;
const MAX_DIMENSION: u32 = 16_384;
const MAX_PIXELS: u64 = 64 * 1024 * 1024;
const MAX_COMPOSITES: usize = 32;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtboardCompositeInput {
    pub board_id: String,
    pub active: bool,
    pub selected_index: Option<u32>,
    pub png_bytes: Vec<u8>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PersistArtboardCompositesRequest {
    pub operation_id: String,
    pub project_id: String,
    pub node_id: String,
    pub workspace_id: String,
    pub revision_id: String,
    pub composites: Vec<ArtboardCompositeInput>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtboardCompositeResult {
    pub board_id: String,
    pub active: bool,
    pub selected_index: Option<u32>,
    pub result_id: String,
    pub asset_id: String,
    pub blob_hash: String,
    pub media_type: String,
    pub width: u32,
    pub height: u32,
    pub created_at: String,
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._:-".contains(character))
}

pub(crate) fn valid_id_for_export(value: &str) -> bool {
    valid_id(value)
}

fn stable_id(prefix: &str, parts: &[&str]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"flowz.artboard-composite.v1\0");
    for part in parts {
        hasher.update(part.as_bytes());
        hasher.update([0]);
    }
    format!("{prefix}-{:x}", hasher.finalize())
}

pub(crate) fn validate_png(bytes: &[u8]) -> Result<(u32, u32), String> {
    if bytes.len() < PNG_SIGNATURE.len() || bytes.len() > MAX_PNG_BYTES {
        return Err("Ein Artboard-PNG muss zwischen 8 Byte und 32 MiB groß sein.".into());
    }
    if &bytes[..PNG_SIGNATURE.len()] != PNG_SIGNATURE {
        return Err("Das Artboard-Composite ist keine PNG-Datei.".into());
    }
    let decoder = PngDecoder::new(Cursor::new(bytes))
        .map_err(|_| "Das Artboard-PNG ist beschädigt oder unvollständig.".to_string())?;
    let (width, height) = decoder.dimensions();
    let pixels = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or_else(|| "Das Artboard-PNG ist zu groß.".to_string())?;
    if width == 0
        || height == 0
        || width > MAX_DIMENSION
        || height > MAX_DIMENSION
        || pixels > MAX_PIXELS
        || decoder.total_bytes() > MAX_PIXELS * 4
    {
        return Err("Das Artboard-PNG überschreitet die sicheren Bildgrenzen.".into());
    }
    let decoded_len = usize::try_from(decoder.total_bytes())
        .map_err(|_| "Das Artboard-PNG ist zu groß.".to_string())?;
    let mut decoded = vec![0; decoded_len];
    decoder
        .read_image(&mut decoded)
        .map_err(|_| "Das Artboard-PNG ist beschädigt oder unvollständig.".to_string())?;
    Ok((width, height))
}

fn validate_request(request: &PersistArtboardCompositesRequest) -> Result<Vec<(u32, u32)>, String> {
    for (value, label) in [
        (&request.operation_id, "operationId"),
        (&request.project_id, "projectId"),
        (&request.node_id, "nodeId"),
        (&request.workspace_id, "workspaceId"),
        (&request.revision_id, "revisionId"),
    ] {
        if !valid_id(value) {
            return Err(format!("{label} ist ungültig."));
        }
    }
    if request.composites.is_empty() || request.composites.len() > MAX_COMPOSITES {
        return Err("Es müssen 1 bis 32 Artboard-Composites gespeichert werden.".into());
    }
    if request.composites.iter().filter(|item| item.active).count() != 1 {
        return Err("Genau ein Artboard-Composite muss aktiv sein.".into());
    }
    let mut board_ids = HashSet::new();
    let mut selected = HashSet::new();
    for item in &request.composites {
        if !valid_id(&item.board_id) || !board_ids.insert(item.board_id.as_str()) {
            return Err("Artboard-Composite-Board-IDs sind ungültig oder doppelt.".into());
        }
        if let Some(index) = item.selected_index {
            if usize::try_from(index).unwrap_or(usize::MAX) >= request.composites.len()
                || !selected.insert(index)
            {
                return Err("Die Reihenfolge der ausgewählten Artboards ist ungültig.".into());
            }
        }
    }
    if !selected.is_empty() && (0..selected.len() as u32).any(|index| !selected.contains(&index)) {
        return Err("Die ausgewählten Artboards müssen lückenlos geordnet sein.".into());
    }
    request
        .composites
        .iter()
        .map(|item| validate_png(&item.png_bytes))
        .collect()
}

fn batch_hash(request: &PersistArtboardCompositesRequest) -> String {
    let mut entries = request
        .composites
        .iter()
        .map(|item| {
            let png_hash = format!("{:x}", Sha256::digest(&item.png_bytes));
            (
                item.board_id.as_str(),
                item.active,
                item.selected_index,
                png_hash,
            )
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| left.0.cmp(right.0));
    let mut hasher = Sha256::new();
    for value in [
        request.project_id.as_str(),
        request.node_id.as_str(),
        request.workspace_id.as_str(),
        request.revision_id.as_str(),
    ] {
        hasher.update(value.as_bytes());
        hasher.update([0]);
    }
    for (board_id, active, selected_index, png_hash) in entries {
        hasher.update(board_id.as_bytes());
        hasher.update([u8::from(active)]);
        hasher.update(selected_index.unwrap_or(u32::MAX).to_be_bytes());
        hasher.update(png_hash.as_bytes());
    }
    format!("{:x}", hasher.finalize())
}

#[tauri::command]
pub fn artboard_composites_persist(
    request: PersistArtboardCompositesRequest,
    persistence: tauri::State<'_, Persistence>,
) -> Result<Vec<ArtboardCompositeResult>, String> {
    let dimensions = validate_request(&request)?;
    let project = persistence.projects.open(&request.project_id)?.project;
    let node = project
        .graph
        .nodes
        .iter()
        .find(|node| node.id == request.node_id && node.module_id == "brand.artboard")
        .ok_or("Der verknüpfte Artboard-Flow-Node existiert nicht mehr.")?;
    if node
        .config
        .get("artboardWorkspaceId")
        .and_then(serde_json::Value::as_str)
        != Some(request.workspace_id.as_str())
    {
        return Err("Der Flow-Node ist nicht mit diesem Artboard-Workspace verknüpft.".into());
    }

    let request_hash = batch_hash(&request);
    let created_at = Utc::now().to_rfc3339();
    let mut commits = Vec::with_capacity(request.composites.len());
    for (item, (width, height)) in request.composites.iter().zip(dimensions.iter().copied()) {
        let blob = persistence.blobs.import_bytes(
            &item.png_bytes,
            "image/png".into(),
            Some(format!("Artboard {}.png", item.board_id)),
        )?;
        let identity = [
            request.project_id.as_str(),
            request.node_id.as_str(),
            request.workspace_id.as_str(),
            request.revision_id.as_str(),
            request.operation_id.as_str(),
            item.board_id.as_str(),
        ];
        commits.push(ArtboardCompositeCommit {
            board_id: item.board_id.clone(),
            active: item.active,
            selected_index: item.selected_index,
            width,
            height,
            run_id: stable_id("run", &identity),
            result_id: stable_id("result", &identity),
            asset_id: stable_id("asset", &identity),
            blob,
        });
    }
    let stored =
        persistence
            .database
            .record_artboard_composite_batch(RecordArtboardCompositeBatch {
                operation_id: &request.operation_id,
                request_hash: &request_hash,
                project_id: &request.project_id,
                node_id: &request.node_id,
                workspace_id: &request.workspace_id,
                revision_id: &request.revision_id,
                created_at: &created_at,
                composites: &commits,
            })?;
    request
        .composites
        .iter()
        .zip(dimensions)
        .map(|(input, (width, height))| {
            let row: &StoredResult = stored
                .iter()
                .find(|row| {
                    row.parameters
                        .as_ref()
                        .and_then(|value| value.get("boardId"))
                        .and_then(serde_json::Value::as_str)
                        == Some(input.board_id.as_str())
                })
                .ok_or("Gespeichertes Artboard-Composite fehlt.")?;
            Ok(ArtboardCompositeResult {
                board_id: input.board_id.clone(),
                active: input.active,
                selected_index: input.selected_index,
                result_id: row.result_id.clone(),
                asset_id: row.asset_id.clone().ok_or("Artboard-Asset fehlt.")?,
                blob_hash: row.blob_hash.clone().ok_or("Artboard-PNG-Hash fehlt.")?,
                media_type: row.media_type.clone().unwrap_or_else(|| "image/png".into()),
                width,
                height,
                created_at: row.created_at.clone(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, ImageFormat};

    fn png() -> Vec<u8> {
        let mut bytes = Cursor::new(Vec::new());
        DynamicImage::new_rgba8(2, 3)
            .write_to(&mut bytes, ImageFormat::Png)
            .unwrap();
        bytes.into_inner()
    }
    fn request(composites: Vec<ArtboardCompositeInput>) -> PersistArtboardCompositesRequest {
        PersistArtboardCompositesRequest {
            operation_id: "operation-1".into(),
            project_id: "project-1".into(),
            node_id: "node-1".into(),
            workspace_id: "workspace-1".into(),
            revision_id: "revision-1".into(),
            composites,
        }
    }
    #[test]
    fn validates_real_png_and_selection_contract() {
        let dimensions = validate_request(&request(vec![ArtboardCompositeInput {
            board_id: "board-1".into(),
            active: true,
            selected_index: Some(0),
            png_bytes: png(),
        }]))
        .unwrap();
        assert_eq!(dimensions, vec![(2, 3)]);
    }
    #[test]
    fn rejects_signature_only_and_duplicate_or_gapped_selection() {
        let mut fake = PNG_SIGNATURE.to_vec();
        fake.extend_from_slice(b"not-a-png");
        assert!(validate_request(&request(vec![ArtboardCompositeInput {
            board_id: "board-1".into(),
            active: true,
            selected_index: None,
            png_bytes: fake
        }]))
        .unwrap_err()
        .contains("beschädigt"));
        let bytes = png();
        assert!(validate_request(&request(vec![
            ArtboardCompositeInput {
                board_id: "board-1".into(),
                active: true,
                selected_index: Some(0),
                png_bytes: bytes.clone()
            },
            ArtboardCompositeInput {
                board_id: "board-2".into(),
                active: false,
                selected_index: Some(2),
                png_bytes: bytes
            },
        ]))
        .unwrap_err()
        .contains("Reihenfolge"));
    }
    #[test]
    fn payload_hash_binds_pixels_and_revision_but_not_operation_id() {
        let a = request(vec![ArtboardCompositeInput {
            board_id: "board-1".into(),
            active: true,
            selected_index: Some(0),
            png_bytes: png(),
        }]);
        let mut retry = a.clone();
        retry.operation_id = "operation-1".into();
        let mut changed = a.clone();
        changed.revision_id = "revision-2".into();
        assert_eq!(batch_hash(&a), batch_hash(&retry));
        assert_ne!(batch_hash(&a), batch_hash(&changed));
    }
}
