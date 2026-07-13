use crate::persistence::{Persistence, StoredResult};
use serde_json::Value;
use std::collections::HashMap;

const CONFIG_OWNED_SOURCES: &[&str] = &[
    "core.text-input",
    "core.image-input",
    "core.video-input",
    "core.audio-input",
    "library.asset-text",
    "library.asset-image",
    "brand.brief",
    "brand.artboard",
];

fn primary_result_value(result: &StoredResult) -> Option<Value> {
    result
        .blob_hash
        .as_ref()
        .map(|hash| Value::String(format!("flowz-cas:{hash}")))
        .or_else(|| result.text_value.clone().map(Value::String))
}

fn brand_output_value(result: &StoredResult, port: &str) -> Option<Value> {
    result
        .parameters
        .as_ref()?
        .get("brandOutputPorts")?
        .get("values")?
        .get(port)
        .cloned()
}

fn parameter_hash(result: &StoredResult, key: &str) -> Option<Value> {
    result
        .parameters
        .as_ref()?
        .get(key)?
        .as_str()
        .map(|hash| Value::String(format!("flowz-cas:{hash}")))
}

/// Resolves one immutable result into the exact cable-visible value of a
/// particular source port. Unknown module/port pairs fail closed.
fn result_port_value(module: &str, port: &str, result: &StoredResult) -> Option<Value> {
    if port.starts_with("variant:") {
        return matches!(
            module,
            "ai.image-generation"
                | "brand.logo-design"
                | "ai.video-generation"
                | "core.image-collection"
                | "core.video-collection"
        )
        .then(|| primary_result_value(result))
        .flatten();
    }
    if matches!(
        module,
        "brand.audience" | "brand.names" | "brand.font-pairing" | "brand.color-palette"
    ) {
        if let Some(value) = brand_output_value(result, port) {
            return Some(value);
        }
    }
    match (module, port) {
        ("ai.text-generation" | "ai.image-analysis", "text" | "texts")
        | ("ai.transcription" | "context.research", "text")
        | ("context.webpage", "text")
        | ("brand.audience", "audience")
        | ("brand.names", "names")
        | ("brand.domain", "domains")
        | ("brand.handle-plan", "handles")
        | ("brand.font-pairing", "pairing")
        | ("brand.color-palette", "palette") => result.text_value.clone().map(Value::String),
        ("context.webpage", "image" | "screenshot")
        | (
            "ai.image-generation"
            | "brand.logo-design"
            | "image.upscale"
            | "image.transform"
            | "image.trim-transparent"
            | "image.background-removal"
            | "media.video-frame",
            "image" | "images",
        )
        | ("core.image-input", "image")
        | ("core.image-collection", "images")
        | ("ai.video-generation", "video" | "videos")
        | ("core.video-input", "video")
        | ("core.audio-input", "audio")
        | ("core.video-collection", "videos") => result
            .blob_hash
            .as_ref()
            .map(|hash| Value::String(format!("flowz-cas:{hash}"))),
        ("ai.video-generation", "startFrame") => parameter_hash(result, "startFrameHash"),
        ("ai.video-generation", "endFrame") => parameter_hash(result, "endFrameHash"),
        ("core.video-input", "startFrame") => parameter_hash(result, "startFrameHash"),
        ("core.video-input", "endFrame") => parameter_hash(result, "endFrameHash"),
        _ => None,
    }
}

fn config_value_matches(
    module: &str,
    port: &str,
    input: &Value,
    config: &serde_json::Map<String, Value>,
) -> bool {
    if input.is_null() {
        return false;
    }
    match (module, port) {
        ("core.text-input", "text") => {
            input.get("value") == config.get("text").or_else(|| config.get("value"))
        }
        ("core.image-input", "image") => {
            let expected = config
                .get("blobHash")
                .or_else(|| config.get("assetId"))
                .and_then(Value::as_str)
                .map(|hash| Value::String(format!("flowz-cas:{hash}")));
            expected
                .as_ref()
                .is_some_and(|expected| input.get("value") == Some(expected))
        }
        ("core.video-input", "video") | ("core.audio-input", "audio") => {
            let expected = config
                .get("blobHash")
                .and_then(Value::as_str)
                .map(|hash| Value::String(format!("flowz-cas:{hash}")));
            expected
                .as_ref()
                .is_some_and(|expected| input.get("value") == Some(expected))
        }
        // These sources are immutable through their complete persisted config:
        // library assets contain a version ID; Brand brief/artboard outputs are
        // deterministic projections of that config. Their exact config is
        // compared below, and unknown config-owned modules never reach here.
        ("library.asset-text", "text") => input.get("value").is_some_and(|value| !value.is_null()),
        ("library.asset-image", "image") => {
            input.get("value").is_some_and(|value| !value.is_null())
        }
        ("brand.brief", "brief") => input.get("value").is_some_and(|value| !value.is_null()),
        ("brand.artboard", "artboard" | "image" | "images") => {
            input.get("value").is_some_and(|value| !value.is_null())
        }
        _ => false,
    }
}

fn result_values_match(
    module: &str,
    port: &str,
    input: &Value,
    expected: &serde_json::Map<String, Value>,
    source_node_id: &str,
    source_config: &serde_json::Map<String, Value>,
    results: &HashMap<String, StoredResult>,
) -> bool {
    let Some(result_ids) = expected.get("resultIds").and_then(Value::as_array) else {
        return false;
    };
    if result_ids.is_empty() || result_ids.len() > 200 {
        return false;
    }
    let collection = matches!(module, "core.image-collection" | "core.video-collection");
    if collection {
        if expected.get("sourceConfig") != Some(&Value::Object(source_config.clone())) {
            return false;
        }
        let configured = source_config
            .get("collectionResultIds")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if configured != *result_ids {
            return false;
        }
    } else if expected.get("sourceConfig").is_some() {
        return false;
    }

    let mut durable = Vec::with_capacity(result_ids.len());
    for id in result_ids {
        let Some(id) = id.as_str() else { return false };
        let Some(result) = results.get(id) else {
            return false;
        };
        if !collection && result.node_id != source_node_id {
            return false;
        }
        durable.push(result);
    }
    let variant = port.starts_with("variant:");
    if collection || variant {
        if expected.get("activeResultId").is_some() {
            return false;
        }
    } else {
        let Some(active_id) = expected.get("activeResultId").and_then(Value::as_str) else {
            return false;
        };
        if !result_ids.iter().any(|id| id.as_str() == Some(active_id))
            || !results.get(active_id).is_some_and(|result| result.active)
        {
            return false;
        }
    }

    let values = durable
        .iter()
        .map(|result| result_port_value(module, port, result))
        .collect::<Option<Vec<_>>>();
    let Some(values) = values else { return false };
    let actual = input.get("value").unwrap_or(&Value::Null);
    if actual.is_array() {
        actual.as_array() == Some(&values)
    } else {
        values.len() == 1 && values.first() == Some(actual)
    }
}

/// Validates the canonical execution snapshot produced by the desktop client.
/// The global project revision is deliberately informational: canvas movement
/// and unrelated node edits do not invalidate a run. Target module/config,
/// incoming edge semantics and every concrete upstream result/config identity
/// are nevertheless compared exactly against current durable state.
pub fn matches(
    project_id: &str,
    node_id: &str,
    snapshot: &Value,
    persistence: &Persistence,
    allowed_modules: &[&str],
    request_contract: Option<&Value>,
) -> bool {
    let Ok(opened) = persistence.projects.open(project_id) else {
        return false;
    };
    let project = opened.project;
    let Some(snapshot) = snapshot.as_object() else {
        return false;
    };
    let Some(node) = project.graph.nodes.iter().find(|node| node.id == node_id) else {
        return false;
    };
    if !allowed_modules.contains(&node.module_id.as_str())
        || snapshot.get("moduleId").and_then(Value::as_str) != Some(node.module_id.as_str())
        || snapshot.get("moduleVersion").and_then(Value::as_u64)
            != Some(u64::from(node.module_version))
        || snapshot.get("nodeConfig") != Some(&Value::Object(node.config.clone()))
    {
        return false;
    }
    if request_contract.is_some_and(|contract| snapshot.get("requestContract") != Some(contract)) {
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

    let Some(expected_connections) = snapshot.get("connections").and_then(Value::as_array) else {
        return false;
    };
    let Some(fingerprint_inputs) = fingerprint.get("inputs").and_then(Value::as_array) else {
        return false;
    };
    let mut edges = project
        .graph
        .edges
        .iter()
        .filter(|edge| edge.target_node_id == node_id)
        .collect::<Vec<_>>();
    edges.sort_by(|left, right| {
        left.target_port_id
            .cmp(&right.target_port_id)
            .then(left.order.cmp(&right.order))
            .then(left.id.cmp(&right.id))
    });
    if edges.len() != expected_connections.len() || edges.len() != fingerprint_inputs.len() {
        return false;
    }
    let Ok(project_results) = persistence.database.project_results(project_id) else {
        return false;
    };
    let results = project_results
        .into_iter()
        .map(|result| (result.result_id.clone(), result))
        .collect::<HashMap<_, _>>();

    for ((edge, expected), input) in edges
        .iter()
        .zip(expected_connections)
        .zip(fingerprint_inputs)
    {
        let Some(expected) = expected.as_object() else {
            return false;
        };
        let same_edge = |value: &Value| {
            value.get("sourceNodeId").and_then(Value::as_str) == Some(edge.source_node_id.as_str())
                && value.get("sourcePortId").and_then(Value::as_str)
                    == Some(edge.source_port_id.as_str())
                && value.get("targetPortId").and_then(Value::as_str)
                    == Some(edge.target_port_id.as_str())
                && value.get("order").and_then(Value::as_u64) == Some(edge.order)
        };
        if !same_edge(&Value::Object(expected.clone())) || !same_edge(input) {
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
        match expected.get("identity").and_then(Value::as_str) {
            Some("config") => {
                if !CONFIG_OWNED_SOURCES.contains(&source.module_id.as_str())
                    || expected.get("sourceConfig") != Some(&Value::Object(source.config.clone()))
                    || expected.get("resultIds").is_some()
                    || expected.get("activeResultId").is_some()
                    || !config_value_matches(
                        &source.module_id,
                        &edge.source_port_id,
                        input,
                        &source.config,
                    )
                {
                    return false;
                }
            }
            Some("results") => {
                if !result_values_match(
                    &source.module_id,
                    &edge.source_port_id,
                    input,
                    expected,
                    &source.id,
                    &source.config,
                    &results,
                ) {
                    return false;
                }
            }
            _ => return false,
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::{
        CanvasPosition, CreateProjectRequest, GraphEdge, GraphNode, SaveProjectRequest,
        UpdatePolicy,
    };
    use serde_json::{json, Map};
    use uuid::Uuid;

    fn node(id: &str, module_id: &str, config: Value) -> GraphNode {
        GraphNode {
            id: id.into(),
            module_id: module_id.into(),
            module_version: 1,
            position: CanvasPosition { x: 0.0, y: 0.0 },
            label: None,
            label_id: None,
            config: serde_json::from_value::<Map<String, Value>>(config).unwrap(),
            update_policy: UpdatePolicy::Manual,
        }
    }

    fn edge(id: &str, source: &str, source_port: &str, target_port: &str, order: u64) -> GraphEdge {
        GraphEdge {
            id: id.into(),
            source_node_id: source.into(),
            source_port_id: source_port.into(),
            target_node_id: "target".into(),
            target_port_id: target_port.into(),
            order,
        }
    }

    fn store_text(
        persistence: &Persistence,
        project_id: &str,
        node_id: &str,
        result_id: &str,
        text: &str,
        parameters: Option<&Value>,
        active: bool,
    ) {
        let run_id = Uuid::new_v4().to_string();
        persistence
            .database
            .record_provider_completion(&run_id, project_id, node_id, "fixture", None, "now")
            .unwrap();
        persistence
            .database
            .attach_result(
                result_id,
                &run_id,
                project_id,
                node_id,
                "text",
                Some(text),
                None,
                None,
                None,
                parameters,
                "now",
                active,
            )
            .unwrap();
    }

    fn store_image(
        persistence: &Persistence,
        project_id: &str,
        node_id: &str,
        result_id: &str,
        byte: u8,
        active: bool,
    ) -> String {
        let run_id = Uuid::new_v4().to_string();
        let blob = persistence
            .blobs
            .import_bytes(&[byte; 8], "image/png".into(), Some("fixture.png".into()))
            .unwrap();
        persistence.database.upsert_blob(&blob).unwrap();
        persistence
            .database
            .record_provider_completion(&run_id, project_id, node_id, "fixture", None, "now")
            .unwrap();
        persistence
            .database
            .attach_result(
                result_id,
                &run_id,
                project_id,
                node_id,
                "image",
                None,
                Some(&blob),
                None,
                None,
                None,
                "now",
                active,
            )
            .unwrap();
        blob.hash
    }

    fn store_media_result(
        persistence: &Persistence,
        project_id: &str,
        node_id: &str,
        result_id: &str,
        payload: (Option<&str>, Option<&Value>),
        byte: u8,
        active: bool,
    ) -> String {
        let (text, parameters) = payload;
        let run_id = Uuid::new_v4().to_string();
        let blob = persistence
            .blobs
            .import_bytes(&[byte; 8], "image/png".into(), Some("fixture.png".into()))
            .unwrap();
        persistence.database.upsert_blob(&blob).unwrap();
        persistence
            .database
            .record_provider_completion(&run_id, project_id, node_id, "fixture", None, "now")
            .unwrap();
        persistence
            .database
            .attach_result(
                result_id,
                &run_id,
                project_id,
                node_id,
                "fixture",
                text,
                Some(&blob),
                None,
                None,
                parameters,
                "now",
                active,
            )
            .unwrap();
        blob.hash
    }

    fn snapshot(config: &Value, inputs: Value, connections: Value, revision: u64) -> Value {
        json!({
            "moduleId":"ai.image-generation",
            "moduleVersion":1,
            "nodeConfig":config,
            "connections":connections,
            "executionFingerprint":json!({
                "moduleId":"ai.image-generation",
                "moduleVersion":1,
                "config":config,
                "inputs":inputs,
            }).to_string(),
            "projectRevision":revision,
        })
    }

    #[test]
    fn unrelated_revision_changes_are_allowed_but_target_edges_and_source_config_are_exact() {
        let root = tempfile::tempdir().unwrap();
        let persistence = Persistence::initialize(root.path()).unwrap();
        let created = persistence
            .projects
            .create(CreateProjectRequest {
                name: "Semantic".into(),
            })
            .unwrap();
        let mut project = created.project;
        let target_config = json!({"model":"image-model"});
        project.graph.nodes.extend([
            node("prompt", "core.text-input", json!({"text":"Hello"})),
            node("unrelated", "core.text-input", json!({"text":"Other"})),
            node("target", "ai.image-generation", target_config.clone()),
        ]);
        project
            .graph
            .edges
            .push(edge("prompt-edge", "prompt", "text", "prompt", 0));
        let saved = persistence
            .projects
            .save(SaveProjectRequest {
                expected_updated_at: project.updated_at,
                expected_revision: created.revision,
                project,
            })
            .unwrap();
        let input = json!({"sourceNodeId":"prompt","sourcePortId":"text","targetPortId":"prompt","order":0,"value":"Hello"});
        let connection = json!({"sourceNodeId":"prompt","sourcePortId":"text","targetPortId":"prompt","order":0,"identity":"config","sourceConfig":{"text":"Hello"}});
        let exact = snapshot(
            &target_config,
            json!([input]),
            json!([connection]),
            saved.revision,
        );
        assert!(matches(
            &saved.project.id,
            "target",
            &exact,
            &persistence,
            &["ai.image-generation"],
            None
        ));

        let opened = persistence.projects.open(&saved.project.id).unwrap();
        let mut unrelated = opened.project;
        unrelated.graph.nodes[1]
            .config
            .insert("text".into(), json!("Changed elsewhere"));
        let changed = persistence
            .projects
            .save(SaveProjectRequest {
                expected_updated_at: unrelated.updated_at,
                expected_revision: opened.revision,
                project: unrelated,
            })
            .unwrap();
        assert_ne!(changed.revision, saved.revision);
        assert!(matches(
            &changed.project.id,
            "target",
            &exact,
            &persistence,
            &["ai.image-generation"],
            None
        ));

        let opened = persistence.projects.open(&changed.project.id).unwrap();
        let mut target_changed = opened.project;
        target_changed.graph.nodes[2]
            .config
            .insert("model".into(), json!("different-model"));
        let target_changed = persistence
            .projects
            .save(SaveProjectRequest {
                expected_updated_at: target_changed.updated_at,
                expected_revision: opened.revision,
                project: target_changed,
            })
            .unwrap();
        assert!(!matches(
            &target_changed.project.id,
            "target",
            &exact,
            &persistence,
            &["ai.image-generation"],
            None
        ));

        let opened = persistence
            .projects
            .open(&target_changed.project.id)
            .unwrap();
        let mut edge_changed = opened.project;
        edge_changed.graph.nodes[2].config = serde_json::from_value(target_config.clone()).unwrap();
        edge_changed.graph.edges[0].target_port_id = "negativePrompt".into();
        let edge_changed = persistence
            .projects
            .save(SaveProjectRequest {
                expected_updated_at: edge_changed.updated_at,
                expected_revision: opened.revision,
                project: edge_changed,
            })
            .unwrap();
        assert!(!matches(
            &edge_changed.project.id,
            "target",
            &exact,
            &persistence,
            &["ai.image-generation"],
            None
        ));

        let opened = persistence.projects.open(&edge_changed.project.id).unwrap();
        let mut relevant = opened.project;
        relevant.graph.edges[0].target_port_id = "prompt".into();
        relevant.graph.nodes[0]
            .config
            .insert("text".into(), json!("Changed input"));
        persistence
            .projects
            .save(SaveProjectRequest {
                expected_updated_at: relevant.updated_at,
                expected_revision: opened.revision,
                project: relevant,
            })
            .unwrap();
        assert!(!matches(
            &changed.project.id,
            "target",
            &exact,
            &persistence,
            &["ai.image-generation"],
            None
        ));
    }

    #[test]
    fn ordered_lists_and_variants_use_exact_results_instead_of_node_active_identity() {
        let root = tempfile::tempdir().unwrap();
        let persistence = Persistence::initialize(root.path()).unwrap();
        let created = persistence
            .projects
            .create(CreateProjectRequest {
                name: "Lists".into(),
            })
            .unwrap();
        let mut project = created.project;
        let target_config = json!({"model":"image-model"});
        project.graph.nodes.extend([
            node(
                "source",
                "ai.image-generation",
                json!({"model":"source-model"}),
            ),
            node("target", "ai.image-generation", target_config.clone()),
        ]);
        project.graph.edges.extend([
            edge("list", "source", "images", "references", 0),
            edge("variant", "source", "variant:r2", "reference", 0),
        ]);
        let saved = persistence
            .projects
            .save(SaveProjectRequest {
                expected_updated_at: project.updated_at,
                expected_revision: created.revision,
                project,
            })
            .unwrap();
        persistence.database.upsert_project(&saved.project).unwrap();
        let a = store_image(&persistence, &saved.project.id, "source", "r1", 1, true);
        let b = store_image(&persistence, &saved.project.id, "source", "r2", 2, false);
        let inputs = json!([
            {"sourceNodeId":"source","sourcePortId":"variant:r2","targetPortId":"reference","order":0,"value":format!("flowz-cas:{b}")},
            {"sourceNodeId":"source","sourcePortId":"images","targetPortId":"references","order":0,"value":[format!("flowz-cas:{a}"),format!("flowz-cas:{b}")]},
        ]);
        let connections = json!([
            {"sourceNodeId":"source","sourcePortId":"variant:r2","targetPortId":"reference","order":0,"identity":"results","resultIds":["r2"]},
            {"sourceNodeId":"source","sourcePortId":"images","targetPortId":"references","order":0,"identity":"results","resultIds":["r1","r2"],"activeResultId":"r1"},
        ]);
        let exact = snapshot(&target_config, inputs, connections, saved.revision);
        assert!(matches(
            &saved.project.id,
            "target",
            &exact,
            &persistence,
            &["ai.image-generation"],
            None
        ));
        persistence
            .database
            .set_active_result(&saved.project.id, "source", "r2")
            .unwrap();
        assert!(!matches(
            &saved.project.id,
            "target",
            &exact,
            &persistence,
            &["ai.image-generation"],
            None
        ));
    }

    #[test]
    fn multioutput_results_validate_webpage_video_and_brand_ports_exactly() {
        let root = tempfile::tempdir().unwrap();
        let persistence = Persistence::initialize(root.path()).unwrap();
        let created = persistence
            .projects
            .create(CreateProjectRequest {
                name: "Multi".into(),
            })
            .unwrap();
        let mut project = created.project;
        let target_config = json!({"model":"image-model"});
        project.graph.nodes.extend([
            node(
                "web",
                "context.webpage",
                json!({"url":"https://example.com"}),
            ),
            node("video", "ai.video-generation", json!({"model":"video"})),
            node("fonts", "brand.font-pairing", json!({"model":"text"})),
            node("target", "ai.image-generation", target_config.clone()),
        ]);
        project.graph.edges.extend([
            edge("web-text", "web", "text", "prompt", 0),
            edge("web-image", "web", "screenshot", "reference", 0),
            edge("video-start", "video", "startFrame", "reference", 1),
            edge("font-style", "fonts", "styleHint", "prompt", 1),
        ]);
        let saved = persistence
            .projects
            .save(SaveProjectRequest {
                expected_updated_at: project.updated_at,
                expected_revision: created.revision,
                project,
            })
            .unwrap();
        persistence.database.upsert_project(&saved.project).unwrap();
        let screenshot = store_media_result(
            &persistence,
            &saved.project.id,
            "web",
            "web-result",
            (Some("Example"), None),
            3,
            true,
        );
        let video_parameters =
            json!({"startFrameHash":"d".repeat(64),"endFrameHash":"e".repeat(64)});
        store_media_result(
            &persistence,
            &saved.project.id,
            "video",
            "video-result",
            (None, Some(&video_parameters)),
            4,
            true,
        );
        let brand = json!({"brandOutputPorts":{"version":1,"values":{"pairing":"PAIRING","styleHint":"Editorial serif"}}});
        store_text(
            &persistence,
            &saved.project.id,
            "fonts",
            "font-result",
            "PAIRING",
            Some(&brand),
            true,
        );
        let inputs = json!([
            {"sourceNodeId":"web","sourcePortId":"text","targetPortId":"prompt","order":0,"value":"Example"},
            {"sourceNodeId":"fonts","sourcePortId":"styleHint","targetPortId":"prompt","order":1,"value":"Editorial serif"},
            {"sourceNodeId":"web","sourcePortId":"screenshot","targetPortId":"reference","order":0,"value":format!("flowz-cas:{screenshot}")},
            {"sourceNodeId":"video","sourcePortId":"startFrame","targetPortId":"reference","order":1,"value":format!("flowz-cas:{}","d".repeat(64))},
        ]);
        let connections = json!([
            {"sourceNodeId":"web","sourcePortId":"text","targetPortId":"prompt","order":0,"identity":"results","resultIds":["web-result"],"activeResultId":"web-result"},
            {"sourceNodeId":"fonts","sourcePortId":"styleHint","targetPortId":"prompt","order":1,"identity":"results","resultIds":["font-result"],"activeResultId":"font-result"},
            {"sourceNodeId":"web","sourcePortId":"screenshot","targetPortId":"reference","order":0,"identity":"results","resultIds":["web-result"],"activeResultId":"web-result"},
            {"sourceNodeId":"video","sourcePortId":"startFrame","targetPortId":"reference","order":1,"identity":"results","resultIds":["video-result"],"activeResultId":"video-result"},
        ]);
        let exact = snapshot(&target_config, inputs, connections, saved.revision);
        assert!(matches(
            &saved.project.id,
            "target",
            &exact,
            &persistence,
            &["ai.image-generation"],
            None
        ));
        let mut wrong = exact;
        let raw = wrong["executionFingerprint"].as_str().unwrap();
        let mut fingerprint: Value = serde_json::from_str(raw).unwrap();
        fingerprint["inputs"][1]["value"] = json!("Wrong style");
        wrong["executionFingerprint"] = json!(fingerprint.to_string());
        assert!(!matches(
            &saved.project.id,
            "target",
            &wrong,
            &persistence,
            &["ai.image-generation"],
            None
        ));
    }
}
