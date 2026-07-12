use crate::persistence::{BlobMetadata, Persistence, StoredResult};
use chrono::Utc;
use image::{
    codecs::{jpeg::JpegEncoder, webp::WebPEncoder},
    imageops::FilterType,
    DynamicImage, GenericImageView, ImageDecoder, ImageEncoder, ImageReader, Rgba,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Cursor;
use uuid::Uuid;

const MAX_SOURCE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_SOURCE_PIXELS: u64 = 100_000_000;
const MAX_OUTPUT_PIXELS: u64 = 64_000_000;
const MAX_DECODED_BYTES: u64 = 512 * 1024 * 1024;
const RECIPE_VERSION: u32 = 2;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransformRecipe {
    mode: String,
    target_width: u32,
    target_height: u32,
    no_upscale: bool,
    output_format: String,
    quality: u8,
    background: String,
    crop_x: f64,
    crop_y: f64,
    crop_width: f64,
    crop_height: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransformRequest {
    run_id: String,
    project_id: String,
    node_id: String,
    source: String,
    recipe: TransformRecipe,
    execution_fingerprint: String,
    group_run_id: String,
    list_index: usize,
    list_count: usize,
    expected_config: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransformResult {
    result_id: String,
    asset_id: String,
    blob_hash: String,
    media_type: String,
    width: u32,
    height: u32,
    has_alpha: bool,
    recipe_fingerprint: String,
    cached: bool,
}

fn validate_hash(source: &str) -> Result<&str, String> {
    let hash = source.strip_prefix("flowz-cas:").unwrap_or(source);
    if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Bildbearbeitung akzeptiert ausschließlich lokale CAS-Bilder.".into());
    }
    Ok(hash)
}

fn validate_recipe(recipe: &TransformRecipe) -> Result<(), String> {
    if !matches!(recipe.mode.as_str(), "fit" | "fill" | "free") {
        return Err("Unbekannter Zuschnittmodus.".into());
    }
    if recipe.target_width == 0
        || recipe.target_height == 0
        || u64::from(recipe.target_width) * u64::from(recipe.target_height) > MAX_OUTPUT_PIXELS
    {
        return Err("Das Zielbild muss zwischen 1 Pixel und 64 Megapixel groß sein.".into());
    }
    if !matches!(recipe.output_format.as_str(), "png" | "jpeg" | "webp") {
        return Err("Unterstützte Formate sind PNG, JPEG und WebP.".into());
    }
    if !(1..=100).contains(&recipe.quality) {
        return Err("JPEG-Qualität muss zwischen 1 und 100 liegen.".into());
    }
    if !_COLOR.is_match(&recipe.background) {
        return Err("Die Hintergrundfarbe muss als #RRGGBB angegeben werden.".into());
    }
    for value in [
        recipe.crop_x,
        recipe.crop_y,
        recipe.crop_width,
        recipe.crop_height,
    ] {
        if !value.is_finite() {
            return Err("Ungültiger freier Zuschnitt.".into());
        }
    }
    if recipe.crop_x < 0.0
        || recipe.crop_y < 0.0
        || recipe.crop_width <= 0.0
        || recipe.crop_height <= 0.0
        || recipe.crop_x + recipe.crop_width > 1.000_001
        || recipe.crop_y + recipe.crop_height > 1.000_001
    {
        return Err("Der freie Zuschnitt muss vollständig im Bild liegen.".into());
    }
    Ok(())
}

// Rust has no regex literals. Kept tiny and explicit for this single color shape.
struct ColorShape;
impl ColorShape {
    fn is_match(&self, value: &str) -> bool {
        value.len() == 7
            && value.starts_with('#')
            && value[1..].bytes().all(|b| b.is_ascii_hexdigit())
    }
}
const _: () = ();
#[allow(non_upper_case_globals)]
static r#_COLOR: ColorShape = ColorShape;

fn target_dimensions(
    source: (u32, u32),
    target: (u32, u32),
    cover: bool,
    no_upscale: bool,
) -> (u32, u32) {
    let (sw, sh) = (f64::from(source.0), f64::from(source.1));
    let width_scale = f64::from(target.0) / sw;
    let height_scale = f64::from(target.1) / sh;
    let mut scale = if cover {
        width_scale.max(height_scale)
    } else {
        width_scale.min(height_scale)
    };
    if no_upscale {
        scale = scale.min(1.0);
    }
    (
        ((sw * scale).round().max(1.0) as u32),
        ((sh * scale).round().max(1.0) as u32),
    )
}

fn crop_rectangle(
    dimensions: (u32, u32),
    recipe: &TransformRecipe,
) -> Result<(u32, u32, u32, u32), String> {
    let (w, h) = dimensions;
    if w == 0 || h == 0 {
        return Err("Leeres Quellbild.".into());
    }
    let x = ((recipe.crop_x * f64::from(w)).floor() as u32).min(w - 1);
    let y = ((recipe.crop_y * f64::from(h)).floor() as u32).min(h - 1);
    let right = (((recipe.crop_x + recipe.crop_width) * f64::from(w)).ceil() as u32).min(w);
    let bottom = (((recipe.crop_y + recipe.crop_height) * f64::from(h)).ceil() as u32).min(h);
    if right <= x || bottom <= y {
        return Err("Der freie Zuschnitt enthält keine Pixel.".into());
    }
    Ok((x, y, right - x, bottom - y))
}

fn oriented_image(bytes: &[u8]) -> Result<DynamicImage, String> {
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| "Das Quellbildformat ist ungültig.".to_string())?;
    let mut decoder = reader
        .into_decoder()
        .map_err(|_| "Das Quellbild konnte nicht dekodiert werden.".to_string())?;
    let (w, h) = decoder.dimensions();
    let pixels = u64::from(w) * u64::from(h);
    if pixels == 0 || pixels > MAX_SOURCE_PIXELS || decoder.total_bytes() > MAX_DECODED_BYTES {
        return Err("Das Quellbild überschreitet die sicheren Pixel- oder Speichergrenzen.".into());
    }
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut image = DynamicImage::from_decoder(decoder)
        .map_err(|_| "Das Quellbild konnte nicht dekodiert werden.".to_string())?;
    image.apply_orientation(orientation);
    Ok(image)
}

fn parse_background(value: &str) -> Rgba<u8> {
    let byte = |start| u8::from_str_radix(&value[start..start + 2], 16).unwrap_or(255);
    Rgba([byte(1), byte(3), byte(5), 255])
}

fn transform(image: DynamicImage, recipe: &TransformRecipe) -> Result<DynamicImage, String> {
    let source = if recipe.mode == "free" {
        let (x, y, cw, ch) = crop_rectangle(image.dimensions(), recipe)?;
        image.crop_imm(x, y, cw, ch)
    } else {
        image
    };
    if recipe.mode == "fill" {
        let dimensions = target_dimensions(
            source.dimensions(),
            (recipe.target_width, recipe.target_height),
            true,
            recipe.no_upscale,
        );
        let resized = source.resize_exact(dimensions.0, dimensions.1, FilterType::Lanczos3);
        let out_w = recipe.target_width.min(dimensions.0);
        let out_h = recipe.target_height.min(dimensions.1);
        return Ok(resized.crop_imm(
            (dimensions.0 - out_w) / 2,
            (dimensions.1 - out_h) / 2,
            out_w,
            out_h,
        ));
    }
    let dimensions = target_dimensions(
        source.dimensions(),
        (recipe.target_width, recipe.target_height),
        false,
        recipe.no_upscale,
    );
    Ok(source.resize_exact(dimensions.0, dimensions.1, FilterType::Lanczos3))
}

fn validate_current_target(
    persistence: &Persistence,
    request: &TransformRequest,
    source_hash: &str,
) -> Result<(), String> {
    let project = persistence.projects.open(&request.project_id)?.project;
    let node = project
        .graph
        .nodes
        .iter()
        .find(|node| node.id == request.node_id && node.module_id == "image.transform")
        .ok_or("Die Bildbearbeitungs-Node gehört nicht mehr zum Projekt.")?;
    if Value::Object(node.config.clone()) != request.expected_config {
        return Err(
            "Die Bildbearbeitung wurde geändert; das alte Ergebnis wird nicht aktiviert.".into(),
        );
    }
    let sources: Vec<_> = project
        .graph
        .edges
        .iter()
        .filter(|edge| {
            edge.target_node_id == request.node_id
                && matches!(edge.target_port_id.as_str(), "image" | "imageLists")
        })
        .collect();
    if sources.is_empty() {
        return Err("Die Bildquelle ist nicht mehr verbunden.".into());
    }
    let mut owned = false;
    for edge in sources {
        let matches = if edge.source_port_id == "image" && edge.target_port_id == "image" {
            persistence.database.node_active_image_hash_is(
                &request.project_id,
                &edge.source_node_id,
                source_hash,
            )?
        } else {
            persistence.database.node_owns_image_hash(
                &request.project_id,
                &edge.source_node_id,
                source_hash,
            )?
        };
        if matches {
            owned = true;
            break;
        }
    }
    if !owned {
        return Err("Das angeforderte Bild gehört nicht mehr zu einer verbundenen Quelle.".into());
    }
    Ok(())
}

fn encode(
    image: &DynamicImage,
    recipe: &TransformRecipe,
) -> Result<(Vec<u8>, String, bool), String> {
    let mut bytes = Vec::new();
    match recipe.output_format.as_str() {
        "png" => {
            let has_alpha = image.to_rgba8().pixels().any(|pixel| pixel[3] < 255);
            image
                .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
                .map_err(|e| e.to_string())?;
            Ok((bytes, "image/png".into(), has_alpha))
        }
        "webp" => {
            let rgba = image.to_rgba8();
            let has_alpha = rgba.pixels().any(|pixel| pixel[3] < 255);
            WebPEncoder::new_lossless(&mut bytes)
                .write_image(
                    &rgba,
                    rgba.width(),
                    rgba.height(),
                    image::ExtendedColorType::Rgba8,
                )
                .map_err(|e| e.to_string())?;
            Ok((bytes, "image/webp".into(), has_alpha))
        }
        "jpeg" => {
            let rgba = image.to_rgba8();
            let background = parse_background(&recipe.background);
            let mut rgb = image::RgbImage::new(rgba.width(), rgba.height());
            for (x, y, pixel) in rgba.enumerate_pixels() {
                let a = u16::from(pixel[3]);
                let blend = |c: u8, b: u8| {
                    ((u16::from(c) * a + u16::from(b) * (255 - a) + 127) / 255) as u8
                };
                rgb.put_pixel(
                    x,
                    y,
                    image::Rgb([
                        blend(pixel[0], background[0]),
                        blend(pixel[1], background[1]),
                        blend(pixel[2], background[2]),
                    ]),
                );
            }
            JpegEncoder::new_with_quality(&mut bytes, recipe.quality)
                .encode_image(&rgb)
                .map_err(|e| e.to_string())?;
            Ok((bytes, "image/jpeg".into(), false))
        }
        _ => unreachable!(),
    }
}

fn result_from(
    stored: StoredResult,
    width: u32,
    height: u32,
    fingerprint: String,
    cached: bool,
) -> Result<TransformResult, String> {
    Ok(TransformResult {
        result_id: stored.result_id,
        asset_id: stored
            .asset_id
            .ok_or("Gespeichertes Ergebnis hat kein Asset.")?,
        blob_hash: stored
            .blob_hash
            .ok_or("Gespeichertes Ergebnis hat keinen Blob.")?,
        media_type: stored.media_type.unwrap_or_else(|| "image/png".into()),
        width,
        height,
        has_alpha: stored
            .parameters
            .as_ref()
            .and_then(|p| p.get("hasAlpha"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        recipe_fingerprint: fingerprint,
        cached,
    })
}

#[tauri::command]
pub async fn transform_image(
    request: TransformRequest,
    persistence: tauri::State<'_, Persistence>,
) -> Result<TransformResult, String> {
    Uuid::parse_str(&request.run_id).map_err(|_| "Ungültige Lauf-ID.".to_string())?;
    Uuid::parse_str(&request.group_run_id).map_err(|_| "Ungültige Gruppenlauf-ID.".to_string())?;
    if request.list_count == 0
        || request.list_count > 128
        || request.list_index >= request.list_count
    {
        return Err("Ungültige Listenposition für die Bildbearbeitung.".into());
    }
    validate_recipe(&request.recipe)?;
    let source_hash = validate_hash(&request.source)?.to_ascii_lowercase();
    validate_current_target(&persistence, &request, &source_hash)?;
    let canonical = serde_json::to_vec(
        &json!({"recipeVersion":RECIPE_VERSION,"sourceHash":source_hash,"recipe":request.recipe}),
    )
    .map_err(|e| e.to_string())?;
    let fingerprint = format!("{:x}", Sha256::digest(canonical));
    if request.list_count == 1 {
        if let Some(stored) = persistence.database.cached_local_image_result(
            &request.project_id,
            &request.node_id,
            "image-transform",
            &fingerprint,
        )? {
            let w = stored
                .parameters
                .as_ref()
                .and_then(|p| p.get("width"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32;
            let h = stored
                .parameters
                .as_ref()
                .and_then(|p| p.get("height"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32;
            validate_current_target(&persistence, &request, &source_hash)?;
            persistence.database.set_active_result(
                &request.project_id,
                &request.node_id,
                &stored.result_id,
            )?;
            return result_from(stored, w, h, fingerprint, true);
        }
    }
    let metadata = persistence.blobs.metadata(&source_hash)?;
    if metadata.size_bytes > MAX_SOURCE_BYTES || !metadata.media_type.starts_with("image/") {
        return Err("Das CAS-Objekt ist kein unterstütztes Bild oder zu groß.".into());
    }
    let bytes = persistence.blobs.read(&source_hash)?;
    let image = oriented_image(&bytes)?;
    let output = transform(image, &request.recipe)?;
    let (width, height) = output.dimensions();
    let (encoded, media_type, has_alpha) = encode(&output, &request.recipe)?;
    let extension = match request.recipe.output_format.as_str() {
        "jpeg" => "jpg",
        value => value,
    };
    let blob: BlobMetadata = persistence.blobs.import_bytes(
        &encoded,
        media_type.clone(),
        Some(format!("FlowZ-Bildbearbeitung.{extension}")),
    )?;
    validate_current_target(&persistence, &request, &source_hash)?;
    let result_id = Uuid::new_v4().to_string();
    let asset_id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let parameters = json!({"recipeVersion":RECIPE_VERSION,"sourceHash":source_hash,"recipeFingerprint":fingerprint,"executionFingerprint":request.execution_fingerprint,"groupRunId":request.group_run_id,"listIndex":request.list_index,"listCount":request.list_count,"width":width,"height":height,"hasAlpha":has_alpha,"colorSpace":"sRGB","mode":request.recipe.mode,"format":request.recipe.output_format,"noUpscale":request.recipe.no_upscale});
    let stored = persistence.database.record_local_image_result_atomic(
        &result_id,
        &request.run_id,
        &request.project_id,
        &request.node_id,
        "local/image-transform",
        "image-transform",
        &blob,
        &asset_id,
        &parameters,
        &now,
        true,
    )?;
    result_from(stored, width, height, fingerprint, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn geometry_rounds_without_zero() {
        assert_eq!(target_dimensions((3, 2), (2, 2), false, false), (2, 1));
        assert_eq!(target_dimensions((2, 3), (2, 2), true, false), (2, 3));
    }
    #[test]
    fn no_upscale_keeps_source() {
        assert_eq!(target_dimensions((10, 5), (100, 100), false, true), (10, 5));
        assert_eq!(
            target_dimensions((100, 50), (50, 100), true, true),
            (100, 50)
        );
    }
    #[test]
    fn edge_crop_is_nonzero_and_never_panics() {
        let recipe = TransformRecipe {
            mode: "free".into(),
            target_width: 1,
            target_height: 1,
            no_upscale: true,
            output_format: "png".into(),
            quality: 90,
            background: "#ffffff".into(),
            crop_x: 0.999,
            crop_y: 0.999,
            crop_width: 0.001,
            crop_height: 0.001,
        };
        assert_eq!(crop_rectangle((10, 10), &recipe).unwrap(), (9, 9, 1, 1));
        assert_eq!(
            transform(DynamicImage::new_rgba8(10, 10), &recipe)
                .unwrap()
                .dimensions(),
            (1, 1)
        );
    }
    #[test]
    fn rejects_paths() {
        assert!(validate_hash("/tmp/private.png").is_err());
        assert!(validate_hash(&"a".repeat(64)).is_ok());
    }
    #[test]
    fn alpha_is_composited_for_jpeg() {
        let image =
            DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(1, 1, Rgba([0, 0, 0, 0])));
        let recipe = TransformRecipe {
            mode: "fit".into(),
            target_width: 1,
            target_height: 1,
            no_upscale: true,
            output_format: "jpeg".into(),
            quality: 90,
            background: "#ffffff".into(),
            crop_x: 0.0,
            crop_y: 0.0,
            crop_width: 1.0,
            crop_height: 1.0,
        };
        let (bytes, _, alpha) = encode(&image, &recipe).unwrap();
        assert!(!alpha);
        let decoded = image::load_from_memory(&bytes).unwrap().to_rgb8();
        assert!(decoded.get_pixel(0, 0)[0] > 245);
    }
}
