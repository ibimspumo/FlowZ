use crate::persistence::{
    BlobMetadata, LocalImageBinding, Persistence, ProjectDocument, StoredResult,
};
use chrono::Utc;
use image::{DynamicImage, GenericImageView, ImageDecoder, ImageReader, RgbaImage};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Cursor;
use uuid::Uuid;

const RECIPE_VERSION: u32 = 2;
const MAX_SOURCE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_SOURCE_PIXELS: u64 = 100_000_000;
const MAX_DECODED_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrimRecipe {
    threshold: u8,
    padding: u8,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrimRequest {
    run_id: String,
    project_id: String,
    node_id: String,
    source: String,
    recipe: TrimRecipe,
    execution_fingerprint: String,
    group_run_id: String,
    list_index: usize,
    list_count: usize,
    expected_config: Value,
    #[serde(default)]
    expected_binding: Option<SourceBinding>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceBinding {
    source_node_id: String,
    source_port_id: String,
    target_port_id: String,
    hashes: Vec<String>,
}
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum TrimOutcome {
    Trimmed,
    NoAlpha,
    OpaqueNoop,
    FullyTransparent,
    BelowThreshold,
    Visible1x1,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrimResult {
    result_id: String,
    asset_id: String,
    blob_hash: String,
    media_type: String,
    source_width: u32,
    source_height: u32,
    width: u32,
    height: u32,
    recipe_fingerprint: String,
    cached: bool,
    outcome: TrimOutcome,
    target_current: bool,
}

fn hash(source: &str) -> Result<String, String> {
    let value = source.strip_prefix("flowz-cas:").unwrap_or(source);
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Transparenz beschneiden akzeptiert ausschließlich lokale CAS-Bilder.".into());
    }
    Ok(value.to_ascii_lowercase())
}
struct Decoded {
    image: DynamicImage,
    source_color_type: String,
    icc_profile_present: bool,
    source_had_alpha: bool,
}
fn decode(bytes: &[u8]) -> Result<Decoded, String> {
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| "Das Bildformat ist ungültig.".to_string())?;
    let mut decoder = reader
        .into_decoder()
        .map_err(|_| "Das Bild konnte nicht dekodiert werden.".to_string())?;
    let (w, h) = decoder.dimensions();
    if w == 0
        || h == 0
        || u64::from(w) * u64::from(h) > MAX_SOURCE_PIXELS
        || decoder.total_bytes() > MAX_DECODED_BYTES
    {
        return Err("Das Bild überschreitet die sicheren Pixel- oder Speichergrenzen.".into());
    }
    let source_color_type = format!("{:?}", decoder.color_type());
    let source_had_alpha = decoder.color_type().has_alpha();
    let icc_profile_present = decoder.icc_profile().ok().flatten().is_some();
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut image = DynamicImage::from_decoder(decoder)
        .map_err(|_| "Das Bild konnte nicht dekodiert werden.".to_string())?;
    image.apply_orientation(orientation);
    Ok(Decoded {
        image,
        source_color_type,
        icc_profile_present,
        source_had_alpha,
    })
}

fn alpha_bounds(image: &RgbaImage, threshold: u8) -> Option<(u32, u32, u32, u32)> {
    let (mut min_x, mut min_y) = (image.width(), image.height());
    let (mut max_x, mut max_y) = (0, 0);
    let mut found = false;
    for (x, y, pixel) in image.enumerate_pixels() {
        if pixel[3] > threshold {
            found = true;
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y)
        }
    }
    found.then_some((min_x, min_y, max_x + 1, max_y + 1))
}
fn trim(
    image: DynamicImage,
    recipe: &TrimRecipe,
    source_had_alpha: bool,
) -> (RgbaImage, TrimOutcome) {
    let rgba = image.to_rgba8();
    if !source_had_alpha {
        return (rgba, TrimOutcome::NoAlpha);
    }
    if rgba.pixels().all(|pixel| pixel[3] == 255) {
        return (rgba, TrimOutcome::OpaqueNoop);
    }
    let Some((left, top, right, bottom)) = alpha_bounds(&rgba, recipe.threshold) else {
        let outcome = if rgba.pixels().all(|pixel| pixel[3] == 0) {
            TrimOutcome::FullyTransparent
        } else {
            TrimOutcome::BelowThreshold
        };
        return (
            RgbaImage::from_pixel(1, 1, image::Rgba([0, 0, 0, 0])),
            outcome,
        );
    };
    let visible_1x1 = right - left == 1 && bottom - top == 1;
    let padding = u32::from(recipe.padding);
    let left = left.saturating_sub(padding);
    let top = top.saturating_sub(padding);
    let right = right.saturating_add(padding).min(rgba.width());
    let bottom = bottom.saturating_add(padding).min(rgba.height());
    let output = image::imageops::crop_imm(
        &rgba,
        left,
        top,
        (right - left).max(1),
        (bottom - top).max(1),
    )
    .to_image();
    (
        output,
        if visible_1x1 {
            TrimOutcome::Visible1x1
        } else {
            TrimOutcome::Trimmed
        },
    )
}
fn direct_local_binding(
    config: &serde_json::Map<String, Value>,
    request: &TrimRequest,
    source_hash: &str,
) -> Result<LocalImageBinding, String> {
    let direct = config
        .get("directMedia")
        .and_then(Value::as_object)
        .ok_or("Die direkte Bildreferenz fehlt.")?;
    if direct.get("kind").and_then(Value::as_str) != Some("image")
        || direct.get("blobHash").and_then(Value::as_str) != Some(source_hash)
        || request.list_count != 1
        || request.list_index != 0
    {
        return Err("Die direkte Bildreferenz wurde geändert oder passt nicht zum Lauf.".into());
    }
    let source = direct
        .get("source")
        .and_then(Value::as_object)
        .ok_or("Der direkten Bildreferenz fehlt ihre Provenienz.")?;
    let (mode, result_ids) = match source.get("kind").and_then(Value::as_str) {
        Some("project-result") => (
            "results",
            vec![source
                .get("resultId")
                .and_then(Value::as_str)
                .ok_or("Der lokalen Bildreferenz fehlt ihre Ergebnis-ID.")?
                .to_owned()],
        ),
        Some("asset-version") => (
            "library_version",
            vec![source
                .get("versionId")
                .and_then(Value::as_str)
                .ok_or("Der Asset-Bildreferenz fehlt ihre Versions-ID.")?
                .to_owned()],
        ),
        _ => return Err("Die direkte Bildprovenienz wird nicht unterstützt.".into()),
    };
    Ok(LocalImageBinding {
        source_node_id: request.node_id.clone(),
        mode: mode.into(),
        result_ids,
        expected_hashes: vec![source_hash.to_owned()],
    })
}

fn validate_target(
    persistence: &Persistence,
    request: &TrimRequest,
    source_hash: &str,
) -> Result<(), String> {
    let project = persistence.projects.open(&request.project_id)?.project;
    let node = project
        .graph
        .nodes
        .iter()
        .find(|node| node.id == request.node_id && node.module_id == "image.trim-transparent")
        .ok_or("Die Transparenz-Node gehört nicht mehr zum Projekt.")?;
    if Value::Object(node.config.clone()) != request.expected_config {
        return Err(
            "Die Transparenz-Node wurde geändert; das alte Ergebnis wird nicht aktiviert.".into(),
        );
    }
    let Some(binding) = request.expected_binding.as_ref() else {
        direct_local_binding(&node.config, request, source_hash)?;
        return Ok(());
    };
    let edge = project
        .graph
        .edges
        .iter()
        .find(|edge| {
            edge.target_node_id == request.node_id
                && edge.source_node_id == binding.source_node_id
                && edge.source_port_id == binding.source_port_id
                && edge.target_port_id == binding.target_port_id
        })
        .ok_or("Die gebundene Bildquelle oder ihr Port wurde geändert.")?;
    let _ = edge;
    let source_node = project
        .graph
        .nodes
        .iter()
        .find(|node| node.id == binding.source_node_id)
        .ok_or("Die Listenquelle fehlt.")?;
    let current_hashes = if source_node.module_id == "core.image-collection" {
        let ids = source_node
            .config
            .get("collectionResultIds")
            .and_then(Value::as_array)
            .ok_or("Die Bildauswahl ist ungültig.")?
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .ok_or("Ungültige Ergebnis-ID in der Bildauswahl.")
            })
            .collect::<Result<Vec<_>, _>>()?;
        persistence
            .database
            .image_hashes_for_results(&request.project_id, &ids)?
    } else if binding.source_port_id == "image" {
        persistence
            .database
            .active_image_identity(&request.project_id, &binding.source_node_id)?
            .map(|(_, hash, _)| vec![hash])
            .unwrap_or_default()
    } else if let Some(result_id) = binding.source_port_id.strip_prefix("variant:") {
        persistence
            .database
            .image_hashes_for_results(&request.project_id, &[result_id.to_owned()])?
    } else {
        let Some((_, _, parameters)) = persistence
            .database
            .active_image_identity(&request.project_id, &binding.source_node_id)?
        else {
            return Err("Die aktive Bildliste fehlt.".into());
        };
        let group = parameters
            .as_ref()
            .and_then(|value| value.get("groupRunId"))
            .and_then(Value::as_str)
            .ok_or("Die aktive Bildliste besitzt keine stabile Gruppen-ID.")?;
        persistence.database.image_hashes_for_group(
            &request.project_id,
            &binding.source_node_id,
            group,
        )?
    };
    if current_hashes != binding.hashes
        || request.list_count != current_hashes.len()
        || current_hashes.get(request.list_index).map(String::as_str) != Some(source_hash)
    {
        return Err(
            "Die aktive Bildliste oder ihre Reihenfolge wurde während des Laufs geändert.".into(),
        );
    }
    Ok(())
}
fn binding_for_project(
    project: &ProjectDocument,
    request: &TrimRequest,
) -> Result<LocalImageBinding, String> {
    let node = project
        .graph
        .nodes
        .iter()
        .find(|node| node.id == request.node_id && node.module_id == "image.trim-transparent")
        .ok_or("Die Transparenz-Node gehört nicht mehr zum Projekt.")?;
    if Value::Object(node.config.clone()) != request.expected_config {
        return Err("Die Transparenz-Node wurde geändert.".into());
    }
    let Some(expected) = request.expected_binding.as_ref() else {
        let source_hash = request
            .source
            .strip_prefix("flowz-cas:")
            .ok_or("Die direkte Bildquelle ist keine CAS-Referenz.")?;
        return direct_local_binding(&node.config, request, source_hash);
    };
    project
        .graph
        .edges
        .iter()
        .find(|edge| {
            edge.target_node_id == request.node_id
                && edge.source_node_id == expected.source_node_id
                && edge.source_port_id == expected.source_port_id
                && edge.target_port_id == expected.target_port_id
        })
        .ok_or("Die gebundene Bildquelle oder ihr Port wurde geändert.")?;
    let source = project
        .graph
        .nodes
        .iter()
        .find(|node| node.id == expected.source_node_id)
        .ok_or("Die Listenquelle fehlt.")?;
    let (mode, result_ids) = if source.module_id == "core.image-collection" {
        (
            "results",
            source
                .config
                .get("collectionResultIds")
                .and_then(Value::as_array)
                .ok_or("Die Bildauswahl ist ungültig.")?
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .map(str::to_owned)
                        .ok_or("Ungültige Ergebnis-ID.")
                })
                .collect::<Result<Vec<_>, _>>()?,
        )
    } else if expected.source_port_id == "image" {
        ("active", Vec::new())
    } else if let Some(id) = expected.source_port_id.strip_prefix("variant:") {
        ("results", vec![id.to_owned()])
    } else {
        ("active_group", Vec::new())
    };
    Ok(LocalImageBinding {
        source_node_id: expected.source_node_id.clone(),
        mode: mode.into(),
        result_ids,
        expected_hashes: expected.hashes.clone(),
    })
}

fn result(stored: StoredResult, fingerprint: String, cached: bool) -> Result<TrimResult, String> {
    let parameters = stored.parameters.as_ref();
    let number = |key| {
        parameters
            .and_then(|value| value.get(key))
            .and_then(Value::as_u64)
            .unwrap_or(0) as u32
    };
    Ok(TrimResult {
        result_id: stored.result_id,
        asset_id: stored.asset_id.ok_or("Asset fehlt.")?,
        blob_hash: stored.blob_hash.ok_or("Blob fehlt.")?,
        media_type: stored.media_type.unwrap_or_else(|| "image/png".into()),
        source_width: number("sourceWidth"),
        source_height: number("sourceHeight"),
        width: number("width"),
        height: number("height"),
        recipe_fingerprint: fingerprint,
        cached,
        outcome: parameters
            .and_then(|value| value.get("outcome"))
            .and_then(Value::as_str)
            .and_then(|value| match value {
                "trimmed" => Some(TrimOutcome::Trimmed),
                "no_alpha" => Some(TrimOutcome::NoAlpha),
                "opaque_noop" => Some(TrimOutcome::OpaqueNoop),
                "fully_transparent" => Some(TrimOutcome::FullyTransparent),
                "below_threshold" => Some(TrimOutcome::BelowThreshold),
                "visible_1x1" => Some(TrimOutcome::Visible1x1),
                _ => None,
            })
            .unwrap_or(TrimOutcome::Trimmed),
        target_current: stored.active,
    })
}

#[tauri::command]
pub async fn trim_transparent_image(
    request: TrimRequest,
    persistence: tauri::State<'_, Persistence>,
) -> Result<TrimResult, String> {
    Uuid::parse_str(&request.run_id).map_err(|_| "Ungültige Lauf-ID.".to_string())?;
    Uuid::parse_str(&request.group_run_id).map_err(|_| "Ungültige Gruppenlauf-ID.".to_string())?;
    if request.recipe.padding > 64
        || request.list_count == 0
        || request.list_count > 128
        || request.list_index >= request.list_count
    {
        return Err("Ungültige Transparenz-Recipe.".into());
    }
    let source_hash = hash(&request.source)?;
    validate_target(&persistence, &request, &source_hash)?;
    let canonical = serde_json::to_vec(
        &json!({"recipeVersion":RECIPE_VERSION,"sourceHash":source_hash,"recipe":request.recipe}),
    )
    .map_err(|error| error.to_string())?;
    let fingerprint = format!("{:x}", Sha256::digest(canonical));
    if request.list_count == 1 {
        if let Some(stored) = persistence.database.cached_local_image_result(
            &request.project_id,
            &request.node_id,
            "image-trim-transparent",
            &fingerprint,
        )? {
            let active =
                persistence
                    .projects
                    .with_project_lock(&request.project_id, |project| {
                        let binding = binding_for_project(project, &request)?;
                        persistence.database.activate_local_image_result_bound(
                            &request.project_id,
                            &request.node_id,
                            &stored.result_id,
                            &binding,
                        )
                    })?;
            let mut stored = stored;
            stored.active = active;
            return result(stored, fingerprint, true);
        }
    }
    let metadata = persistence.blobs.metadata(&source_hash)?;
    if metadata.size_bytes > MAX_SOURCE_BYTES || !metadata.media_type.starts_with("image/") {
        return Err("Das CAS-Objekt ist kein unterstütztes Bild oder zu groß.".into());
    }
    let decoded = decode(&persistence.blobs.read(&source_hash)?)?;
    let (source_width, source_height) = decoded.image.dimensions();
    let source_color_type = decoded.source_color_type;
    let source_icc_profile_present = decoded.icc_profile_present;
    let (output, outcome) = trim(decoded.image, &request.recipe, decoded.source_had_alpha);
    let (width, height) = output.dimensions();
    let mut bytes = Vec::new();
    DynamicImage::ImageRgba8(output)
        .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
        .map_err(|error| error.to_string())?;
    let blob: BlobMetadata = persistence.blobs.import_bytes(
        &bytes,
        "image/png".into(),
        Some("FlowZ-Transparenzbeschnitt.png".into()),
    )?;
    let result_id = Uuid::new_v4().to_string();
    let asset_id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let parameters = json!({"recipeVersion":RECIPE_VERSION,"recipeFingerprint":fingerprint,"executionFingerprint":request.execution_fingerprint,"groupRunId":request.group_run_id,"listIndex":request.list_index,"listCount":request.list_count,"sourceHash":source_hash,"sourceWidth":source_width,"sourceHeight":source_height,"sourceColorType":source_color_type,"sourceIccProfilePresent":source_icc_profile_present,"width":width,"height":height,"threshold":request.recipe.threshold,"padding":request.recipe.padding,"outcome":outcome,"outputEncoding":"PNG-Ausgabe ohne verlustbehafteten Codec"});
    let stored = persistence
        .projects
        .with_project_lock(&request.project_id, |project| {
            let binding = binding_for_project(project, &request)?;
            persistence.database.record_bound_local_image_result_atomic(
                &result_id,
                &request.run_id,
                &request.project_id,
                &request.node_id,
                "local/image-trim-transparent",
                "image-trim-transparent",
                &blob,
                &asset_id,
                &parameters,
                &now,
                &binding,
                request.list_index == 0,
            )
        })?;
    result(stored, fingerprint, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn image(width: u32, height: u32) -> RgbaImage {
        RgbaImage::from_pixel(width, height, image::Rgba([1, 2, 3, 0]))
    }
    #[test]
    fn direct_binding_accepts_exact_cas_provenance_without_a_canvas_edge() {
        let hash = "a".repeat(64);
        let config = serde_json::json!({"directMedia":{"schemaVersion":1,"kind":"image","blobHash":hash,"mediaType":"image/png","priority":"fallback","source":{"kind":"project-result","projectId":"project","projectRevision":3,"resultId":"result"}}}).as_object().unwrap().clone();
        let request = TrimRequest {
            run_id: uuid::Uuid::new_v4().to_string(),
            project_id: "project".into(),
            node_id: "trim".into(),
            source: format!("flowz-cas:{hash}"),
            recipe: TrimRecipe {
                threshold: 0,
                padding: 0,
            },
            execution_fingerprint: "fingerprint".into(),
            group_run_id: uuid::Uuid::new_v4().to_string(),
            list_index: 0,
            list_count: 1,
            expected_config: Value::Object(config.clone()),
            expected_binding: None,
        };
        let binding = direct_local_binding(&config, &request, &hash).unwrap();
        assert_eq!(binding.mode, "results");
        assert_eq!(binding.result_ids, vec!["result"]);
        assert_eq!(binding.expected_hashes, vec![hash]);
    }
    #[test]
    fn bbox_is_exclusive_and_handles_one_pixel() {
        let mut value = image(5, 4);
        value.put_pixel(3, 2, image::Rgba([8, 9, 10, 1]));
        assert_eq!(alpha_bounds(&value, 0), Some((3, 2, 4, 3)));
        let (out, outcome) = trim(
            DynamicImage::ImageRgba8(value),
            &TrimRecipe {
                threshold: 0,
                padding: 0,
            },
            true,
        );
        assert_eq!(outcome, TrimOutcome::Visible1x1);
        assert_eq!(out.dimensions(), (1, 1));
        assert_eq!(out.get_pixel(0, 0).0, [8, 9, 10, 1]);
    }
    #[test]
    fn threshold_and_padding_are_exact() {
        let mut value = image(6, 6);
        value.put_pixel(2, 2, image::Rgba([1, 2, 3, 4]));
        value.put_pixel(3, 3, image::Rgba([5, 6, 7, 5]));
        assert_eq!(alpha_bounds(&value, 4), Some((3, 3, 4, 4)));
        assert_eq!(
            trim(
                DynamicImage::ImageRgba8(value),
                &TrimRecipe {
                    threshold: 4,
                    padding: 2
                },
                true
            )
            .0
            .dimensions(),
            (5, 5)
        );
    }
    #[test]
    fn opaque_is_unchanged_and_empty_is_one_pixel() {
        let opaque = RgbaImage::from_pixel(3, 2, image::Rgba([1, 2, 3, 255]));
        let (opaque_out, opaque_reason) = trim(
            DynamicImage::ImageRgba8(opaque),
            &TrimRecipe {
                threshold: 0,
                padding: 2,
            },
            true,
        );
        assert_eq!(opaque_out.dimensions(), (3, 2));
        assert_eq!(opaque_reason, TrimOutcome::OpaqueNoop);
        let (empty, outcome) = trim(
            DynamicImage::ImageRgba8(image(8, 8)),
            &TrimRecipe {
                threshold: 0,
                padding: 64,
            },
            true,
        );
        assert_eq!(outcome, TrimOutcome::FullyTransparent);
        assert_eq!(empty.dimensions(), (1, 1));
        assert_eq!(empty.get_pixel(0, 0)[3], 0);
    }
    #[test]
    fn outcomes_do_not_infer_from_dimensions() {
        let rgb = DynamicImage::ImageRgb8(image::RgbImage::from_pixel(1, 1, image::Rgb([1, 2, 3])));
        assert_eq!(
            trim(
                rgb,
                &TrimRecipe {
                    threshold: 0,
                    padding: 0
                },
                false
            )
            .1,
            TrimOutcome::NoAlpha
        );
        let semi = DynamicImage::ImageRgba8(RgbaImage::from_pixel(2, 2, image::Rgba([1, 2, 3, 4])));
        assert_eq!(
            trim(
                semi,
                &TrimRecipe {
                    threshold: 4,
                    padding: 0
                },
                true
            )
            .1,
            TrimOutcome::BelowThreshold
        );
    }
}
