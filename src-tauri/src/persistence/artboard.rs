use super::{BlobMetadata, Database, StoredResult};
use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateArtboardWorkspace {
    pub workspace_id: String,
    pub project_id: Option<String>,
    pub node_id: Option<String>,
    pub name: String,
    pub branch_id: String,
    pub revision_id: String,
    pub operation_id: String,
    pub workspace: Value,
    pub input_snapshot: Option<Value>,
    pub created_at: String,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyArtboardOperationBatch {
    pub workspace_id: String,
    pub branch_id: String,
    pub revision_id: String,
    pub operation_id: String,
    pub expected_revision_id: String,
    pub expected_revision_number: i64,
    pub operations: Vec<Value>,
    pub workspace: Value,
    pub input_snapshot: Option<Value>,
    pub created_at: String,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateArtboardBranch {
    pub workspace_id: String,
    pub branch_id: String,
    pub name: String,
    pub from_revision_id: String,
    pub created_at: String,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MoveArtboardHead {
    pub workspace_id: String,
    pub branch_id: String,
    pub expected_revision_id: String,
    pub target_revision_id: String,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegisterArtboardInputSnapshot {
    pub workspace_id: String,
    pub snapshot: Value,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct ArtboardCompositeCommit {
    pub board_id: String,
    pub active: bool,
    pub selected_index: Option<u32>,
    pub width: u32,
    pub height: u32,
    pub run_id: String,
    pub result_id: String,
    pub asset_id: String,
    pub blob: BlobMetadata,
}

#[derive(Debug, Clone)]
pub struct RecordArtboardCompositeBatch<'a> {
    pub operation_id: &'a str,
    pub request_hash: &'a str,
    pub project_id: &'a str,
    pub node_id: &'a str,
    pub workspace_id: &'a str,
    pub revision_id: &'a str,
    pub created_at: &'a str,
    pub composites: &'a [ArtboardCompositeCommit],
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtboardRevision {
    pub id: String,
    pub workspace_id: String,
    pub branch_id: String,
    pub parent_revision_id: Option<String>,
    pub revision_number: i64,
    pub workspace: Value,
    pub input_snapshot_id: Option<String>,
    pub operation_id: String,
    pub operations: Vec<Value>,
    pub created_at: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtboardBranch {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub head_revision_id: String,
    pub redo_revision_id: Option<String>,
    pub fork_revision_id: Option<String>,
    pub created_at: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtboardWorkspaceRecord {
    pub id: String,
    pub project_id: Option<String>,
    pub node_id: Option<String>,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    pub branches: Vec<ArtboardBranch>,
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._:-".contains(c))
}
fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}
fn require_id(value: &str, label: &str) -> Result<(), String> {
    if valid_id(value) {
        Ok(())
    } else {
        Err(format!("{label} ist ungültig."))
    }
}
fn require_time(value: &str) -> Result<(), String> {
    if value.len() >= 20 && value.len() <= 40 && value.contains('T') {
        Ok(())
    } else {
        Err("Zeitstempel ist ungültig.".into())
    }
}
fn object<'a>(value: &'a Value, label: &str) -> Result<&'a serde_json::Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("{label} muss ein Objekt sein."))
}
fn known(
    object: &serde_json::Map<String, Value>,
    allowed: &[&str],
    label: &str,
) -> Result<(), String> {
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        Err(format!("{label} enthält das unbekannte Feld {key}."))
    } else {
        Ok(())
    }
}
fn canonical_value(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys = map.keys().collect::<Vec<_>>();
            keys.sort();
            let mut sorted = serde_json::Map::new();
            for key in keys {
                sorted.insert(key.clone(), canonical_value(&map[key]));
            }
            Value::Object(sorted)
        }
        Value::Array(items) => Value::Array(items.iter().map(canonical_value).collect()),
        _ => value.clone(),
    }
}
fn canonical_json(value: &Value) -> Result<String, String> {
    serde_json::to_string(&canonical_value(value)).map_err(|error| error.to_string())
}
fn canonical_hash(value: &Value) -> Result<String, String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(canonical_json(value)?.as_bytes())
    ))
}
fn apply_request_hash(request: &ApplyArtboardOperationBatch) -> Result<String, String> {
    canonical_hash(&serde_json::json!({
        "workspaceId":request.workspace_id,"branchId":request.branch_id,"revisionId":request.revision_id,
        "expectedRevisionId":request.expected_revision_id,"expectedRevisionNumber":request.expected_revision_number,
        "operations":request.operations,"workspace":request.workspace,"inputSnapshot":request.input_snapshot
    }))
}
fn safe_text(value: &Value, label: &str, max: usize) -> Result<(), String> {
    let text = value
        .as_str()
        .ok_or_else(|| format!("{label} muss Text sein."))?;
    if text.is_empty() || text.len() > max {
        return Err(format!("{label} ist ungültig."));
    }
    let lower = text.to_ascii_lowercase();
    if [
        "http:",
        "https:",
        "file:",
        "data:",
        "javascript:",
        "url(",
        "<script",
        "<style",
        "<iframe",
        "@import",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
    {
        return Err(format!("{label} darf keine URL, CSS oder Code enthalten."));
    }
    Ok(())
}
fn finite_number(value: Option<&Value>, label: &str, min: f64, max: f64) -> Result<f64, String> {
    let number = value
        .and_then(Value::as_f64)
        .ok_or_else(|| format!("{label} fehlt oder ist nicht endlich."))?;
    if !number.is_finite() || number < min || number > max {
        return Err(format!("{label} liegt außerhalb der Grenzen."));
    }
    Ok(number)
}
fn valid_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value[1..]
            .chars()
            .all(|c| c.is_ascii_digit() || ('A'..='F').contains(&c))
}
fn validate_paint(value: &Value, label: &str) -> Result<(), String> {
    let paint = object(value, label)?;
    match paint.get("kind").and_then(Value::as_str) {
        Some("solid") => {
            known(paint, &["kind", "color"], label)?;
            if !valid_color(paint.get("color").and_then(Value::as_str).unwrap_or("")) {
                return Err(format!("{label}.color ist ungültig."));
            }
        }
        Some("linear-gradient") => {
            known(paint, &["kind", "angle", "stops"], label)?;
            finite_number(paint.get("angle"), &format!("{label}.angle"), -360.0, 360.0)?;
            let stops = paint
                .get("stops")
                .and_then(Value::as_array)
                .ok_or_else(|| format!("{label}.stops fehlt."))?;
            if stops.len() != 2 {
                return Err(format!("{label}.stops braucht genau zwei Einträge."));
            }
            let mut previous = -1.0;
            for stop in stops {
                let stop = object(stop, &format!("{label}.stop"))?;
                known(stop, &["color", "offset"], &format!("{label}.stop"))?;
                if !valid_color(stop.get("color").and_then(Value::as_str).unwrap_or("")) {
                    return Err(format!("{label}.stop.color ist ungültig."));
                }
                let offset = finite_number(
                    stop.get("offset"),
                    &format!("{label}.stop.offset"),
                    0.0,
                    1.0,
                )?;
                if offset < previous {
                    return Err(format!("{label}.stops müssen sortiert sein."));
                }
                previous = offset;
            }
        }
        _ => return Err(format!("{label}.kind ist ungültig.")),
    }
    Ok(())
}
fn validate_layer_style(value: &Value) -> Result<(), String> {
    let style = object(value, "Layer.style")?;
    known(
        style,
        &["opacity", "border", "borderRadius", "shadow"],
        "Layer.style",
    )?;
    if style.get("opacity").is_some() {
        finite_number(style.get("opacity"), "Layer.style.opacity", 0.0, 1.0)?;
    }
    if style.get("borderRadius").is_some() {
        finite_number(
            style.get("borderRadius"),
            "Layer.style.borderRadius",
            0.0,
            32768.0,
        )?;
    }
    if let Some(border) = style.get("border") {
        let border = object(border, "Layer.style.border")?;
        known(border, &["width", "color"], "Layer.style.border")?;
        finite_number(border.get("width"), "Layer.style.border.width", 0.0, 256.0)?;
        if !valid_color(border.get("color").and_then(Value::as_str).unwrap_or("")) {
            return Err("Layer.style.border.color ist ungültig.".into());
        }
    }
    if let Some(shadow) = style.get("shadow") {
        let shadow = object(shadow, "Layer.style.shadow")?;
        known(
            shadow,
            &["x", "y", "blur", "color", "opacity"],
            "Layer.style.shadow",
        )?;
        finite_number(shadow.get("x"), "Layer.style.shadow.x", -2048.0, 2048.0)?;
        finite_number(shadow.get("y"), "Layer.style.shadow.y", -2048.0, 2048.0)?;
        finite_number(shadow.get("blur"), "Layer.style.shadow.blur", 0.0, 512.0)?;
        finite_number(
            shadow.get("opacity"),
            "Layer.style.shadow.opacity",
            0.0,
            1.0,
        )?;
        if !valid_color(shadow.get("color").and_then(Value::as_str).unwrap_or("")) {
            return Err("Layer.style.shadow.color ist ungültig.".into());
        }
    }
    Ok(())
}
fn validate_binding(binding_id: &str, value: &Value) -> Result<(), String> {
    require_id(binding_id, "InputBinding-Schlüssel")?;
    let binding = object(value, "InputBinding")?;
    known(
        binding,
        &["id", "source", "snapshot", "mode"],
        "InputBinding",
    )?;
    if binding.get("id").and_then(Value::as_str) != Some(binding_id) {
        return Err("InputBinding.id stimmt nicht mit dem Schlüssel überein.".into());
    }
    let source = object(
        binding.get("source").ok_or("InputBinding.source fehlt.")?,
        "InputBinding.source",
    )?;
    known(
        source,
        &["projectId", "nodeId", "portId", "resultId"],
        "InputBinding.source",
    )?;
    for key in ["projectId", "nodeId", "portId", "resultId"] {
        require_id(
            source
                .get(key)
                .and_then(Value::as_str)
                .ok_or("InputBinding.source ist unvollständig.")?,
            key,
        )?
    }
    let snapshot = object(
        binding
            .get("snapshot")
            .ok_or("InputBinding.snapshot fehlt.")?,
        "InputBinding.snapshot",
    )?;
    match snapshot.get("kind").and_then(Value::as_str) {
        Some("cas") => {
            known(snapshot, &["kind", "hash"], "CAS-Snapshot")?;
            if !valid_hash(snapshot.get("hash").and_then(Value::as_str).unwrap_or("")) {
                return Err("CAS-Hash ist ungültig.".into());
            }
        }
        Some("artifact") => {
            known(
                snapshot,
                &["kind", "artifactType", "artifactHash"],
                "Artefakt-Snapshot",
            )?;
            require_id(
                snapshot
                    .get("artifactType")
                    .and_then(Value::as_str)
                    .ok_or("artifactType fehlt.")?,
                "artifactType",
            )?;
            if !valid_hash(
                snapshot
                    .get("artifactHash")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
            ) {
                return Err("Artefakt-Hash ist ungültig.".into());
            }
        }
        _ => return Err("InputBinding.snapshot.kind ist ungültig.".into()),
    }
    if !matches!(
        binding.get("mode").and_then(Value::as_str),
        Some("live" | "pinned")
    ) {
        return Err("InputBinding.mode ist ungültig.".into());
    }
    Ok(())
}
fn validate_document(value: &Value) -> Result<(f64, f64), String> {
    let document = object(value, "ArtboardDocument")?;
    known(
        document,
        &[
            "schemaVersion",
            "id",
            "name",
            "format",
            "paint",
            "rootLayerIds",
            "layers",
            "bindings",
            "tokenRefs",
        ],
        "ArtboardDocument",
    )?;
    if document.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err("ArtboardDocument.schemaVersion ist ungültig.".into());
    }
    require_id(
        document
            .get("id")
            .and_then(Value::as_str)
            .ok_or("ArtboardDocument.id fehlt.")?,
        "ArtboardDocument.id",
    )?;
    safe_text(
        document.get("name").ok_or("ArtboardDocument.name fehlt.")?,
        "ArtboardDocument.name",
        160,
    )?;
    let format = object(
        document
            .get("format")
            .ok_or("ArtboardDocument.format fehlt.")?,
        "ArtboardDocument.format",
    )?;
    known(
        format,
        &["preset", "width", "height"],
        "ArtboardDocument.format",
    )?;
    let preset = format
        .get("preset")
        .and_then(Value::as_str)
        .ok_or("ArtboardDocument.format.preset fehlt.")?;
    let expected = match preset {
        "instagram-post" => (1080.0, 1080.0),
        "instagram-story" => (1080.0, 1920.0),
        "youtube-thumbnail" => (1920.0, 1080.0),
        "meta-ad" => (1200.0, 628.0),
        _ => return Err("ArtboardDocument.format.preset ist ungültig.".into()),
    };
    let width = finite_number(
        format.get("width"),
        "ArtboardDocument.format.width",
        1.0,
        32768.0,
    )?;
    let height = finite_number(
        format.get("height"),
        "ArtboardDocument.format.height",
        1.0,
        32768.0,
    )?;
    if (width, height) != expected {
        return Err("ArtboardDocument.format passt nicht zum Preset.".into());
    }
    validate_paint(
        document
            .get("paint")
            .ok_or("ArtboardDocument.paint fehlt.")?,
        "ArtboardDocument.paint",
    )?;
    let bindings = document
        .get("bindings")
        .and_then(Value::as_object)
        .ok_or("ArtboardDocument.bindings fehlt.")?;
    for (id, binding) in bindings {
        validate_binding(id, binding)?
    }
    let layers = document
        .get("layers")
        .and_then(Value::as_object)
        .ok_or("ArtboardDocument.layers fehlt.")?;
    if layers.len() > 300 {
        return Err("ArtboardDocument enthält mehr als 300 Ebenen.".into());
    }
    let roots = document
        .get("rootLayerIds")
        .and_then(Value::as_array)
        .ok_or("ArtboardDocument.rootLayerIds fehlt.")?;
    let mut children = std::collections::HashMap::<String, Vec<String>>::new();
    let mut parent_count = std::collections::HashMap::<String, usize>::new();
    for (layer_id, value) in layers {
        require_id(layer_id, "Layer-ID")?;
        let layer = object(value, "ArtboardLayer")?;
        let common = [
            "id", "type", "name", "locked", "visible", "version", "geometry", "style",
        ];
        let specific: &[&str] = match layer.get("type").and_then(Value::as_str) {
            Some("group") => &["childIds"],
            Some("container") => &["childIds", "layout", "fill"],
            Some("text") => &[
                "text",
                "color",
                "fontRef",
                "fontFamily",
                "fontHash",
                "fontWeight",
                "fontStyle",
                "fontAxes",
                "fontSize",
                "align",
            ],
            Some("image") => &["bindingId", "casHash", "assetVersionId", "fit"],
            Some("shape") => &["shape", "fill"],
            _ => return Err("ArtboardLayer.type ist ungültig.".into()),
        };
        let mut allowed = common.to_vec();
        allowed.extend_from_slice(specific);
        known(layer, &allowed, "ArtboardLayer")?;
        if layer.get("id").and_then(Value::as_str) != Some(layer_id) {
            return Err("Layer-ID und Schlüssel stimmen nicht überein.".into());
        }
        if layer.get("locked").and_then(Value::as_bool).is_none()
            || layer.get("visible").and_then(Value::as_bool).is_none()
            || layer
                .get("version")
                .and_then(Value::as_u64)
                .is_none_or(|value| !(1..=9_007_199_254_740_991).contains(&value))
        {
            return Err("ArtboardLayer hat ungültige Statusfelder.".into());
        }
        safe_text(
            layer.get("name").ok_or("Layer.name fehlt.")?,
            "Layer.name",
            160,
        )?;
        let geometry = object(
            layer.get("geometry").ok_or("Layer.geometry fehlt.")?,
            "Layer.geometry",
        )?;
        known(
            geometry,
            &["x", "y", "width", "height", "rotation"],
            "Layer.geometry",
        )?;
        let x = finite_number(geometry.get("x"), "Layer.geometry.x", 0.0, width)?;
        let y = finite_number(geometry.get("y"), "Layer.geometry.y", 0.0, height)?;
        let w = finite_number(geometry.get("width"), "Layer.geometry.width", 1.0, width)?;
        let h = finite_number(geometry.get("height"), "Layer.geometry.height", 1.0, height)?;
        finite_number(
            geometry.get("rotation"),
            "Layer.geometry.rotation",
            -360.0,
            360.0,
        )?;
        if x + w > width || y + h > height {
            return Err("Layer.geometry liegt außerhalb des Artboards.".into());
        }
        if let Some(style) = layer.get("style") {
            validate_layer_style(style)?;
        }
        match layer.get("type").and_then(Value::as_str).unwrap() {
            "group" | "container" => {
                let ids = layer
                    .get("childIds")
                    .and_then(Value::as_array)
                    .ok_or("Group.childIds fehlt.")?;
                let mut group = Vec::new();
                for child in ids {
                    let child = child
                        .as_str()
                        .ok_or("Group.childIds enthält keinen Text.")?
                        .to_string();
                    *parent_count.entry(child.clone()).or_default() += 1;
                    group.push(child)
                }
                children.insert(layer_id.clone(), group);
                if layer.get("type").and_then(Value::as_str) == Some("container") {
                    validate_paint(
                        layer.get("fill").ok_or("Container.fill fehlt.")?,
                        "Container.fill",
                    )?;
                    let layout = object(
                        layer.get("layout").ok_or("Container.layout fehlt.")?,
                        "Container.layout",
                    )?;
                    match layout.get("mode").and_then(Value::as_str) {
                        Some("free") => {
                            known(layout, &["mode", "padding"], "Container.layout")?;
                        }
                        Some("flex") => {
                            known(
                                layout,
                                &["mode", "direction", "gap", "padding", "justify", "align"],
                                "Container.layout",
                            )?;
                            if !matches!(
                                layout.get("direction").and_then(Value::as_str),
                                Some("row" | "column")
                            ) || !matches!(
                                layout.get("justify").and_then(Value::as_str),
                                Some("start" | "center" | "end" | "space-between")
                            ) {
                                return Err("Container.flex ist ungültig.".into());
                            }
                            finite_number(layout.get("gap"), "Container.layout.gap", 0.0, 32768.0)?;
                        }
                        Some("grid") => {
                            known(
                                layout,
                                &["mode", "columns", "gap", "padding", "align"],
                                "Container.layout",
                            )?;
                            let columns = finite_number(
                                layout.get("columns"),
                                "Container.layout.columns",
                                1.0,
                                12.0,
                            )?;
                            if columns.fract() != 0.0 {
                                return Err("Container.layout.columns muss ganzzahlig sein.".into());
                            }
                            finite_number(layout.get("gap"), "Container.layout.gap", 0.0, 32768.0)?;
                        }
                        _ => return Err("Container.layout.mode ist ungültig.".into()),
                    }
                    let padding = finite_number(
                        layout.get("padding"),
                        "Container.layout.padding",
                        0.0,
                        32768.0,
                    )?;
                    if padding * 2.0 >= w.min(h) {
                        return Err(
                            "Container.layout.padding lässt keinen Inhaltsbereich übrig.".into(),
                        );
                    }
                    if layout.get("mode").and_then(Value::as_str) != Some("free")
                        && !matches!(
                            layout.get("align").and_then(Value::as_str),
                            Some("start" | "center" | "end" | "stretch")
                        )
                    {
                        return Err("Container.layout.align ist ungültig.".into());
                    }
                }
            }
            "text" => {
                safe_text(
                    layer.get("text").ok_or("TextLayer.text fehlt.")?,
                    "TextLayer.text",
                    20000,
                )?;
                finite_number(layer.get("fontSize"), "TextLayer.fontSize", 1.0, 2000.0)?;
                let color = layer
                    .get("color")
                    .and_then(Value::as_str)
                    .ok_or("TextLayer.color fehlt.")?;
                if color.len() != 7
                    || !color.starts_with('#')
                    || !color[1..]
                        .chars()
                        .all(|c| c.is_ascii_digit() || ('A'..='F').contains(&c))
                {
                    return Err("TextLayer.color ist ungültig.".into());
                }
                if !matches!(
                    layer.get("align").and_then(Value::as_str),
                    Some("left" | "center" | "right")
                ) {
                    return Err("TextLayer.align ist ungültig.".into());
                }
                if let Some(reference) = layer.get("fontRef") {
                    require_id(
                        reference
                            .as_str()
                            .ok_or("TextLayer.fontRef ist ungültig.")?,
                        "TextLayer.fontRef",
                    )?;
                }
                let family = layer.get("fontFamily");
                let font_hash = layer.get("fontHash");
                if family.is_some() != font_hash.is_some() {
                    return Err("TextLayer braucht Schriftfamilie und CAS-Hash gemeinsam.".into());
                }
                if let Some(family) = family {
                    safe_text(family, "TextLayer.fontFamily", 120)?;
                }
                if let Some(hash) = font_hash.and_then(Value::as_str) {
                    if !valid_hash(hash) {
                        return Err("TextLayer.fontHash ist ungültig.".into());
                    }
                }
                if layer.get("fontHash").is_some()
                    && layer.get("fontHash").and_then(Value::as_str).is_none()
                {
                    return Err("TextLayer.fontHash ist ungültig.".into());
                }
                if layer.get("fontWeight").is_some() {
                    let weight = finite_number(
                        layer.get("fontWeight"),
                        "TextLayer.fontWeight",
                        1.0,
                        1000.0,
                    )?;
                    if weight.fract() != 0.0 {
                        return Err("TextLayer.fontWeight muss ganzzahlig sein.".into());
                    }
                }
                if let Some(style) = layer.get("fontStyle").and_then(Value::as_str) {
                    if !matches!(style, "normal" | "italic") {
                        return Err("TextLayer.fontStyle ist ungültig.".into());
                    }
                }
                if layer.get("fontStyle").is_some()
                    && layer.get("fontStyle").and_then(Value::as_str).is_none()
                {
                    return Err("TextLayer.fontStyle ist ungültig.".into());
                }
                if let Some(axes) = layer.get("fontAxes") {
                    let axes = axes
                        .as_object()
                        .ok_or("TextLayer.fontAxes muss ein Objekt sein.")?;
                    if axes.len() > 16 {
                        return Err("TextLayer.fontAxes enthält zu viele Achsen.".into());
                    }
                    for (tag, value) in axes {
                        if tag.len() != 4 || !tag.chars().all(|c| c.is_ascii_alphanumeric()) {
                            return Err("TextLayer.fontAxes enthält eine ungültige Achse.".into());
                        }
                        finite_number(Some(value), "TextLayer.fontAxes", -100000.0, 100000.0)?;
                    }
                }
            }
            "image" => {
                if layer.get("bindingId").is_some()
                    && layer.get("bindingId").and_then(Value::as_str).is_none()
                {
                    return Err("ImageLayer.bindingId ist ungültig.".into());
                }
                if layer.get("casHash").is_some()
                    && layer.get("casHash").and_then(Value::as_str).is_none()
                {
                    return Err("ImageLayer.casHash ist ungültig.".into());
                }
                let binding = layer.get("bindingId").and_then(Value::as_str);
                let hash = layer.get("casHash").and_then(Value::as_str);
                if binding.is_none() && hash.is_none() {
                    return Err("ImageLayer braucht eine Bildreferenz.".into());
                }
                if let Some(binding) = binding {
                    if !bindings.contains_key(binding) {
                        return Err("ImageLayer.bindingId ist unbekannt.".into());
                    }
                }
                if let Some(hash) = hash {
                    if !valid_hash(hash) {
                        return Err("ImageLayer.casHash ist ungültig.".into());
                    }
                }
                if let Some(version) = layer.get("assetVersionId") {
                    let version = version
                        .as_str()
                        .ok_or("ImageLayer.assetVersionId ist ungültig.")?;
                    require_id(version, "ImageLayer.assetVersionId")?;
                    if hash.is_none() {
                        return Err("ImageLayer.assetVersionId braucht einen CAS-Hash.".into());
                    }
                }
                if !matches!(
                    layer.get("fit").and_then(Value::as_str),
                    Some("cover" | "contain" | "fill")
                ) {
                    return Err("ImageLayer.fit ist ungültig.".into());
                }
            }
            "shape" => {
                if !matches!(
                    layer.get("shape").and_then(Value::as_str),
                    Some("rectangle" | "ellipse")
                ) {
                    return Err("ShapeLayer.shape ist ungültig.".into());
                }
                validate_paint(
                    layer.get("fill").ok_or("ShapeLayer.fill fehlt.")?,
                    "ShapeLayer.fill",
                )?;
            }
            _ => {}
        }
    }
    let root_ids = roots
        .iter()
        .map(|value| {
            value
                .as_str()
                .ok_or("rootLayerIds enthält keinen Text.")
                .map(str::to_owned)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut seen_roots = HashSet::new();
    for root in &root_ids {
        if !layers.contains_key(root) || !seen_roots.insert(root) {
            return Err("rootLayerIds ist ungültig.".into());
        }
    }
    for (child, count) in parent_count {
        if !layers.contains_key(&child) || count > 1 || seen_roots.contains(&child) {
            return Err(
                "Artboard enthält unbekannte, mehrfach eingehängte oder zyklische Ebenen.".into(),
            );
        }
    }
    fn walk(
        id: &str,
        depth: usize,
        children: &std::collections::HashMap<String, Vec<String>>,
        visiting: &mut HashSet<String>,
        visited: &mut HashSet<String>,
    ) -> Result<(), String> {
        if depth > 6 {
            return Err("Artboard überschreitet die maximale Ebenentiefe 6.".into());
        }
        if !visiting.insert(id.into()) {
            return Err("Artboard enthält einen Ebenenzyklus.".into());
        }
        if let Some(next) = children.get(id) {
            for child in next {
                walk(child, depth + 1, children, visiting, visited)?
            }
        }
        visiting.remove(id);
        visited.insert(id.into());
        Ok(())
    }
    let mut visited = HashSet::new();
    for root in root_ids {
        walk(&root, 1, &children, &mut HashSet::new(), &mut visited)?
    }
    if visited.len() != layers.len() {
        return Err("Artboard enthält nicht erreichbare Ebenen.".into());
    }
    Ok((width, height))
}

fn validate_workspace(value: &Value, workspace_id: &str) -> Result<(), String> {
    let root = object(value, "ArtboardWorkspace")?;
    known(
        root,
        &[
            "schemaVersion",
            "id",
            "name",
            "boards",
            "placements",
            "selectedBoardIds",
            "activeBoardId",
            "pasteboard",
        ],
        "ArtboardWorkspace",
    )?;
    if root.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err("ArtboardWorkspace.schemaVersion ist ungültig.".into());
    }
    if root.get("id").and_then(Value::as_str) != Some(workspace_id) {
        return Err("ArtboardWorkspace.id stimmt nicht mit der Anfrage überein.".into());
    }
    let boards = root
        .get("boards")
        .and_then(Value::as_object)
        .ok_or("ArtboardWorkspace.boards fehlt.")?;
    if boards.is_empty() {
        return Err("Ein ArtboardWorkspace braucht mindestens ein Board.".into());
    }
    let placements = root
        .get("placements")
        .and_then(Value::as_object)
        .ok_or("ArtboardWorkspace.placements fehlt.")?;
    if placements.len() != boards.len() {
        return Err("Jedes Board braucht genau eine Platzierung.".into());
    }
    let active = root
        .get("activeBoardId")
        .and_then(Value::as_str)
        .ok_or("ArtboardWorkspace.activeBoardId fehlt.")?;
    if !boards.contains_key(active) {
        return Err("Das aktive Board fehlt.".into());
    }
    let selected = root
        .get("selectedBoardIds")
        .and_then(Value::as_array)
        .ok_or("ArtboardWorkspace.selectedBoardIds fehlt.")?;
    let mut seen = HashSet::new();
    for id in selected {
        let id = id.as_str().ok_or("selectedBoardIds enthält keinen Text.")?;
        if !boards.contains_key(id) || !seen.insert(id) {
            return Err("selectedBoardIds ist ungültig.".into());
        }
    }
    for (id, board) in boards {
        require_id(id, "Board-ID")?;
        let board = object(board, "Board")?;
        known(
            board,
            &[
                "id",
                "name",
                "activeRevisionId",
                "document",
                "inputSnapshot",
                "ancestry",
                "createdAt",
            ],
            "Board",
        )?;
        if board.get("id").and_then(Value::as_str) != Some(id) {
            return Err("Board-ID und Schlüssel stimmen nicht überein.".into());
        }
        require_id(
            board
                .get("activeRevisionId")
                .and_then(Value::as_str)
                .ok_or("activeRevisionId fehlt.")?,
            "activeRevisionId",
        )?;
        let document_value = board.get("document").ok_or("document fehlt.")?;
        validate_document(document_value)?;
        let document_bindings = document_value
            .get("bindings")
            .and_then(Value::as_object)
            .ok_or("ArtboardDocument.bindings fehlt.")?;
        let snapshot_value = board
            .get("inputSnapshot")
            .ok_or("Board.inputSnapshot fehlt.")?;
        let (_, snapshot_bindings) = validate_snapshot_shape(snapshot_value)?;
        for (binding_id, binding) in snapshot_bindings {
            validate_binding(binding_id, binding)?;
        }
        if canonical_json(&Value::Object(document_bindings.clone()))?
            != canonical_json(&Value::Object(snapshot_bindings.clone()))?
        {
            return Err(
                "Board.inputSnapshot.bindings und ArtboardDocument.bindings stimmen nicht überein."
                    .into(),
            );
        }
        let placement = placements
            .get(id)
            .and_then(Value::as_object)
            .ok_or("Board-Platzierung fehlt.")?;
        known(placement, &["x", "y"], "Board-Platzierung")?;
        for axis in ["x", "y"] {
            let number = placement
                .get(axis)
                .and_then(Value::as_f64)
                .ok_or("Board-Platzierung ist nicht endlich.")?;
            if !number.is_finite() || !(0.0..=1_000_000.0).contains(&number) {
                return Err("Board-Platzierung liegt außerhalb der Grenzen.".into());
            }
        }
    }
    Ok(())
}

fn validate_snapshot_shape(
    snapshot: &Value,
) -> Result<(&str, &serde_json::Map<String, Value>), String> {
    let root = object(snapshot, "InputSnapshot")?;
    known(
        root,
        &["id", "createdAt", "source", "ignoredSignatures", "bindings"],
        "InputSnapshot",
    )?;
    let id = root
        .get("id")
        .and_then(Value::as_str)
        .ok_or("InputSnapshot.id fehlt.")?;
    require_id(id, "InputSnapshot.id")?;
    require_time(
        root.get("createdAt")
            .and_then(Value::as_str)
            .ok_or("InputSnapshot.createdAt fehlt.")?,
    )?;
    if let Some(source) = root.get("source") {
        let source = object(source, "InputSnapshot.source")?;
        known(
            source,
            &["projectId", "nodeId", "signature"],
            "InputSnapshot.source",
        )?;
        for key in ["projectId", "nodeId"] {
            require_id(
                source
                    .get(key)
                    .and_then(Value::as_str)
                    .ok_or("InputSnapshot.source-ID fehlt.")?,
                "InputSnapshot.source-ID",
            )?;
        }
        let signature = source
            .get("signature")
            .and_then(Value::as_str)
            .ok_or("InputSnapshot.source.signature fehlt.")?;
        if signature.is_empty() || signature.len() > 200_000 {
            return Err("InputSnapshot.source.signature ist ungültig.".into());
        }
    }
    if let Some(ignored) = root.get("ignoredSignatures") {
        let ignored = ignored
            .as_array()
            .ok_or("InputSnapshot.ignoredSignatures muss eine Liste sein.")?;
        if ignored.len() > 32 {
            return Err("InputSnapshot.ignoredSignatures enthält zu viele Einträge.".into());
        }
        let mut unique = std::collections::HashSet::new();
        for signature in ignored {
            let signature = signature
                .as_str()
                .ok_or("InputSnapshot.ignoredSignatures enthält keinen Text.")?;
            if signature.is_empty() || signature.len() > 200_000 || !unique.insert(signature) {
                return Err("InputSnapshot.ignoredSignatures ist ungültig.".into());
            }
        }
    }
    let bindings = root
        .get("bindings")
        .and_then(Value::as_object)
        .ok_or("InputSnapshot.bindings fehlt.")?;
    Ok((id, bindings))
}

fn revision_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ArtboardRevision> {
    let workspace: String = row.get(5)?;
    let operations: String = row.get(8)?;
    Ok(ArtboardRevision {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        branch_id: row.get(2)?,
        parent_revision_id: row.get(3)?,
        revision_number: row.get(4)?,
        workspace: serde_json::from_str(&workspace).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(5, rusqlite::types::Type::Text, e.into())
        })?,
        input_snapshot_id: row.get(6)?,
        operation_id: row.get(7)?,
        operations: serde_json::from_str(&operations).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(8, rusqlite::types::Type::Text, e.into())
        })?,
        created_at: row.get(9)?,
    })
}

impl Database {
    /// Persists a complete rendered Artboard selection as a single relational commit.
    /// The byte blobs have already been written to the content-addressed store; this
    /// boundary verifies their exact workspace revision and makes all results visible
    /// together. `operation_id` is payload-bound, so retries cannot create duplicates
    /// or silently reuse an operation for different pixels/boards.
    pub fn record_artboard_composite_batch(
        &self,
        request: RecordArtboardCompositeBatch<'_>,
    ) -> Result<Vec<StoredResult>, String> {
        let result = self.with_connection(|connection| {
            let tx = connection.transaction()?;
            let workspace_raw: String = tx.query_row(
                "SELECT r.workspace_json
                 FROM artboard_workspaces w
                 JOIN artboard_revisions r ON r.workspace_id=w.id
                 JOIN artboard_branches b ON b.id=r.branch_id AND b.head_revision_id=r.id
                 WHERE w.id=?1 AND r.id=?2",
                params![request.workspace_id, request.revision_id],
                |row| row.get(0),
            )?;
            let workspace: Value = serde_json::from_str(&workspace_raw).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    error.into(),
                )
            })?;
            let boards = workspace
                .get("boards")
                .and_then(Value::as_object)
                .ok_or_else(|| rusqlite::Error::InvalidParameterName("ARTBOARD_BOARDS_MISSING".into()))?;
            for item in request.composites {
                let Some(board) = boards.get(&item.board_id) else {
                    return Err(rusqlite::Error::InvalidParameterName(
                        "ARTBOARD_BOARD_MISMATCH".into(),
                    ));
                };
                let width = board.pointer("/document/format/width").and_then(Value::as_u64);
                let height = board.pointer("/document/format/height").and_then(Value::as_u64);
                if width != Some(u64::from(item.width)) || height != Some(u64::from(item.height)) {
                    return Err(rusqlite::Error::InvalidParameterName(
                        "ARTBOARD_COMPOSITE_DIMENSIONS".into(),
                    ));
                }
            }

            let existing = {
                let mut statement = tx.prepare(
                    "SELECT r.id,r.run_id,r.kind,r.blob_hash,r.asset_id,b.media_type,r.created_at,
                            r.parameters_json,EXISTS(SELECT 1 FROM active_results a WHERE a.result_id=r.id)
                     FROM results r JOIN runs u ON u.id=r.run_id LEFT JOIN blobs b ON b.hash=r.blob_hash
                     WHERE u.project_id=?1 AND u.node_id=?2 AND u.model='artboard/composite'
                       AND json_extract(r.parameters_json,'$.operationId')=?3
                     ORDER BY CAST(json_extract(r.parameters_json,'$.selectedIndex') AS INTEGER),
                              json_extract(r.parameters_json,'$.boardId')",
                )?;
                let rows = statement
                    .query_map(
                        params![request.project_id, request.node_id, request.operation_id],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, String>(2)?,
                                row.get::<_, Option<String>>(3)?,
                                row.get::<_, Option<String>>(4)?,
                                row.get::<_, Option<String>>(5)?,
                                row.get::<_, String>(6)?,
                                row.get::<_, Option<String>>(7)?,
                                row.get::<_, bool>(8)?,
                            ))
                        },
                    )?
                    .collect::<Result<Vec<_>, _>>()?;
                rows
            };
            if !existing.is_empty() {
                let valid = existing.len() == request.composites.len()
                    && existing.iter().all(|row| {
                        row.7
                            .as_deref()
                            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                            .and_then(|value| value.get("requestHash").and_then(Value::as_str).map(str::to_owned))
                            .as_deref()
                            == Some(request.request_hash)
                    });
                if !valid {
                    return Err(rusqlite::Error::InvalidParameterName(
                        "IDEMPOTENCY_PAYLOAD_CONFLICT".into(),
                    ));
                }
                let rows = existing
                    .into_iter()
                    .map(|row| StoredResult {
                        result_id: row.0,
                        run_id: row.1,
                        project_id: request.project_id.into(),
                        node_id: request.node_id.into(),
                        kind: row.2,
                        text_value: None,
                        blob_hash: row.3,
                        asset_id: row.4,
                        media_type: row.5,
                        created_at: row.6,
                        cost_microunits: Some(0),
                        model: Some("artboard/composite".into()),
                        prompt: None,
                        parameters: row.7.and_then(|raw| serde_json::from_str(&raw).ok()),
                        active: row.8,
                    })
                    .collect();
                tx.commit()?;
                return Ok(rows);
            }

            let mut stored = Vec::with_capacity(request.composites.len());
            for item in request.composites {
                tx.execute(
                    "INSERT INTO blobs(hash,size_bytes,media_type,created_at,relative_path)
                     VALUES(?1,?2,?3,?4,?5)
                     ON CONFLICT(hash) DO UPDATE SET size_bytes=excluded.size_bytes,
                       media_type=excluded.media_type,relative_path=excluded.relative_path",
                    params![item.blob.hash,item.blob.size_bytes,item.blob.media_type,item.blob.created_at.to_rfc3339(),item.blob.relative_path],
                )?;
                let parameters = serde_json::json!({
                    "artifact": "flowz.artboard-composite",
                    "version": 1,
                    "operationId": request.operation_id,
                    "requestHash": request.request_hash,
                    "workspaceId": request.workspace_id,
                    "revisionId": request.revision_id,
                    "boardId": item.board_id,
                    "width": item.width,
                    "height": item.height,
                    "active": item.active,
                    "selectedIndex": item.selected_index,
                });
                let parameters_json = serde_json::to_string(&parameters)
                    .map_err(|error| rusqlite::Error::ToSqlConversionFailure(error.into()))?;
                tx.execute(
                    "INSERT INTO runs(id,project_id,node_id,provider,model,status,started_at,finished_at,error_code)
                     VALUES(?1,?2,?3,'local','artboard/composite','success',?4,?4,NULL)",
                    params![item.run_id,request.project_id,request.node_id,request.created_at],
                )?;
                tx.execute(
                    "INSERT INTO costs(run_id,currency,amount_microunits,created_at) VALUES(?1,'USD',0,?2)",
                    params![item.run_id,request.created_at],
                )?;
                tx.execute(
                    "INSERT INTO assets(id,project_id,blob_hash,name,kind,metadata_json,created_at)
                     VALUES(?1,?2,?3,?4,'image',?5,?6)",
                    params![item.asset_id,request.project_id,item.blob.hash,item.blob.original_name.as_deref().unwrap_or("Artboard PNG"),parameters_json,request.created_at],
                )?;
                tx.execute(
                    "INSERT INTO results(id,run_id,kind,text_value,blob_hash,asset_id,prompt,parameters_json,created_at)
                     VALUES(?1,?2,'artboard-composite',NULL,?3,?4,NULL,?5,?6)",
                    params![item.result_id,item.run_id,item.blob.hash,item.asset_id,parameters_json,request.created_at],
                )?;
                stored.push(StoredResult {
                    result_id: item.result_id.clone(), run_id: item.run_id.clone(),
                    project_id: request.project_id.into(), node_id: request.node_id.into(),
                    kind: "artboard-composite".into(), text_value: None,
                    blob_hash: Some(item.blob.hash.clone()), asset_id: Some(item.asset_id.clone()),
                    media_type: Some("image/png".into()), created_at: request.created_at.into(),
                    cost_microunits: Some(0), model: Some("artboard/composite".into()),
                    prompt: None, parameters: Some(parameters), active: item.active,
                });
            }
            let active = request.composites.iter().find(|item| item.active).ok_or_else(||
                rusqlite::Error::InvalidParameterName("ARTBOARD_ACTIVE_MISSING".into()))?;
            tx.execute(
                "INSERT INTO active_results(project_id,node_id,result_id) VALUES(?1,?2,?3)
                 ON CONFLICT(project_id,node_id) DO UPDATE SET result_id=excluded.result_id",
                params![request.project_id,request.node_id,active.result_id],
            )?;
            tx.commit()?;
            Ok(stored)
        });
        match result {
            Err(error) if error.contains("Query returned no rows") => Err(
                "Artboard-Workspace und Revision sind nicht mehr der aktuelle verknüpfte Stand."
                    .into(),
            ),
            Err(error) if error.contains("IDEMPOTENCY_PAYLOAD_CONFLICT") => Err(
                "operationId wurde bereits mit einem anderen Artboard-Composite-Payload verwendet."
                    .into(),
            ),
            Err(error) if error.contains("ARTBOARD_BOARD_MISMATCH") => {
                Err("Ein gerendertes Board gehört nicht zur angegebenen Artboard-Revision.".into())
            }
            Err(error) if error.contains("ARTBOARD_COMPOSITE_DIMENSIONS") => Err(
                "Die PNG-Abmessungen stimmen nicht mit dem kanonischen Boardformat der Revision überein.".into(),
            ),
            Err(error) if error.contains("ARTBOARD_BOARDS_MISSING") => {
                Err("Die Artboard-Revision enthält keine gültigen Boards.".into())
            }
            Err(error) => Err(error),
            Ok(rows) => Ok(rows),
        }
    }

    fn artboard_verify_binding_persistence(
        tx: &rusqlite::Transaction<'_>,
        binding: &Value,
    ) -> Result<(), String> {
        let binding = object(binding, "InputBinding")?;
        let source = object(
            binding.get("source").ok_or("InputBinding.source fehlt.")?,
            "InputBinding.source",
        )?;
        let result_id = source
            .get("resultId")
            .and_then(Value::as_str)
            .ok_or("InputBinding.source.resultId fehlt.")?;
        let source_node_id = source
            .get("nodeId")
            .and_then(Value::as_str)
            .ok_or("InputBinding.source.nodeId fehlt.")?;
        let source_project_id = source
            .get("projectId")
            .and_then(Value::as_str)
            .ok_or("InputBinding.source.projectId fehlt.")?;
        let snapshot = object(
            binding
                .get("snapshot")
                .ok_or("InputBinding.snapshot fehlt.")?,
            "InputBinding.snapshot",
        )?;
        match snapshot.get("kind").and_then(Value::as_str) {
            Some("cas") => {
                let expected = snapshot
                    .get("hash")
                    .and_then(Value::as_str)
                    .ok_or("CAS-Hash fehlt.")?;
                let stored:Option<Option<String>>=tx.query_row("SELECT r.blob_hash FROM results r JOIN runs u ON u.id=r.run_id JOIN blobs b ON b.hash=r.blob_hash WHERE r.id=?1 AND u.project_id=?2 AND u.node_id=?3",params![result_id,source_project_id,source_node_id],|row|row.get(0)).optional().map_err(|e|e.to_string())?;
                if stored.flatten().as_deref() != Some(expected) {
                    return Err(format!(
                        "ResultID {result_id}, Node, Projekt und CAS-Hash stimmen nicht überein."
                    ));
                }
            }
            Some("artifact") => {
                let expected = snapshot
                    .get("artifactHash")
                    .and_then(Value::as_str)
                    .ok_or("Artefakt-Hash fehlt.")?;
                let text:Option<Option<String>>=tx.query_row("SELECT r.text_value FROM results r JOIN runs u ON u.id=r.run_id WHERE r.id=?1 AND u.project_id=?2 AND u.node_id=?3",params![result_id,source_project_id,source_node_id],|row|row.get(0)).optional().map_err(|e|e.to_string())?;
                let Some(text) = text.flatten() else {
                    return Err(format!(
                        "Artefakt-ResultID {result_id} gehört nicht zu Workspace-Projekt und Node."
                    ));
                };
                let actual = format!("{:x}", Sha256::digest(text.as_bytes()));
                if actual != expected {
                    return Err(format!(
                        "ResultID {result_id}, Projekt und Artefakt-Hash stimmen nicht überein."
                    ));
                }
            }
            _ => return Err("InputBinding.snapshot.kind ist ungültig.".into()),
        }
        Ok(())
    }
    fn artboard_validate_workspace_persistence(
        tx: &rusqlite::Transaction<'_>,
        workspace_id: &str,
        workspace: &Value,
        request_snapshot: Option<&Value>,
    ) -> Result<(), String> {
        let project_id: Option<String> = tx
            .query_row(
                "SELECT project_id FROM artboard_workspaces WHERE id=?1",
                [workspace_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        let boards = workspace
            .get("boards")
            .and_then(Value::as_object)
            .ok_or("ArtboardWorkspace.boards fehlt.")?;
        let active_id = workspace
            .get("activeBoardId")
            .and_then(Value::as_str)
            .ok_or("activeBoardId fehlt.")?;
        let mut has_bindings = false;
        for board in boards.values() {
            let document = board.get("document").ok_or("Board.document fehlt.")?;
            let bindings = document
                .get("bindings")
                .and_then(Value::as_object)
                .ok_or("ArtboardDocument.bindings fehlt.")?;
            has_bindings |= !bindings.is_empty();
            for binding in bindings.values() {
                Self::artboard_verify_binding_persistence(tx, binding)?
            }
            for layer in document
                .get("layers")
                .and_then(Value::as_object)
                .ok_or("ArtboardDocument.layers fehlt.")?
                .values()
            {
                if layer.get("type").and_then(Value::as_str) == Some("image") {
                    if let Some(hash) = layer.get("casHash").and_then(Value::as_str) {
                        if let Some(version_id) =
                            layer.get("assetVersionId").and_then(Value::as_str)
                        {
                            let exists: bool = tx
                                .query_row(
                                    "SELECT EXISTS(SELECT 1 FROM library_asset_versions v JOIN library_assets a ON a.id=v.asset_id WHERE v.id=?1 AND v.blob_hash=?2 AND a.archived_at IS NULL)",
                                    params![version_id, hash],
                                    |row| row.get(0),
                                )
                                .map_err(|e| e.to_string())?;
                            if !exists {
                                return Err("ImageLayer verweist nicht auf die angegebene unveränderliche Library-Version.".into());
                            }
                            continue;
                        }
                        let project = project_id.as_deref().ok_or(
                            "Ein Workspace ohne Projekt darf keine direkten CAS-Bilder besitzen.",
                        )?;
                        let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM results r JOIN runs u ON u.id=r.run_id JOIN blobs b ON b.hash=r.blob_hash WHERE r.blob_hash=?1 AND u.project_id=?2)",params![hash,project],|row|row.get(0)).map_err(|e|e.to_string())?;
                        if !exists {
                            return Err(
                                "Direktes ImageLayer.casHash gehört nicht zum Workspace-Projekt."
                                    .into(),
                            );
                        }
                    }
                }
            }
        }
        let active_snapshot = boards
            .get(active_id)
            .and_then(|board| board.get("inputSnapshot"))
            .ok_or("Aktiver Board-Snapshot fehlt.")?;
        match request_snapshot {
            Some(snapshot) => {
                if canonical_json(snapshot)? != canonical_json(active_snapshot)? {
                    return Err("Request-InputSnapshot stimmt nicht mit dem aktiven Board-Snapshot überein.".into());
                }
            }
            None if has_bindings => return Err(
                "Ein Workspace mit Bindings muss den aktiven InputSnapshot im Request mitsenden."
                    .into(),
            ),
            None => {}
        }
        Ok(())
    }
    fn artboard_insert_board_revisions(
        tx: &rusqlite::Transaction<'_>,
        workspace_id: &str,
        workspace_revision_id: &str,
        current_branch_id: &str,
        workspace: &Value,
        previous_workspace: Option<&Value>,
        created_at: &str,
    ) -> Result<(), String> {
        let boards = workspace
            .get("boards")
            .and_then(Value::as_object)
            .ok_or("ArtboardWorkspace.boards fehlt.")?;
        for (board_id, board) in boards {
            let board_object = object(board, "Board")?;
            let revision_id = board_object
                .get("activeRevisionId")
                .and_then(Value::as_str)
                .ok_or("Board.activeRevisionId fehlt.")?;
            let ancestry = board_object
                .get("ancestry")
                .and_then(Value::as_object)
                .ok_or("Board.ancestry fehlt.")?;
            let declared_branch = ancestry
                .get("branchId")
                .and_then(Value::as_str)
                .ok_or("Board.ancestry.branchId fehlt.")?;
            let derived_id = ancestry.get("sourceRevisionId").and_then(Value::as_str);
            let derived_board_id = ancestry.get("parentBoardId").and_then(Value::as_str);
            if derived_id.is_some() != derived_board_id.is_some() {
                return Err(
                    "Board-Ableitung braucht gemeinsam parentBoardId und sourceRevisionId.".into(),
                );
            }
            let previous_board = previous_workspace
                .and_then(|value| value.get("boards"))
                .and_then(Value::as_object)
                .and_then(|boards| boards.get(board_id));
            let expected_parent = previous_board
                .and_then(|value| value.get("activeRevisionId"))
                .and_then(Value::as_str)
                .filter(|id| *id != revision_id);
            #[allow(clippy::type_complexity)]
            let existing: Option<(String, String,String,Option<String>,Option<String>,String)> = tx
                .query_row(
                    "SELECT workspace_id,board_id,branch_id,parent_board_revision_id,derived_from_board_revision_id,board_json FROM artboard_board_revisions WHERE id=?1",
                    [revision_id],
                    |row| Ok((row.get(0)?, row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if let Some((
                existing_workspace,
                existing_board,
                existing_branch,
                _existing_parent,
                existing_derived,
                existing_json,
            )) = existing
            {
                let existing_value: Value =
                    serde_json::from_str(&existing_json).map_err(|e| e.to_string())?;
                if existing_workspace != workspace_id
                    || existing_board != *board_id
                    || existing_branch != declared_branch
                    || existing_derived.as_deref() != derived_id
                    || canonical_json(&existing_value)? != canonical_json(board)?
                {
                    return Err(
                        "Immutable Board-Revision wurde mit abweichendem Inhalt oder Lineage wiederverwendet.".into(),
                    );
                }
                continue;
            }
            if declared_branch != current_branch_id {
                return Err(
                    "Neue Board-Revision muss dem aktuellen Workspace-Branch gehören.".into(),
                );
            }
            if let Some(parent) = expected_parent {
                let owner: Option<(String, String)> = tx
                    .query_row(
                        "SELECT workspace_id,board_id FROM artboard_board_revisions WHERE id=?1",
                        [parent],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()
                    .map_err(|e| e.to_string())?;
                if owner
                    .as_ref()
                    .map(|(workspace, board)| (workspace.as_str(), board.as_str()))
                    != Some((workspace_id, board_id.as_str()))
                {
                    return Err("Parent-Board-Revision gehört nicht zur selben Board-Linie.".into());
                }
            }
            if let (Some(derived), Some(source_board)) = (derived_id, derived_board_id) {
                let owner: Option<(String, String)> = tx
                    .query_row(
                        "SELECT workspace_id,board_id FROM artboard_board_revisions WHERE id=?1",
                        [derived],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()
                    .map_err(|e| e.to_string())?;
                if owner
                    .as_ref()
                    .map(|(workspace, board)| (workspace.as_str(), board.as_str()))
                    != Some((workspace_id, source_board))
                {
                    return Err("Abgeleitete Board-Revision gehört nicht zur erwarteten Source-Board-Linie.".into());
                }
            }
            let raw = canonical_json(board)?;
            tx.execute("INSERT INTO artboard_board_revisions(id,workspace_id,workspace_revision_id,board_id,parent_board_revision_id,derived_from_board_revision_id,branch_id,board_json,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![revision_id,workspace_id,workspace_revision_id,board_id,expected_parent,derived_id,current_branch_id,raw,created_at]).map_err(|e|e.to_string())?;
        }
        Ok(())
    }
    fn artboard_verify_and_insert_snapshot(
        tx: &rusqlite::Transaction<'_>,
        workspace_id: &str,
        snapshot: &Value,
        created_at: &str,
    ) -> Result<String, String> {
        let (id, bindings) = validate_snapshot_shape(snapshot)?;
        for (binding_id, binding) in bindings {
            validate_binding(binding_id, binding)?;
            Self::artboard_verify_binding_persistence(tx, binding)?;
        }
        let raw = canonical_json(snapshot)?;
        if let Some((existing_workspace, existing_raw)) = tx
            .query_row(
                "SELECT workspace_id,snapshot_json FROM artboard_input_snapshots WHERE id=?1",
                [id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?
        {
            let existing: Value = serde_json::from_str(&existing_raw).map_err(|e| e.to_string())?;
            if existing_workspace != workspace_id || canonical_json(&existing)? != raw {
                return Err(
                    "InputSnapshot-ID existiert bereits mit anderem Workspace oder Inhalt.".into(),
                );
            }
            return Ok(id.into());
        }
        tx.execute("INSERT INTO artboard_input_snapshots(id,workspace_id,snapshot_json,created_at) VALUES(?1,?2,?3,?4)",params![id,workspace_id,raw,created_at]).map_err(|e|e.to_string())?;
        Ok(id.into())
    }
    pub fn create_artboard_workspace(
        &self,
        request: CreateArtboardWorkspace,
    ) -> Result<ArtboardRevision, String> {
        self.create_artboard_workspace_with_lock_mode(request, false)
    }

    pub(crate) fn catalog_create_artboard_workspace_locked(
        &self,
        request: CreateArtboardWorkspace,
    ) -> Result<ArtboardRevision, String> {
        self.create_artboard_workspace_with_lock_mode(request, true)
    }

    fn create_artboard_workspace_with_lock_mode(
        &self,
        request: CreateArtboardWorkspace,
        reference_lock_held: bool,
    ) -> Result<ArtboardRevision, String> {
        for (id, label) in [
            (&request.workspace_id, "workspaceId"),
            (&request.branch_id, "branchId"),
            (&request.revision_id, "revisionId"),
            (&request.operation_id, "operationId"),
        ] {
            require_id(id, label)?
        }
        require_time(&request.created_at)?;
        validate_workspace(&request.workspace, &request.workspace_id)?;
        let revision_id = request.revision_id.clone();
        let insert = |connection: &mut rusqlite::Connection| {
            let tx = connection.transaction()?;
            tx.execute("INSERT INTO artboard_workspaces(id,project_id,node_id,name,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?5)",params![request.workspace_id,request.project_id,request.node_id,request.name,request.created_at])?;
            tx.execute("INSERT INTO artboard_branches(id,workspace_id,name,head_revision_id,redo_revision_id,fork_revision_id,created_at) VALUES(?1,?2,'Main',NULL,NULL,NULL,?3)",params![request.branch_id,request.workspace_id,request.created_at])?;
            Self::artboard_validate_workspace_persistence(
                &tx,
                &request.workspace_id,
                &request.workspace,
                request.input_snapshot.as_ref(),
            )
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(e.into()))?;
            let snapshot_id = request
                .input_snapshot
                .as_ref()
                .map(|snapshot| {
                    Self::artboard_verify_and_insert_snapshot(
                        &tx,
                        &request.workspace_id,
                        snapshot,
                        &request.created_at,
                    )
                })
                .transpose()
                .map_err(|e| rusqlite::Error::ToSqlConversionFailure(e.into()))?;
            let workspace = canonical_json(&request.workspace)
                .map_err(|e| rusqlite::Error::ToSqlConversionFailure(e.into()))?;
            let request_hash=canonical_hash(&serde_json::json!({"workspaceId":request.workspace_id,"branchId":request.branch_id,"revisionId":request.revision_id,"workspace":request.workspace,"inputSnapshot":request.input_snapshot})).map_err(|e|rusqlite::Error::ToSqlConversionFailure(e.into()))?;
            tx.execute("INSERT INTO artboard_revisions(id,workspace_id,branch_id,parent_revision_id,revision_number,workspace_json,input_snapshot_id,operation_id,request_hash,operations_json,created_at) VALUES(?1,?2,?3,NULL,1,?4,?5,?6,?7,'[]',?8)",params![request.revision_id,request.workspace_id,request.branch_id,workspace,snapshot_id,request.operation_id,request_hash,request.created_at])?;
            Self::artboard_insert_board_revisions(
                &tx,
                &request.workspace_id,
                &request.revision_id,
                &request.branch_id,
                &request.workspace,
                None,
                &request.created_at,
            )
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(e.into()))?;
            tx.execute(
                "UPDATE artboard_branches SET head_revision_id=?1 WHERE id=?2",
                params![request.revision_id, request.branch_id],
            )?;
            tx.commit()?;
            Ok(())
        };
        if reference_lock_held {
            self.with_catalog_connection(insert)?;
        } else {
            self.with_connection(insert)?;
        }
        let revision = if reference_lock_held {
            self.with_catalog_connection(|connection|connection.query_row("SELECT id,workspace_id,branch_id,parent_revision_id,revision_number,workspace_json,input_snapshot_id,operation_id,operations_json,created_at FROM artboard_revisions WHERE id=?1",[&revision_id],revision_from_row).optional())?
        } else {
            self.artboard_revision(&revision_id)?
        };
        revision.ok_or("Angelegte Artboard-Revision fehlt.".into())
    }
    pub fn apply_artboard_operation_batch(
        &self,
        request: ApplyArtboardOperationBatch,
    ) -> Result<ArtboardRevision, String> {
        if request.operations.is_empty() {
            return Err("Eine Artboard-Geste braucht mindestens eine Operation.".into());
        }
        if request.operations.len() > 100 {
            return Err("Eine Artboard-Geste enthält zu viele Operationen.".into());
        }
        for (id, label) in [
            (&request.workspace_id, "workspaceId"),
            (&request.branch_id, "branchId"),
            (&request.revision_id, "revisionId"),
            (&request.operation_id, "operationId"),
            (&request.expected_revision_id, "expectedRevisionId"),
        ] {
            require_id(id, label)?
        }
        require_time(&request.created_at)?;
        validate_workspace(&request.workspace, &request.workspace_id)?;
        let request_hash = apply_request_hash(&request)?;
        let result=self.with_connection(|connection|{
            let tx=connection.transaction()?;
            if let Some((id,stored_hash))=tx.query_row("SELECT id,request_hash FROM artboard_revisions WHERE workspace_id=?1 AND operation_id=?2",params![request.workspace_id,request.operation_id],|row|Ok((row.get::<_,String>(0)?,row.get::<_,Option<String>>(1)?))).optional()?{if stored_hash.as_deref()!=Some(request_hash.as_str()){return Err(rusqlite::Error::InvalidParameterName("IDEMPOTENCY_PAYLOAD_CONFLICT".into()))}tx.commit()?;return Ok(id)}
            let(head,number,previous_raw):(String,i64,String)=tx.query_row("SELECT b.head_revision_id,r.revision_number,r.workspace_json FROM artboard_branches b JOIN artboard_revisions r ON r.id=b.head_revision_id WHERE b.id=?1 AND b.workspace_id=?2",params![request.branch_id,request.workspace_id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?)))?;
            if head!=request.expected_revision_id||number!=request.expected_revision_number{return Err(rusqlite::Error::InvalidParameterName("REVISION_CONFLICT".into()))}
            let previous_workspace:Value=serde_json::from_str(&previous_raw).map_err(|e|rusqlite::Error::FromSqlConversionFailure(2,rusqlite::types::Type::Text,e.into()))?;
            Self::artboard_validate_workspace_persistence(&tx,&request.workspace_id,&request.workspace,request.input_snapshot.as_ref()).map_err(|e|rusqlite::Error::ToSqlConversionFailure(e.into()))?;
            let snapshot_id=request.input_snapshot.as_ref().map(|snapshot|Self::artboard_verify_and_insert_snapshot(&tx,&request.workspace_id,snapshot,&request.created_at)).transpose().map_err(|e|rusqlite::Error::ToSqlConversionFailure(e.into()))?;
            let workspace=canonical_json(&request.workspace).map_err(|e|rusqlite::Error::ToSqlConversionFailure(e.into()))?;let operations=canonical_json(&Value::Array(request.operations.clone())).map_err(|e|rusqlite::Error::ToSqlConversionFailure(e.into()))?;
            tx.execute("INSERT INTO artboard_revisions(id,workspace_id,branch_id,parent_revision_id,revision_number,workspace_json,input_snapshot_id,operation_id,request_hash,operations_json,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",params![request.revision_id,request.workspace_id,request.branch_id,head,number+1,workspace,snapshot_id,request.operation_id,request_hash,operations,request.created_at])?;
            Self::artboard_insert_board_revisions(&tx,&request.workspace_id,&request.revision_id,&request.branch_id,&request.workspace,Some(&previous_workspace),&request.created_at).map_err(|e|rusqlite::Error::ToSqlConversionFailure(e.into()))?;
            tx.execute("DELETE FROM artboard_branch_redo_stack WHERE branch_id=?1",[&request.branch_id])?;
            tx.execute("UPDATE artboard_branches SET head_revision_id=?1,redo_revision_id=NULL WHERE id=?2",params![request.revision_id,request.branch_id])?;
            let workspace_name=request.workspace.get("name").and_then(Value::as_str).ok_or_else(||rusqlite::Error::InvalidParameterName("WORKSPACE_NAME_MISSING".into()))?;
            tx.execute("UPDATE artboard_workspaces SET name=?1,updated_at=?2 WHERE id=?3",params![workspace_name,request.created_at,request.workspace_id])?;tx.commit()?;Ok(request.revision_id.clone())});
        match result {
            Err(error) if error.contains("REVISION_CONFLICT") => Err(
                "Artboard wurde zwischenzeitlich geändert. Bitte den aktuellen Stand laden.".into(),
            ),
            Err(error) if error.contains("IDEMPOTENCY_PAYLOAD_CONFLICT") => {
                Err("operationId wurde bereits mit einem anderen Request-Payload verwendet.".into())
            }
            Err(error) => Err(error),
            Ok(id) => self
                .artboard_revision(&id)?
                .ok_or("Artboard-Revision fehlt.".into()),
        }
    }
    pub fn artboard_revision(&self, id: &str) -> Result<Option<ArtboardRevision>, String> {
        self.with_connection(|connection|connection.query_row("SELECT id,workspace_id,branch_id,parent_revision_id,revision_number,workspace_json,input_snapshot_id,operation_id,operations_json,created_at FROM artboard_revisions WHERE id=?1",[id],revision_from_row).optional())
    }
    pub fn create_artboard_branch(
        &self,
        request: CreateArtboardBranch,
    ) -> Result<ArtboardBranch, String> {
        for (id, label) in [
            (&request.workspace_id, "workspaceId"),
            (&request.branch_id, "branchId"),
            (&request.from_revision_id, "fromRevisionId"),
        ] {
            require_id(id, label)?
        }
        require_time(&request.created_at)?;
        self.with_connection(|connection|{let tx=connection.transaction()?;let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM artboard_revisions WHERE id=?1 AND workspace_id=?2)",params![request.from_revision_id,request.workspace_id],|row|row.get(0))?;if !exists{return Err(rusqlite::Error::QueryReturnedNoRows)}tx.execute("INSERT INTO artboard_branches(id,workspace_id,name,head_revision_id,redo_revision_id,fork_revision_id,created_at) VALUES(?1,?2,?3,?4,NULL,?4,?5)",params![request.branch_id,request.workspace_id,request.name,request.from_revision_id,request.created_at])?;tx.commit()})?;
        Ok(ArtboardBranch {
            id: request.branch_id,
            workspace_id: request.workspace_id,
            name: request.name,
            head_revision_id: request.from_revision_id.clone(),
            redo_revision_id: None,
            fork_revision_id: Some(request.from_revision_id),
            created_at: request.created_at,
        })
    }
    pub fn move_artboard_head(&self, request: MoveArtboardHead) -> Result<ArtboardBranch, String> {
        self.with_connection(|connection|{let tx=connection.transaction()?;let(name,head,created,fork):(String,String,String,Option<String>)=tx.query_row("SELECT name,head_revision_id,created_at,fork_revision_id FROM artboard_branches WHERE id=?1 AND workspace_id=?2",params![request.branch_id,request.workspace_id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)))?;if head!=request.expected_revision_id{return Err(rusqlite::Error::InvalidParameterName("REVISION_CONFLICT".into()))}
            let parent:Option<String>=tx.query_row("SELECT parent_revision_id FROM artboard_revisions WHERE id=?1 AND workspace_id=?2",params![head,request.workspace_id],|row|row.get(0))?;
            let top:Option<(i64,String)>=tx.query_row("SELECT position,revision_id FROM artboard_branch_redo_stack WHERE branch_id=?1 ORDER BY position DESC LIMIT 1",[&request.branch_id],|row|Ok((row.get(0)?,row.get(1)?))).optional()?;
            if head!=fork.clone().unwrap_or_default()&&parent.as_deref()==Some(request.target_revision_id.as_str()){
                let position=top.as_ref().map(|(position,_)|position+1).unwrap_or(0);tx.execute("INSERT INTO artboard_branch_redo_stack(branch_id,position,revision_id) VALUES(?1,?2,?3)",params![request.branch_id,position,head])?;
            }else if top.as_ref().map(|(_,id)|id.as_str())==Some(request.target_revision_id.as_str()){
                let target_parent:Option<String>=tx.query_row("SELECT parent_revision_id FROM artboard_revisions WHERE id=?1 AND workspace_id=?2",params![request.target_revision_id,request.workspace_id],|row|row.get(0))?;if target_parent.as_deref()!=Some(head.as_str()){return Err(rusqlite::Error::InvalidParameterName("INVALID_HEAD_MOVE".into()))}tx.execute("DELETE FROM artboard_branch_redo_stack WHERE branch_id=?1 AND position=?2",params![request.branch_id,top.as_ref().unwrap().0])?;
            }else{return Err(rusqlite::Error::InvalidParameterName("INVALID_HEAD_MOVE".into()))}
            let next_redo:Option<String>=tx.query_row("SELECT revision_id FROM artboard_branch_redo_stack WHERE branch_id=?1 ORDER BY position DESC LIMIT 1",[&request.branch_id],|row|row.get(0)).optional()?;
            tx.execute("UPDATE artboard_branches SET head_revision_id=?1,redo_revision_id=?2 WHERE id=?3",params![request.target_revision_id,next_redo,request.branch_id])?;
            // The Home catalog reads the standalone workspace metadata. Keep it
            // aligned with the visible Main head when undo/redo changes a rename.
            if name == "Main" {
                let target_workspace_raw:String=tx.query_row("SELECT workspace_json FROM artboard_revisions WHERE id=?1 AND workspace_id=?2",params![request.target_revision_id,request.workspace_id],|row|row.get(0))?;
                let target_workspace:Value=serde_json::from_str(&target_workspace_raw).map_err(|e|rusqlite::Error::FromSqlConversionFailure(0,rusqlite::types::Type::Text,e.into()))?;
                let target_name=target_workspace.get("name").and_then(Value::as_str).ok_or_else(||rusqlite::Error::InvalidParameterName("WORKSPACE_NAME_MISSING".into()))?;
                tx.execute("UPDATE artboard_workspaces SET name=?1,updated_at=?2 WHERE id=?3",params![target_name,Utc::now().to_rfc3339(),request.workspace_id])?;
            }
            tx.commit()?;Ok(ArtboardBranch{id:request.branch_id,workspace_id:request.workspace_id,name,head_revision_id:request.target_revision_id,redo_revision_id:next_redo,fork_revision_id:fork,created_at:created})}).map_err(|error|if error.contains("REVISION_CONFLICT"){"Artboard wurde zwischenzeitlich geändert. Bitte den aktuellen Stand laden.".into()}else if error.contains("INVALID_HEAD_MOVE"){"Artboard-Head darf nur entlang der direkten Undo-/Redo-Kette bewegt werden.".into()}else{error})
    }
    pub fn register_artboard_input_snapshot(
        &self,
        request: RegisterArtboardInputSnapshot,
    ) -> Result<String, String> {
        require_time(&request.created_at)?;
        self.with_connection(|connection| {
            let tx = connection.transaction()?;
            let id = Self::artboard_verify_and_insert_snapshot(
                &tx,
                &request.workspace_id,
                &request.snapshot,
                &request.created_at,
            )
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(e.into()))?;
            tx.commit()?;
            Ok(id)
        })
    }
    pub fn open_artboard_workspace(
        &self,
        id: &str,
    ) -> Result<Option<ArtboardWorkspaceRecord>, String> {
        self.with_connection(|connection|{let base=connection.query_row("SELECT id,project_id,node_id,name,created_at,updated_at FROM artboard_workspaces WHERE id=?1",[id],|row|Ok((row.get::<_,String>(0)?,row.get::<_,Option<String>>(1)?,row.get::<_,Option<String>>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?,row.get::<_,String>(5)?))).optional()?;let Some(base)=base else{return Ok(None)};let mut statement=connection.prepare("SELECT id,workspace_id,name,head_revision_id,redo_revision_id,fork_revision_id,created_at FROM artboard_branches WHERE workspace_id=?1 ORDER BY created_at,id")?;let branches=statement.query_map([id],|row|Ok(ArtboardBranch{id:row.get(0)?,workspace_id:row.get(1)?,name:row.get(2)?,head_revision_id:row.get(3)?,redo_revision_id:row.get(4)?,fork_revision_id:row.get(5)?,created_at:row.get(6)?}))?.collect::<Result<Vec<_>,_>>()?;Ok(Some(ArtboardWorkspaceRecord{id:base.0,project_id:base.1,node_id:base.2,name:base.3,created_at:base.4,updated_at:base.5,branches}))})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use rusqlite::params;
    use serde_json::json;

    fn workspace(id: &str, revision: &str) -> Value {
        json!({"schemaVersion":1,"id":id,"name":"Kampagne","boards":{"board-1":{"id":"board-1","name":"Post","activeRevisionId":revision,"document":{"schemaVersion":1,"id":"document-1","name":"Post","format":{"preset":"instagram-post","width":1080,"height":1080},"paint":{"kind":"solid","color":"#111111"},"rootLayerIds":[],"layers":{},"bindings":{},"tokenRefs":{}},"inputSnapshot":{"id":"snapshot-empty","createdAt":"2026-07-12T10:00:00Z","bindings":{}},"ancestry":{"branchId":"branch-main"},"createdAt":"2026-07-12T10:00:00Z"}},"placements":{"board-1":{"x":64,"y":64}},"selectedBoardIds":[],"activeBoardId":"board-1","pasteboard":{"margin":64,"gap":64,"grid":8}})
    }
    fn create(database: &Database) -> ArtboardRevision {
        database
            .create_artboard_workspace(CreateArtboardWorkspace {
                workspace_id: "workspace-1".into(),
                project_id: None,
                node_id: None,
                name: "Kampagne".into(),
                branch_id: "branch-main".into(),
                revision_id: "revision-1".into(),
                operation_id: "operation-create".into(),
                workspace: workspace("workspace-1", "revision-1"),
                input_snapshot: None,
                created_at: "2026-07-12T10:00:00Z".into(),
            })
            .unwrap()
    }
    fn composite(board_id: &str, suffix: &str) -> ArtboardCompositeCommit {
        let hash = if suffix == "a" {
            "a".repeat(64)
        } else {
            "b".repeat(64)
        };
        ArtboardCompositeCommit {
            board_id: board_id.into(),
            active: true,
            selected_index: Some(0),
            width: 1080,
            height: 1080,
            run_id: format!("run-{suffix}"),
            result_id: format!("result-{suffix}"),
            asset_id: format!("asset-{suffix}"),
            blob: BlobMetadata {
                hash: hash.clone(),
                size_bytes: 80,
                media_type: "image/png".into(),
                original_name: Some("Artboard.png".into()),
                created_at: Utc.timestamp_opt(1_783_849_600, 0).unwrap(),
                relative_path: format!("{}/{}", &hash[..2], hash),
            },
        }
    }
    #[test]
    fn composite_batch_is_revision_bound_atomic_and_payload_idempotent() {
        let temp = tempfile::tempdir().unwrap();
        let database = Database::new(temp.path().join("flowz.sqlite3")).unwrap();
        create(&database);
        database.with_connection(|connection| {
            connection.execute("INSERT INTO projects(id,name,project_path,schema_version,created_at,updated_at) VALUES('project','P','p',1,'now','now')", [])?;
            Ok(())
        }).unwrap();
        let first = composite("board-1", "a");
        let original_hash = "c".repeat(64);
        let request = || RecordArtboardCompositeBatch {
            operation_id: "composite-operation",
            request_hash: &original_hash,
            project_id: "project",
            node_id: "node",
            workspace_id: "workspace-1",
            revision_id: "revision-1",
            created_at: "2026-07-12T10:10:00Z",
            composites: std::slice::from_ref(&first),
        };
        let stored = database.record_artboard_composite_batch(request()).unwrap();
        assert_eq!(
            stored[0].blob_hash.as_deref(),
            Some(first.blob.hash.as_str())
        );
        assert!(stored[0].active);
        let retry = database.record_artboard_composite_batch(request()).unwrap();
        assert_eq!(retry[0].result_id, stored[0].result_id);
        let counts: (i64, i64, i64) = database.with_connection(|connection| Ok((
            connection.query_row("SELECT COUNT(*) FROM runs WHERE model='artboard/composite'", [], |row| row.get(0))?,
            connection.query_row("SELECT COUNT(*) FROM results WHERE kind='artboard-composite'", [], |row| row.get(0))?,
            connection.query_row("SELECT COUNT(*) FROM active_results WHERE project_id='project' AND node_id='node' AND result_id='result-a'", [], |row| row.get(0))?,
        ))).unwrap();
        assert_eq!(counts, (1, 1, 1));

        let changed_hash = "d".repeat(64);
        let conflict = database
            .record_artboard_composite_batch(RecordArtboardCompositeBatch {
                request_hash: &changed_hash,
                ..request()
            })
            .unwrap_err();
        assert!(conflict.contains("operationId"));

        let mut wrong_size = first.clone();
        wrong_size.width = 1079;
        let size_hash = "f".repeat(64);
        let size_error = database
            .record_artboard_composite_batch(RecordArtboardCompositeBatch {
                operation_id: "wrong-size-operation",
                request_hash: &size_hash,
                composites: &[wrong_size],
                ..request()
            })
            .unwrap_err();
        assert!(size_error.contains("kanonischen Boardformat"));

        let missing = composite("missing-board", "b");
        let invalid_hash = "e".repeat(64);
        let invalid = database
            .record_artboard_composite_batch(RecordArtboardCompositeBatch {
                operation_id: "another-operation",
                request_hash: &invalid_hash,
                composites: &[first.clone(), missing],
                ..request()
            })
            .unwrap_err();
        assert!(invalid.contains("Revision"));
        let count: i64 = database.with_connection(|connection| connection.query_row(
            "SELECT COUNT(*) FROM results WHERE json_extract(parameters_json,'$.operationId')='another-operation'",
            [], |row| row.get(0),
        )).unwrap();
        assert_eq!(count, 0);

        database
            .apply_artboard_operation_batch(ApplyArtboardOperationBatch {
                workspace_id: "workspace-1".into(),
                branch_id: "branch-main".into(),
                revision_id: "revision-2".into(),
                operation_id: "advance-head".into(),
                expected_revision_id: "revision-1".into(),
                expected_revision_number: 1,
                operations: vec![json!({"type":"board.rename"})],
                workspace: workspace("workspace-1", "revision-2"),
                input_snapshot: None,
                created_at: "2026-07-12T10:11:00Z".into(),
            })
            .unwrap();
        let stale = composite("board-1", "b");
        let stale_hash = "1".repeat(64);
        let stale_error = database
            .record_artboard_composite_batch(RecordArtboardCompositeBatch {
                operation_id: "stale-render",
                request_hash: &stale_hash,
                revision_id: "revision-1",
                composites: &[stale],
                ..request()
            })
            .unwrap_err();
        assert!(stale_error.contains("nicht mehr der aktuelle"));
    }
    #[test]
    fn revisions_are_atomic_idempotent_and_survive_restart() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("flowz.sqlite3");
        let database = Database::new(path.clone()).unwrap();
        create(&database);
        let request = ApplyArtboardOperationBatch {
            workspace_id: "workspace-1".into(),
            branch_id: "branch-main".into(),
            revision_id: "revision-2".into(),
            operation_id: "operation-move".into(),
            expected_revision_id: "revision-1".into(),
            expected_revision_number: 1,
            operations: vec![json!({"type":"board.move","boardId":"board-1","x":80,"y":80})],
            workspace: workspace("workspace-1", "revision-2"),
            input_snapshot: None,
            created_at: "2026-07-12T10:01:00Z".into(),
        };
        let first = database
            .apply_artboard_operation_batch(request.clone())
            .unwrap();
        let second = database.apply_artboard_operation_batch(request).unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(first.revision_number, 2);
        let (board_revisions,first_still_present):(i64,bool)=database.with_connection(|connection|Ok((connection.query_row("SELECT COUNT(*) FROM artboard_board_revisions WHERE board_id='board-1'",[],|row|row.get(0))?,connection.query_row("SELECT EXISTS(SELECT 1 FROM artboard_board_revisions WHERE id='revision-1')",[],|row|row.get(0))?))).unwrap();
        assert_eq!(board_revisions, 2);
        assert!(first_still_present);
        drop(database);
        let reopened = Database::new(path).unwrap();
        assert_eq!(
            reopened
                .open_artboard_workspace("workspace-1")
                .unwrap()
                .unwrap()
                .branches[0]
                .head_revision_id,
            "revision-2"
        );
    }
    #[test]
    fn operation_id_is_bound_to_the_complete_canonical_payload() {
        let temp = tempfile::tempdir().unwrap();
        let database = Database::new(temp.path().join("flowz.sqlite3")).unwrap();
        create(&database);
        let request = ApplyArtboardOperationBatch {
            workspace_id: "workspace-1".into(),
            branch_id: "branch-main".into(),
            revision_id: "revision-2".into(),
            operation_id: "operation-fixed".into(),
            expected_revision_id: "revision-1".into(),
            expected_revision_number: 1,
            operations: vec![json!({"type":"board.move","x":80})],
            workspace: workspace("workspace-1", "revision-2"),
            input_snapshot: None,
            created_at: "2026-07-12T10:01:00Z".into(),
        };
        database
            .apply_artboard_operation_batch(request.clone())
            .unwrap();
        let mut operation_conflict = request.clone();
        operation_conflict.operations = json!([{"type":"board.move","x":96}])
            .as_array()
            .unwrap()
            .clone();
        assert!(database
            .apply_artboard_operation_batch(operation_conflict)
            .unwrap_err()
            .contains("operationId"));
        let mut workspace_conflict = request.clone();
        workspace_conflict.workspace["name"] = json!("Anderer Payload");
        assert!(database
            .apply_artboard_operation_batch(workspace_conflict)
            .unwrap_err()
            .contains("operationId"));
        let mut branch_conflict = request.clone();
        branch_conflict.branch_id = "branch-other".into();
        assert!(database
            .apply_artboard_operation_batch(branch_conflict)
            .unwrap_err()
            .contains("operationId"));
        let mut revision_conflict = request.clone();
        revision_conflict.revision_id = "revision-other".into();
        assert!(database
            .apply_artboard_operation_batch(revision_conflict)
            .unwrap_err()
            .contains("operationId"));
        let mut expected_conflict = request;
        expected_conflict.expected_revision_number = 9;
        assert!(database
            .apply_artboard_operation_batch(expected_conflict)
            .unwrap_err()
            .contains("operationId"));
    }
    #[test]
    fn immutable_board_revision_rejects_changed_payload_and_cross_board_derivation() {
        let temp = tempfile::tempdir().unwrap();
        let database = Database::new(temp.path().join("flowz.sqlite3")).unwrap();
        create(&database);
        let mut reused = workspace("workspace-1", "revision-1");
        reused["boards"]["board-1"]["name"] = json!("Manipuliert");
        let error = database
            .apply_artboard_operation_batch(ApplyArtboardOperationBatch {
                workspace_id: "workspace-1".into(),
                branch_id: "branch-main".into(),
                revision_id: "workspace-revision-2".into(),
                operation_id: "operation-reuse".into(),
                expected_revision_id: "revision-1".into(),
                expected_revision_number: 1,
                operations: vec![json!({"type":"board.rename"})],
                workspace: reused,
                input_snapshot: None,
                created_at: "2026-07-12T10:01:00Z".into(),
            })
            .unwrap_err();
        assert!(error.contains("Immutable Board-Revision"));
        let mut derived = workspace("workspace-1", "revision-1");
        let mut second = derived["boards"]["board-1"].clone();
        second["id"] = json!("board-2");
        second["activeRevisionId"] = json!("board-2-revision-1");
        second["document"]["id"] = json!("document-2");
        second["ancestry"] = json!({"branchId":"branch-main","parentBoardId":"board-2","sourceRevisionId":"revision-1"});
        derived["boards"]["board-2"] = second;
        derived["placements"]["board-2"] = json!({"x":1208,"y":64});
        derived["activeBoardId"] = json!("board-2");
        let error = database
            .apply_artboard_operation_batch(ApplyArtboardOperationBatch {
                workspace_id: "workspace-1".into(),
                branch_id: "branch-main".into(),
                revision_id: "workspace-revision-2b".into(),
                operation_id: "operation-derived".into(),
                expected_revision_id: "revision-1".into(),
                expected_revision_number: 1,
                operations: vec![json!({"type":"board.duplicate"})],
                workspace: derived,
                input_snapshot: None,
                created_at: "2026-07-12T10:02:00Z".into(),
            })
            .unwrap_err();
        assert!(error.contains("Source-Board-Linie"));
    }
    #[test]
    fn rejects_stale_precondition_and_supports_branch_and_undo() {
        let temp = tempfile::tempdir().unwrap();
        let database = Database::new(temp.path().join("flowz.sqlite3")).unwrap();
        create(&database);
        let stale = database.apply_artboard_operation_batch(ApplyArtboardOperationBatch {
            workspace_id: "workspace-1".into(),
            branch_id: "branch-main".into(),
            revision_id: "revision-stale".into(),
            operation_id: "operation-stale".into(),
            expected_revision_id: "revision-wrong".into(),
            expected_revision_number: 1,
            operations: vec![json!({"type":"selection.set"})],
            workspace: workspace("workspace-1", "revision-stale"),
            input_snapshot: None,
            created_at: "2026-07-12T10:01:00Z".into(),
        });
        assert!(stale.unwrap_err().contains("zwischenzeitlich"));
        let branch = database
            .create_artboard_branch(CreateArtboardBranch {
                workspace_id: "workspace-1".into(),
                branch_id: "branch-option".into(),
                name: "Option".into(),
                from_revision_id: "revision-1".into(),
                created_at: "2026-07-12T10:02:00Z".into(),
            })
            .unwrap();
        assert_eq!(branch.head_revision_id, "revision-1");
        let mut option_workspace = workspace("workspace-1", "board-option-1");
        option_workspace["boards"]["board-1"]["ancestry"]["branchId"] = json!("branch-option");
        let option_revision = database
            .apply_artboard_operation_batch(ApplyArtboardOperationBatch {
                workspace_id: "workspace-1".into(),
                branch_id: "branch-option".into(),
                revision_id: "revision-option-1".into(),
                operation_id: "operation-option-1".into(),
                expected_revision_id: "revision-1".into(),
                expected_revision_number: 1,
                operations: vec![json!({"type":"board.update"})],
                workspace: option_workspace,
                input_snapshot: None,
                created_at: "2026-07-12T10:03:00Z".into(),
            })
            .unwrap();
        let moved = database
            .move_artboard_head(MoveArtboardHead {
                workspace_id: "workspace-1".into(),
                branch_id: "branch-option".into(),
                expected_revision_id: option_revision.id.clone(),
                target_revision_id: "revision-1".into(),
            })
            .unwrap();
        assert_eq!(
            moved.redo_revision_id.as_deref(),
            Some(option_revision.id.as_str())
        );
        let redone = database
            .move_artboard_head(MoveArtboardHead {
                workspace_id: "workspace-1".into(),
                branch_id: "branch-option".into(),
                expected_revision_id: "revision-1".into(),
                target_revision_id: option_revision.id.clone(),
            })
            .unwrap();
        assert_eq!(redone.head_revision_id, option_revision.id);
    }

    #[test]
    fn main_head_undo_keeps_workspace_catalog_name_in_sync() {
        let temp = tempfile::tempdir().unwrap();
        let database = Database::new(temp.path().join("flowz.sqlite3")).unwrap();
        create(&database);
        let mut renamed = workspace("workspace-1", "revision-1");
        renamed["name"] = json!("Renamed");
        let revision = database
            .apply_artboard_operation_batch(ApplyArtboardOperationBatch {
                workspace_id: "workspace-1".into(),
                branch_id: "branch-main".into(),
                revision_id: "revision-2".into(),
                operation_id: "operation-rename".into(),
                expected_revision_id: "revision-1".into(),
                expected_revision_number: 1,
                operations: vec![json!({"type":"rename-workspace","name":"Renamed"})],
                workspace: renamed,
                input_snapshot: None,
                created_at: "2026-07-12T10:04:00Z".into(),
            })
            .unwrap();
        assert_eq!(
            database
                .open_artboard_workspace("workspace-1")
                .unwrap()
                .unwrap()
                .name,
            "Renamed"
        );
        database
            .move_artboard_head(MoveArtboardHead {
                workspace_id: "workspace-1".into(),
                branch_id: "branch-main".into(),
                expected_revision_id: revision.id,
                target_revision_id: "revision-1".into(),
            })
            .unwrap();
        assert_eq!(
            database
                .open_artboard_workspace("workspace-1")
                .unwrap()
                .unwrap()
                .name,
            "Kampagne"
        );
    }
    #[test]
    fn input_snapshot_requires_matching_result_and_hash() {
        let temp = tempfile::tempdir().unwrap();
        let database = Database::new(temp.path().join("flowz.sqlite3")).unwrap();
        let hash = "a".repeat(64);
        database.with_connection(|connection|{connection.execute("INSERT INTO projects(id,name,project_path,schema_version,created_at,updated_at) VALUES('project','P','p',1,'now','now')",[])?;connection.execute("INSERT INTO runs(id,project_id,node_id,status,started_at) VALUES('run','project','node','success','now')",[])?;connection.execute("INSERT INTO blobs(hash,size_bytes,media_type,relative_path,created_at) VALUES(?1,1,'image/png','x','now')",[&hash])?;connection.execute("INSERT INTO results(id,run_id,kind,blob_hash,created_at) VALUES('result','run','image',?1,'now')",params![hash])?;Ok(())}).unwrap();
        database
            .create_artboard_workspace(CreateArtboardWorkspace {
                workspace_id: "workspace-1".into(),
                // Standalone Artboards intentionally have no owning project;
                // every binding carries and verifies its own source project.
                project_id: None,
                node_id: None,
                name: "Kampagne".into(),
                branch_id: "branch-main".into(),
                revision_id: "revision-1".into(),
                operation_id: "operation-create".into(),
                workspace: workspace("workspace-1", "revision-1"),
                input_snapshot: None,
                created_at: "2026-07-12T10:00:00Z".into(),
            })
            .unwrap();
        let snapshot = json!({"id":"snapshot-1","createdAt":"2026-07-12T10:03:00Z","bindings":{"image-1":{"id":"image-1","source":{"projectId":"project","nodeId":"node","portId":"image","resultId":"result"},"snapshot":{"kind":"cas","hash":hash},"mode":"pinned"}}});
        assert_eq!(
            database
                .register_artboard_input_snapshot(RegisterArtboardInputSnapshot {
                    workspace_id: "workspace-1".into(),
                    snapshot: snapshot.clone(),
                    created_at: "2026-07-12T10:03:00Z".into()
                })
                .unwrap(),
            "snapshot-1"
        );
        let bad = json!({"id":"snapshot-2","createdAt":"2026-07-12T10:04:00Z","bindings":{"image-1":{"id":"image-1","source":{"projectId":"project","nodeId":"node","portId":"image","resultId":"result"},"snapshot":{"kind":"cas","hash":"b".repeat(64)},"mode":"pinned"}}});
        assert!(database
            .register_artboard_input_snapshot(RegisterArtboardInputSnapshot {
                workspace_id: "workspace-1".into(),
                snapshot: bad,
                created_at: "2026-07-12T10:04:00Z".into()
            })
            .unwrap_err()
            .contains("stimmen nicht überein"));
        let mut collision = snapshot.clone();
        collision["bindings"]["image-1"]["mode"] = json!("live");
        assert!(database
            .register_artboard_input_snapshot(RegisterArtboardInputSnapshot {
                workspace_id: "workspace-1".into(),
                snapshot: collision,
                created_at: "2026-07-12T10:05:00Z".into()
            })
            .unwrap_err()
            .contains("existiert bereits"));
        let mut second_workspace = workspace("workspace-2", "revision-second");
        second_workspace["boards"]["board-1"]["ancestry"]["branchId"] = json!("branch-second");
        database
            .create_artboard_workspace(CreateArtboardWorkspace {
                workspace_id: "workspace-2".into(),
                project_id: Some("project".into()),
                node_id: None,
                name: "Zweite".into(),
                branch_id: "branch-second".into(),
                revision_id: "revision-second".into(),
                operation_id: "operation-second".into(),
                workspace: second_workspace,
                input_snapshot: None,
                created_at: "2026-07-12T10:05:00Z".into(),
            })
            .unwrap();
        assert!(database
            .register_artboard_input_snapshot(RegisterArtboardInputSnapshot {
                workspace_id: "workspace-2".into(),
                snapshot: snapshot.clone(),
                created_at: "2026-07-12T10:05:00Z".into()
            })
            .unwrap_err()
            .contains("anderem Workspace"));
        let mut mismatch = workspace("workspace-1", "revision-2");
        mismatch["boards"]["board-1"]["document"]["bindings"] = snapshot["bindings"].clone();
        assert!(validate_workspace(&mismatch, "workspace-1")
            .unwrap_err()
            .contains("stimmen nicht überein"));
        mismatch["boards"]["board-1"]["inputSnapshot"] = snapshot.clone();
        let omitted = database
            .apply_artboard_operation_batch(ApplyArtboardOperationBatch {
                workspace_id: "workspace-1".into(),
                branch_id: "branch-main".into(),
                revision_id: "revision-2".into(),
                operation_id: "operation-bound".into(),
                expected_revision_id: "revision-1".into(),
                expected_revision_number: 1,
                operations: vec![json!({"type":"board.bind"})],
                workspace: mismatch.clone(),
                input_snapshot: None,
                created_at: "2026-07-12T10:06:00Z".into(),
            })
            .unwrap_err();
        assert!(omitted.contains("InputSnapshot"));
        let mut wrong_request = snapshot.clone();
        wrong_request["id"] = json!("snapshot-other");
        let error = database
            .apply_artboard_operation_batch(ApplyArtboardOperationBatch {
                workspace_id: "workspace-1".into(),
                branch_id: "branch-main".into(),
                revision_id: "revision-2b".into(),
                operation_id: "operation-bound-2".into(),
                expected_revision_id: "revision-1".into(),
                expected_revision_number: 1,
                operations: vec![json!({"type":"board.bind"})],
                workspace: mismatch,
                input_snapshot: Some(wrong_request),
                created_at: "2026-07-12T10:07:00Z".into(),
            })
            .unwrap_err();
        assert!(error.contains("aktiven Board-Snapshot"));
        database.with_connection(|connection|{connection.execute("INSERT INTO runs(id,project_id,node_id,status,started_at) VALUES('artifact-run','project','node','success','now')",[])?;connection.execute("INSERT INTO results(id,run_id,kind,text_value,created_at) VALUES('artifact-result','artifact-run','text','{\"ok\":true}','now')",[])?;Ok(())}).unwrap();
        let artifact = json!({"id":"snapshot-artifact","createdAt":"2026-07-12T10:08:00Z","bindings":{"artifact-1":{"id":"artifact-1","source":{"projectId":"project","nodeId":"node","portId":"artifact","resultId":"artifact-result"},"snapshot":{"kind":"artifact","artifactType":"flowz.palette","artifactHash":"c".repeat(64)},"mode":"pinned"}}});
        assert!(database
            .register_artboard_input_snapshot(RegisterArtboardInputSnapshot {
                workspace_id: "workspace-1".into(),
                snapshot: artifact,
                created_at: "2026-07-12T10:08:00Z".into()
            })
            .unwrap_err()
            .contains("Artefakt-Hash"));
        let foreign_hash = "d".repeat(64);
        database.with_connection(|connection|{connection.execute("INSERT INTO projects(id,name,project_path,schema_version,created_at,updated_at) VALUES('other','O','o',1,'now','now')",[])?;connection.execute("INSERT INTO runs(id,project_id,node_id,status,started_at) VALUES('other-run','other','other-node','success','now')",[])?;connection.execute("INSERT INTO blobs(hash,size_bytes,media_type,relative_path,created_at) VALUES(?1,1,'image/png','d','now')",[&foreign_hash])?;connection.execute("INSERT INTO results(id,run_id,kind,blob_hash,created_at) VALUES('other-result','other-run','image',?1,'now')",[&foreign_hash])?;Ok(())}).unwrap();
        let mut direct = workspace("workspace-1", "revision-direct");
        direct["boards"]["board-1"]["document"]["rootLayerIds"] = json!(["image-1"]);
        direct["boards"]["board-1"]["document"]["layers"] = json!({"image-1":{"id":"image-1","type":"image","name":"Bild","locked":false,"visible":true,"version":1,"geometry":{"x":0,"y":0,"width":100,"height":100,"rotation":0},"casHash":foreign_hash,"fit":"cover"}});
        let error = database
            .apply_artboard_operation_batch(ApplyArtboardOperationBatch {
                workspace_id: "workspace-1".into(),
                branch_id: "branch-main".into(),
                revision_id: "revision-direct-workspace".into(),
                operation_id: "operation-direct".into(),
                expected_revision_id: "revision-1".into(),
                expected_revision_number: 1,
                operations: vec![json!({"type":"board.image"})],
                workspace: direct,
                input_snapshot: None,
                created_at: "2026-07-12T10:09:00Z".into(),
            })
            .unwrap_err();
        assert!(error.contains("Projekt"));
    }
    #[test]
    fn native_validation_rejects_unknown_fields_urls_and_out_of_bounds_layers() {
        let temp = tempfile::tempdir().unwrap();
        let database = Database::new(temp.path().join("flowz.sqlite3")).unwrap();
        let mut invalid = workspace("workspace-1", "revision-1");
        let document = invalid
            .pointer_mut("/boards/board-1/document")
            .unwrap()
            .as_object_mut()
            .unwrap();
        document.insert("html".into(), json!("<main>legacy</main>"));
        let request = CreateArtboardWorkspace {
            workspace_id: "workspace-1".into(),
            project_id: None,
            node_id: None,
            name: "Kampagne".into(),
            branch_id: "branch-main".into(),
            revision_id: "revision-1".into(),
            operation_id: "operation-create".into(),
            workspace: invalid,
            input_snapshot: None,
            created_at: "2026-07-12T10:00:00Z".into(),
        };
        assert!(database
            .create_artboard_workspace(request)
            .unwrap_err()
            .contains("unbekannte Feld"));
        let base = workspace("workspace-2", "revision-1");
        let clean = base.pointer("/boards/board-1/document").unwrap();
        let mut with_url = clean.clone();
        with_url["rootLayerIds"] = json!(["text-1"]);
        with_url["layers"] = json!({"text-1":{"id":"text-1","type":"text","name":"Titel","locked":false,"visible":true,"version":1,"geometry":{"x":0,"y":0,"width":100,"height":100,"rotation":0},"text":"https://evil.test","color":"#FFFFFF","fontSize":24,"align":"left"}});
        assert!(validate_document(&with_url)
            .unwrap_err()
            .contains("URL, CSS oder Code"));
        with_url["layers"]["text-1"]["text"] = json!("Sicherer Text");
        with_url["layers"]["text-1"]["geometry"]["x"] = json!(1070);
        with_url["layers"]["text-1"]["geometry"]["width"] = json!(100);
        assert!(validate_document(&with_url)
            .unwrap_err()
            .contains("außerhalb"));
        let mut current = workspace("workspace-font", "revision-font");
        current["boards"]["board-1"]["inputSnapshot"]["source"] =
            json!({"projectId":"flow-1","nodeId":"artboard-node","signature":"snapshot-v2"});
        current["boards"]["board-1"]["inputSnapshot"]["ignoredSignatures"] = json!(["snapshot-v1"]);
        current["boards"]["board-1"]["document"]["rootLayerIds"] = json!(["text-font"]);
        current["boards"]["board-1"]["document"]["layers"] = json!({"text-font":{"id":"text-font","type":"text","name":"Titel","locked":false,"visible":true,"version":1,"geometry":{"x":0,"y":0,"width":300,"height":100,"rotation":12},"text":"FlowZ","color":"#111111","fontRef":"font-a","fontFamily":"Inter","fontHash":"a".repeat(64),"fontWeight":500,"fontStyle":"normal","fontAxes":{"wght":500},"fontSize":32,"align":"left"}});
        assert!(validate_workspace(&current, "workspace-font").is_ok());
        let mut layout = workspace("workspace-layout", "revision-layout");
        layout["boards"]["board-1"]["document"]["paint"] = json!({"kind":"linear-gradient","angle":90,"stops":[{"color":"#111111","offset":0},{"color":"#222222","offset":1}]});
        layout["boards"]["board-1"]["document"]["rootLayerIds"] = json!(["layout-1"]);
        layout["boards"]["board-1"]["document"]["layers"] = json!({
            "layout-1":{"id":"layout-1","type":"container","name":"Layout","locked":false,"visible":true,"version":1,"geometry":{"x":100,"y":100,"width":800,"height":400,"rotation":0},"childIds":["card-1"],"layout":{"mode":"flex","direction":"row","gap":16,"padding":24,"justify":"start","align":"stretch"},"fill":{"kind":"linear-gradient","angle":135,"stops":[{"color":"#EE3399","offset":0},{"color":"#5533EE","offset":1}]},"style":{"opacity":0.9,"border":{"width":2,"color":"#FFFFFF"},"borderRadius":20,"shadow":{"x":0,"y":12,"blur":24,"color":"#000000","opacity":0.4}}},
            "card-1":{"id":"card-1","type":"shape","name":"Card","locked":false,"visible":true,"version":1,"geometry":{"x":0,"y":0,"width":200,"height":100,"rotation":0},"shape":"rectangle","fill":{"kind":"solid","color":"#111111"}}
        });
        assert!(validate_workspace(&layout, "workspace-layout").is_ok());
        layout["boards"]["board-1"]["document"]["layers"]["layout-1"]["style"]["externalCss"] =
            json!("https://evil.test/style.css");
        assert!(validate_workspace(&layout, "workspace-layout")
            .unwrap_err()
            .contains("unbekannte Feld"));
    }
}
