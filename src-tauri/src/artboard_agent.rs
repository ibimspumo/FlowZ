use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Emitter};
use tokio_util::sync::CancellationToken;

type Reply = mpsc::Sender<Result<Value, String>>;
struct Process {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Clone)]
pub struct CodexAppServerState {
    process: Arc<Mutex<Option<Process>>>,
    pending: Arc<Mutex<HashMap<u64, Reply>>>,
    next_id: Arc<Mutex<u64>>,
    server_requests: Arc<Mutex<HashMap<String, String>>>,
    app_data: PathBuf,
}

#[derive(Default)]
pub struct OpenRouterArtboardState(Mutex<HashMap<String, CancellationToken>>);

#[derive(Clone)]
pub struct AgentRepositoryState {
    path: PathBuf,
    lock: Arc<Mutex<()>>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentRepositoryFile {
    sessions: Vec<AgentSession>,
    runs: Vec<AgentRun>,
    usage: Vec<AgentUsage>,
    #[serde(default)]
    proposals: Vec<Value>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSession {
    workspace_id: String,
    branch_id: String,
    #[serde(default = "legacy_conversation_id")]
    conversation_id: String,
    provider: String,
    tool_contract_version: String,
    provider_session_id: String,
    model_id: String,
    reasoning_effort: Option<String>,
    last_turn_id: Option<String>,
    #[serde(default)]
    manual_context_checkpoint: Option<Value>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRun {
    run_id: String,
    workspace_id: String,
    branch_id: String,
    #[serde(default = "legacy_conversation_id")]
    conversation_id: String,
    provider: String,
    tool_contract_version: String,
    provider_session_id: String,
    provider_turn_id: Option<String>,
    model_id: String,
    reasoning_effort: Option<String>,
    input_revision: i64,
    selected_board_revision_ids: Vec<String>,
    state: String,
    submitted_at: String,
    proposal_id: Option<String>,
    error: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentUsage {
    run_id: String,
    provider_turn_id: Option<String>,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cost_microunits: Option<u64>,
    generation_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionKey {
    workspace_id: String,
    branch_id: String,
    conversation_id: String,
    provider: String,
    tool_contract_version: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenRouterStepRequest {
    run_id: String,
    body: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RpcRequest {
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RpcResponse {
    id: Value,
    result: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScratchDirectory {
    path: String,
}

impl CodexAppServerState {
    pub fn new(app_data: PathBuf) -> Self {
        Self {
            process: Arc::new(Mutex::new(None)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: Arc::new(Mutex::new(1)),
            server_requests: Arc::new(Mutex::new(HashMap::new())),
            app_data,
        }
    }
    fn command() -> Result<Command, String> {
        let home_candidate = std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|home| home.join(".local/bin/codex"));
        if let Some(path) = home_candidate.as_deref().filter(|path| path.is_file()) {
            return Ok(Command::new(path));
        }
        let candidates = [
            Path::new("/opt/homebrew/bin/codex"),
            Path::new("/usr/local/bin/codex"),
        ];
        if let Some(path) = candidates.iter().find(|path| path.is_file()) {
            return Ok(Command::new(path));
        }
        Ok(Command::new("codex"))
    }
    fn write(&self, value: &Value) -> Result<(), String> {
        let mut guard = self
            .process
            .lock()
            .map_err(|_| "Codex-Prozesssperre ist beschädigt.".to_string())?;
        let process = guard.as_mut().ok_or("Codex App Server läuft nicht.")?;
        serde_json::to_writer(&mut process.stdin, value).map_err(|e| e.to_string())?;
        process
            .stdin
            .write_all(b"\n")
            .and_then(|_| process.stdin.flush())
            .map_err(|e| e.to_string())
    }
    fn spawn(&self, app: &AppHandle) -> Result<(), String> {
        if self
            .process
            .lock()
            .map_err(|_| "Codex-Prozesssperre ist beschädigt.".to_string())?
            .is_some()
        {
            return Ok(());
        }
        let mut command = Self::command()?;
        for feature in [
            "shell_tool",
            "unified_exec",
            "apps",
            "plugins",
            "browser_use",
            "browser_use_external",
            "browser_use_full_cdp_access",
            "in_app_browser",
            "computer_use",
            "image_generation",
            "multi_agent",
            "workspace_dependencies",
            "hooks",
            "code_mode_host",
            "tool_suggest",
            "skill_mcp_dependency_install",
            "remote_plugin",
            "plugin_sharing",
            "auth_elicitation",
            "enable_mcp_apps",
        ] {
            command.arg("--disable").arg(feature);
        }
        let mut child = command.arg("-c").arg("mcp_servers={}").arg("-c").arg("web_search=\"disabled\"").arg("app-server").arg("--listen").arg("stdio://").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|_| "Codex CLI wurde nicht gefunden. Installiere oder aktualisiere die lokale Codex CLI.".to_string())?;
        let stdin = child.stdin.take().ok_or("Codex stdin fehlt.")?;
        let stdout = child.stdout.take().ok_or("Codex stdout fehlt.")?;
        *self
            .process
            .lock()
            .map_err(|_| "Codex-Prozesssperre ist beschädigt.".to_string())? =
            Some(Process { child, stdin });
        let pending = self.pending.clone();
        let process = self.process.clone();
        let server_requests = self.server_requests.clone();
        let app = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                let response_id = value.get("id").and_then(Value::as_u64);
                if value.get("method").is_none() {
                    if let Some(id) = response_id {
                        if let Ok(mut map) = pending.lock() {
                            if let Some(reply) = map.remove(&id) {
                                let result = value
                                    .get("error")
                                    .map(|error| {
                                        Err(error
                                            .get("message")
                                            .and_then(Value::as_str)
                                            .unwrap_or("Codex RPC fehlgeschlagen.")
                                            .to_string())
                                    })
                                    .unwrap_or_else(|| {
                                        Ok(value.get("result").cloned().unwrap_or(Value::Null))
                                    });
                                let _ = reply.send(result);
                                continue;
                            }
                        }
                    }
                }
                if value.get("method").and_then(Value::as_str) == Some("item/tool/call") {
                    if let Some(id) = value.get("id") {
                        if let (Ok(key), Ok(mut requests)) =
                            (serde_json::to_string(id), server_requests.lock())
                        {
                            requests.insert(key, "item/tool/call".into());
                        }
                    }
                }
                let _ = app.emit("codex-app-server-event", value);
            }
            if let Ok(mut slot) = process.lock() {
                *slot = None;
            }
            if let Ok(mut map) = pending.lock() {
                for (_, reply) in map.drain() {
                    let _ = reply.send(Err("CODEX_PROCESS_LOST".into()));
                }
            }
            if let Ok(mut map) = server_requests.lock() {
                map.clear();
            }
            let _ = app.emit(
                "codex-app-server-event",
                json!({"method":"process/lost","params":{}}),
            );
        });
        Ok(())
    }
    fn request_blocking(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = {
            let mut next = self
                .next_id
                .lock()
                .map_err(|_| "Codex RPC-ID-Sperre ist beschädigt.".to_string())?;
            let id = *next;
            *next += 1;
            id
        };
        let (tx, rx) = mpsc::channel();
        self.pending
            .lock()
            .map_err(|_| "Codex RPC-Sperre ist beschädigt.".to_string())?
            .insert(id, tx);
        if let Err(error) = self.write(&json!({"method":method,"id":id,"params":params})) {
            self.pending.lock().ok().and_then(|mut map| map.remove(&id));
            return Err(error);
        }
        rx.recv_timeout(Duration::from_secs(120))
            .map_err(|_| "Codex App Server antwortet nicht.".to_string())?
    }
}

impl AgentRepositoryState {
    pub fn new(app_data: &Path) -> Self {
        Self {
            path: app_data.join("artboard-agent-state.json"),
            lock: Arc::new(Mutex::new(())),
        }
    }
    fn load(&self) -> Result<AgentRepositoryFile, String> {
        match fs::read(&self.path) {
            Ok(bytes) if bytes.len() <= 4 * 1024 * 1024 => serde_json::from_slice(&bytes)
                .map_err(|_| "Artboard-Agentzustand ist beschädigt.".to_string()),
            Ok(_) => Err("Artboard-Agentzustand ist zu groß.".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(AgentRepositoryFile::default())
            }
            Err(error) => Err(error.to_string()),
        }
    }
    fn save(&self, value: &AgentRepositoryFile) -> Result<(), String> {
        let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
        if bytes.len() > 4 * 1024 * 1024 {
            return Err("Artboard-Agentzustand ist zu groß.".into());
        }
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?
        }
        let temporary = self.path.with_extension("json.tmp");
        fs::write(&temporary, bytes).map_err(|e| e.to_string())?;
        fs::rename(temporary, &self.path).map_err(|e| e.to_string())
    }
}

fn valid_record_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._:-".contains(c))
}
const LEGACY_CONVERSATION_ID: &str = "conversation-legacy";
fn legacy_conversation_id() -> String {
    LEGACY_CONVERSATION_ID.into()
}
fn valid_conversation_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._:-".contains(c))
}
const ARTBOARD_TOOL_CONTRACT_VERSION: &str = "flowz-artboard-tools-v2";
fn validate_session_key(value: &SessionKey) -> Result<(), String> {
    if valid_record_id(&value.workspace_id)
        && valid_record_id(&value.branch_id)
        && valid_conversation_id(&value.conversation_id)
        && matches!(value.provider.as_str(), "openrouter" | "codex-local")
        && value.tool_contract_version == ARTBOARD_TOOL_CONTRACT_VERSION
    {
        Ok(())
    } else {
        Err("Ungültiger Artboard-Agent-Session-Schlüssel.".into())
    }
}
fn validate_session(value: &AgentSession) -> Result<(), String> {
    if [
        &value.workspace_id,
        &value.branch_id,
        &value.provider_session_id,
        &value.model_id,
    ]
    .iter()
    .all(|v| valid_record_id(v))
        && valid_conversation_id(&value.conversation_id)
        && matches!(value.provider.as_str(), "openrouter" | "codex-local")
        && value.tool_contract_version == ARTBOARD_TOOL_CONTRACT_VERSION
    {
        if let Some(checkpoint) = &value.manual_context_checkpoint {
            let bytes = serde_json::to_vec(checkpoint).map_err(|error| error.to_string())?;
            let valid_shape = checkpoint.as_object().is_some_and(|item| {
                item.get("schemaVersion").and_then(Value::as_u64) == Some(1)
                    && item.get("revision").is_some_and(Value::is_object)
                    && item
                        .get("boards")
                        .and_then(Value::as_array)
                        .is_some_and(|boards| boards.len() <= 24)
            });
            if bytes.len() > 64 * 1024 || !valid_shape {
                return Err("Ungültiger oder zu großer Artboard-Kontext-Checkpoint.".into());
            }
        }
        Ok(())
    } else {
        Err("Ungültige Artboard-Agent-Session.".into())
    }
}
fn validate_run(value: &AgentRun) -> Result<(), String> {
    if !valid_record_id(&value.run_id)
        || value.input_revision < 0
        || value.submitted_at.len() > 64
        || chrono::DateTime::parse_from_rfc3339(&value.submitted_at).is_err()
        || value.selected_board_revision_ids.len() > 64
        || !value
            .selected_board_revision_ids
            .iter()
            .all(|v| valid_record_id(v))
        || !matches!(
            value.state.as_str(),
            "idle"
                | "submitting"
                | "streaming"
                | "tool-executing"
                | "cancel-requested"
                | "interrupted"
                | "finalizing"
                | "proposal-ready"
                | "applying"
                | "rejecting"
                | "applied"
                | "rejected"
                | "failed"
                | "process-lost"
                | "recovering"
                | "unknown"
        )
    {
        return Err("Ungültiger Artboard-Agentlauf.".into());
    }
    validate_session(&AgentSession {
        workspace_id: value.workspace_id.clone(),
        branch_id: value.branch_id.clone(),
        conversation_id: value.conversation_id.clone(),
        provider: value.provider.clone(),
        tool_contract_version: value.tool_contract_version.clone(),
        provider_session_id: value.provider_session_id.clone(),
        model_id: value.model_id.clone(),
        reasoning_effort: value.reasoning_effort.clone(),
        last_turn_id: value.provider_turn_id.clone(),
        manual_context_checkpoint: None,
    })
}

fn session_matches_key(session: &AgentSession, key: &SessionKey) -> bool {
    session.workspace_id == key.workspace_id
        && session.branch_id == key.branch_id
        && session.conversation_id == key.conversation_id
        && session.provider == key.provider
        && session.tool_contract_version == key.tool_contract_version
}

fn same_session_identity(left: &AgentSession, right: &AgentSession) -> bool {
    left.workspace_id == right.workspace_id
        && left.branch_id == right.branch_id
        && left.conversation_id == right.conversation_id
        && left.provider == right.provider
        && left.tool_contract_version == right.tool_contract_version
}

fn upsert_session(file: &mut AgentRepositoryFile, session: AgentSession) {
    file.sessions
        .retain(|item| !same_session_identity(item, &session));
    file.sessions.push(session);
}

fn run_matches_key(run: &AgentRun, key: &SessionKey) -> bool {
    run.workspace_id == key.workspace_id
        && run.branch_id == key.branch_id
        && run.conversation_id == key.conversation_id
        && run.provider == key.provider
        && run.tool_contract_version == key.tool_contract_version
}

fn latest_run_for_key(
    file: &AgentRepositoryFile,
    key: &SessionKey,
) -> Result<Option<AgentRun>, String> {
    validate_session_key(key)?;
    let mut latest: Option<(chrono::DateTime<chrono::FixedOffset>, usize, &AgentRun)> = None;
    for (stored_order, run) in file.runs.iter().enumerate() {
        if !run_matches_key(run, key) {
            continue;
        }
        validate_run(run)?;
        let submitted_at = chrono::DateTime::parse_from_rfc3339(&run.submitted_at)
            .map_err(|_| "Ungültiger Artboard-Agentlauf.".to_string())?;
        if latest.as_ref().is_none_or(|(latest_at, latest_order, _)| {
            submitted_at > *latest_at
                || (submitted_at == *latest_at && stored_order > *latest_order)
        }) {
            latest = Some((submitted_at, stored_order, run));
        }
    }
    Ok(latest.map(|(_, _, run)| run.clone()))
}

const CODEX_INSTRUCTIONS: &str = "You are FlowZ's Artboard design agent. Use only the supplied dynamic Artboard tools. Read bounded state, then create proposal operations. Keep small requested edits on the existing board. For a new direction, variant, or format adaptation, use create_board or duplicate_board_as_variant so the original remains and the collision-free result is placed beside it; multiple boards may have different supported sizes. Use delete_board only when the user explicitly asks to remove that whole Artboard; it is proposal-only and the user still confirms it in FlowZ. Never remove the final Artboard. After drafting writes, call render_preview with the same proposalId and visually inspect the returned image for overlap, crop, contrast, and hierarchy. If you identify a concrete issue, make at most one targeted correction call and then call render_preview again to verify it. Only then call finish_working. Never use shell, files, URLs, web, MCP, apps, skills, or built-in tools. Never claim that a proposal is applied.";

fn exact_keys(object: &serde_json::Map<String, Value>, expected: &[&str]) -> bool {
    object.len() == expected.len() && expected.iter().all(|key| object.contains_key(*key))
}

fn valid_codex_id(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(valid_record_id)
}

fn validate_dynamic_tools(value: Option<&Value>) -> Result<(), String> {
    let tools = value
        .and_then(Value::as_array)
        .ok_or("Codex Dynamic-Tools fehlen.")?;
    if tools.len() != ARTBOARD_TOOLS.len() {
        return Err("Codex muss exakt die freigegebenen Artboard-Tools erhalten.".into());
    }
    let mut names = Vec::with_capacity(tools.len());
    for tool in tools {
        let object = tool.as_object().ok_or("Ungültiges Codex Dynamic-Tool.")?;
        if !exact_keys(object, &["type", "name", "description", "inputSchema"])
            || object.get("type").and_then(Value::as_str) != Some("function")
            || !object
                .get("description")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.is_empty() && value.len() <= 500)
            || !object.get("inputSchema").is_some_and(Value::is_object)
        {
            return Err("Ungültiges Codex Dynamic-Tool.".into());
        }
        names.push(
            object
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        );
    }
    names.sort_unstable();
    let mut expected = ARTBOARD_TOOLS.to_vec();
    expected.sort_unstable();
    if names != expected {
        return Err("Codex erhielt nicht exakt die freigegebenen Artboard-Tools.".into());
    }
    Ok(())
}

fn validate_codex_security(
    object: &serde_json::Map<String, Value>,
    app_data: &Path,
    resume: bool,
) -> Result<(), String> {
    let cwd = object
        .get("cwd")
        .and_then(Value::as_str)
        .ok_or("Codex Scratch-Verzeichnis fehlt.")?;
    let cwd_path = Path::new(cwd);
    let scratch_root = app_data.join("artboard-agent-scratch");
    if cwd_path.parent() != Some(scratch_root.as_path())
        || !cwd_path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(valid_record_id)
        || object.get("approvalPolicy").and_then(Value::as_str) != Some("never")
        || object.get("sandbox").and_then(Value::as_str) != Some("read-only")
        || object.get("developerInstructions").and_then(Value::as_str) != Some(CODEX_INSTRUCTIONS)
        || !valid_codex_id(object.get("model"))
    {
        return Err("Unsichere Codex-Sessionparameter wurden abgelehnt.".into());
    }
    let expected_config = json!({
        "sandbox_policy":{"type":"readOnly","networkAccess":false},
        "mcp_servers":{}, "web_search":"disabled",
        "features":{"apps":false,"plugins":false,"shell_tool":false,"unified_exec":false,"browser_use":false,"browser_use_external":false,"browser_use_full_cdp_access":false,"in_app_browser":false,"computer_use":false,"image_generation":false,"multi_agent":false,"workspace_dependencies":false,"code_mode_host":false,"tool_suggest":false,"skill_mcp_dependency_install":false,"remote_plugin":false,"plugin_sharing":false,"auth_elicitation":false,"enable_mcp_apps":false}
    });
    if object.get("config") != Some(&expected_config) {
        return Err("Unsichere Codex-Konfiguration wurde abgelehnt.".into());
    }
    validate_dynamic_tools(object.get("dynamicTools"))?;
    if resume {
        if !valid_codex_id(object.get("threadId")) {
            return Err("Ungültige Codex-Thread-ID.".into());
        }
    } else if object.get("serviceName").and_then(Value::as_str) != Some("flowz_artboard") {
        return Err("Ungültiger Codex-Service-Name.".into());
    }
    Ok(())
}

fn validate_codex_rpc_request(request: &RpcRequest, app_data: &Path) -> Result<(), String> {
    let object = request
        .params
        .as_object()
        .ok_or("Codex-RPC-Parameter müssen ein Objekt sein.")?;
    match request.method.as_str() {
        "account/read"
            if exact_keys(object, &["refreshToken"])
                && object.get("refreshToken") == Some(&Value::Bool(false)) =>
        {
            Ok(())
        }
        "model/list"
            if exact_keys(object, &["includeHidden"])
                && object.get("includeHidden") == Some(&Value::Bool(false)) =>
        {
            Ok(())
        }
        "thread/start" => {
            if !exact_keys(
                object,
                &[
                    "model",
                    "cwd",
                    "approvalPolicy",
                    "sandbox",
                    "config",
                    "developerInstructions",
                    "serviceName",
                    "dynamicTools",
                ],
            ) {
                return Err("Unerlaubte Codex-Threadparameter.".into());
            }
            validate_codex_security(object, app_data, false)
        }
        "thread/resume" => {
            if !exact_keys(
                object,
                &[
                    "threadId",
                    "model",
                    "cwd",
                    "approvalPolicy",
                    "sandbox",
                    "config",
                    "developerInstructions",
                    "dynamicTools",
                ],
            ) {
                return Err("Unerlaubte Codex-Resume-Parameter.".into());
            }
            validate_codex_security(object, app_data, true)
        }
        "thread/read"
            if exact_keys(object, &["threadId", "includeTurns"])
                && valid_codex_id(object.get("threadId"))
                && object.get("includeTurns") == Some(&Value::Bool(true)) =>
        {
            Ok(())
        }
        "turn/interrupt"
            if exact_keys(object, &["threadId", "turnId"])
                && valid_codex_id(object.get("threadId"))
                && valid_codex_id(object.get("turnId")) =>
        {
            Ok(())
        }
        "turn/start" => {
            if !exact_keys(
                object,
                &[
                    "threadId",
                    "model",
                    "effort",
                    "approvalPolicy",
                    "sandboxPolicy",
                    "input",
                ],
            ) || !valid_codex_id(object.get("threadId"))
                || !valid_codex_id(object.get("model"))
                || object.get("approvalPolicy").and_then(Value::as_str) != Some("never")
                || object.get("sandboxPolicy")
                    != Some(&json!({"type":"readOnly","networkAccess":false}))
            {
                return Err("Unsichere Codex-Turnparameter wurden abgelehnt.".into());
            }
            if !object
                .get("effort")
                .is_some_and(|value| value.is_null() || value.as_str().is_some_and(valid_record_id))
            {
                return Err("Ungültiger Codex-Reasoning-Aufwand.".into());
            }
            let input = object
                .get("input")
                .and_then(Value::as_array)
                .filter(|items| items.len() == 1)
                .ok_or("Codex-Turn benötigt genau einen Texteingang.")?;
            let text = input[0]
                .as_object()
                .filter(|item| {
                    exact_keys(item, &["type", "text"])
                        && item.get("type").and_then(Value::as_str) == Some("text")
                })
                .and_then(|item| item.get("text"))
                .and_then(Value::as_str)
                .ok_or("Ungültiger Codex-Texteingang.")?;
            if text.is_empty() || text.len() > 64 * 1024 {
                return Err("Codex-Texteingang ist ungültig.".into());
            }
            Ok(())
        }
        _ => Err(
            "Diese Codex-RPC-Methode oder ihre Parameter sind für FlowZ nicht freigegeben.".into(),
        ),
    }
}

fn validate_codex_tool_response(value: &Value) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or("Codex-Toolantwort muss ein Objekt sein.")?;
    if !exact_keys(object, &["contentItems", "success"])
        || !object.get("success").is_some_and(Value::is_boolean)
    {
        return Err("Ungültige Codex-Toolantwort.".into());
    }
    let items = object
        .get("contentItems")
        .and_then(Value::as_array)
        .filter(|items| (1..=2).contains(&items.len()))
        .ok_or("Codex-Toolantwort benötigt einen Textblock und optional genau ein lokales Vorschaubild.")?;
    let text_item = items[0]
        .as_object()
        .filter(|item| {
            exact_keys(item, &["type", "text"])
                && item.get("type").and_then(Value::as_str) == Some("inputText")
        })
        .ok_or("Ungültiger Codex-Toolantwortblock.")?;
    if text_item
        .get("text")
        .and_then(Value::as_str)
        .is_none_or(|text| text.len() > 64 * 1024)
    {
        return Err("Codex-Toolantwort ist zu groß.".into());
    }
    if let Some(image) = items.get(1) {
        let image = image
            .as_object()
            .filter(|item| {
                exact_keys(item, &["type", "imageUrl"])
                    && item.get("type").and_then(Value::as_str) == Some("inputImage")
            })
            .ok_or("Ungültiger Codex-Vorschaubildblock.")?;
        let url = image
            .get("imageUrl")
            .and_then(Value::as_str)
            .ok_or("Codex-Vorschaubild fehlt.")?;
        if url.len() > 6 * 1024 * 1024
            || !url.starts_with("data:image/png;base64,")
            || !url["data:image/png;base64,".len()..]
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
        {
            return Err("Codex-Vorschaubild muss ein begrenztes lokales PNG sein.".into());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn artboard_agent_session_find(
    key: SessionKey,
    state: tauri::State<'_, AgentRepositoryState>,
) -> Result<Option<AgentSession>, String> {
    validate_session_key(&key)?;
    let _guard = state
        .lock
        .lock()
        .map_err(|_| "Agentzustand ist gesperrt.".to_string())?;
    Ok(state
        .load()?
        .sessions
        .into_iter()
        .find(|item| session_matches_key(item, &key)))
}
#[tauri::command]
pub fn artboard_agent_session_save(
    session: AgentSession,
    state: tauri::State<'_, AgentRepositoryState>,
) -> Result<(), String> {
    validate_session(&session)?;
    let _guard = state
        .lock
        .lock()
        .map_err(|_| "Agentzustand ist gesperrt.".to_string())?;
    let mut file = state.load()?;
    upsert_session(&mut file, session);
    state.save(&file)
}
#[tauri::command]
pub fn artboard_agent_run_save(
    run: AgentRun,
    state: tauri::State<'_, AgentRepositoryState>,
) -> Result<(), String> {
    validate_run(&run)?;
    let _guard = state
        .lock
        .lock()
        .map_err(|_| "Agentzustand ist gesperrt.".to_string())?;
    let mut file = state.load()?;
    file.runs.retain(|item| item.run_id != run.run_id);
    file.runs.push(run);
    state.save(&file)
}
#[tauri::command]
pub fn artboard_agent_run_find_latest(
    key: SessionKey,
    state: tauri::State<'_, AgentRepositoryState>,
) -> Result<Option<AgentRun>, String> {
    validate_session_key(&key)?;
    let _guard = state
        .lock
        .lock()
        .map_err(|_| "Agentzustand ist gesperrt.".to_string())?;
    latest_run_for_key(&state.load()?, &key)
}
#[tauri::command]
pub fn artboard_agent_usage_save(
    usage: AgentUsage,
    state: tauri::State<'_, AgentRepositoryState>,
) -> Result<(), String> {
    if !valid_record_id(&usage.run_id)
        || usage.input_tokens.is_some_and(|v| v > 100_000_000)
        || usage.output_tokens.is_some_and(|v| v > 100_000_000)
        || usage.cost_microunits.is_some_and(|v| v > 100_000_000_000)
    {
        return Err("Ungültige Artboard-Agentnutzung.".into());
    }
    let _guard = state
        .lock
        .lock()
        .map_err(|_| "Agentzustand ist gesperrt.".to_string())?;
    let mut file = state.load()?;
    file.usage.retain(|item| item.run_id != usage.run_id);
    file.usage.push(usage);
    state.save(&file)
}

fn proposal_record_id(value: &Value) -> Option<&str> {
    value.as_object()?.get("proposalId")?.as_str()
}

fn validate_proposal(value: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    if bytes.len() > 512 * 1024 {
        return Err("Artboard-Agentvorschlag ist zu groß.".into());
    }
    let object = value
        .as_object()
        .ok_or("Artboard-Agentvorschlag muss ein Objekt sein.")?;
    let allowed = [
        "proposalId",
        "workspaceId",
        "branchId",
        "expectedRevisionId",
        "expectedRevisionNumber",
        "state",
        "operations",
        "imageGenerationIntents",
        "receipts",
        "createdAt",
        "updatedAt",
        "resolved",
    ];
    if object.keys().any(|key| !allowed.contains(&key.as_str()))
        || ![
            "proposalId",
            "workspaceId",
            "branchId",
            "expectedRevisionId",
        ]
        .iter()
        .all(|key| {
            object
                .get(*key)
                .and_then(Value::as_str)
                .is_some_and(valid_record_id)
        })
        || object
            .get("expectedRevisionNumber")
            .and_then(Value::as_i64)
            .is_none_or(|number| number < 0)
        || !object
            .get("state")
            .and_then(Value::as_str)
            .is_some_and(|state| matches!(state, "draft" | "frozen"))
        || object
            .get("operations")
            .and_then(Value::as_array)
            .is_none_or(|items| items.len() > 80)
        || object
            .get("imageGenerationIntents")
            .and_then(Value::as_array)
            .is_none_or(|items| items.len() > 24)
        || object
            .get("receipts")
            .and_then(Value::as_array)
            .is_none_or(|items| items.len() > 96)
        || object.get("state").and_then(Value::as_str) == Some("frozen")
            && !object.get("resolved").is_some_and(Value::is_object)
    {
        return Err("Artboard-Agentvorschlag ist ungültig.".into());
    }
    for operation in object["operations"].as_array().unwrap() {
        let operation = operation
            .as_object()
            .ok_or("Artboard-Agentoperation muss ein Objekt sein.")?;
        if serde_json::to_vec(operation)
            .map_err(|e| e.to_string())?
            .len()
            > 256 * 1024
        {
            return Err("Artboard-Agentoperation ist zu groß.".into());
        }
        let allowed_types = [
            "rename-board",
            "set-board-format",
            "set-board-paint",
            "update-layer",
            "set-layer-tree",
            "delete-layers",
            "reorder-layer",
            "create-board",
            "delete-board",
        ];
        let operation_type = operation
            .get("type")
            .and_then(Value::as_str)
            .filter(|kind| allowed_types.contains(kind))
            .ok_or("Artboard-Agentvorschlag enthält eine nicht freigegebene Operation.")?;
        if operation_type == "create-board" {
            let board = operation
                .get("board")
                .and_then(Value::as_object)
                .ok_or("Artboard-Agentvorschlag enthält ein ungültiges neues Board.")?;
            let placement = operation
                .get("placement")
                .and_then(Value::as_object)
                .ok_or("Artboard-Agentvorschlag enthält ein ungültiges neues Board.")?;
            if !exact_keys(
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
            ) || !exact_keys(placement, &["x", "y"])
                || !board
                    .get("id")
                    .and_then(Value::as_str)
                    .is_some_and(valid_record_id)
                || !placement
                    .get("x")
                    .and_then(Value::as_f64)
                    .is_some_and(f64::is_finite)
                || !placement
                    .get("y")
                    .and_then(Value::as_f64)
                    .is_some_and(f64::is_finite)
            {
                return Err("Artboard-Agentvorschlag enthält ein ungültiges neues Board.".into());
            }
        } else if operation_type == "delete-board" {
            if !exact_keys(operation, &["type", "boardId"])
                || !operation
                    .get("boardId")
                    .and_then(Value::as_str)
                    .is_some_and(valid_record_id)
            {
                return Err(
                    "Artboard-Agentvorschlag enthält eine ungültige Board-Entfernung.".into(),
                );
            }
        } else if !operation
            .get("boardId")
            .and_then(Value::as_str)
            .is_some_and(valid_record_id)
        {
            return Err(
                "Artboard-Agentvorschlag enthält eine nicht freigegebene Operation.".into(),
            );
        }
    }
    for intent in object["imageGenerationIntents"].as_array().unwrap() {
        let intent = intent
            .as_object()
            .ok_or("Bildgenerierungsabsicht muss ein Objekt sein.")?;
        if !exact_keys(
            intent,
            &[
                "id",
                "provider",
                "boardId",
                "prompt",
                "role",
                "aspectRatio",
                "referenceBindingIds",
                "requiresExplicitConfirmation",
            ],
        ) || !intent
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(valid_record_id)
            || intent.get("provider").and_then(Value::as_str) != Some("fal.ai")
            || !intent
                .get("boardId")
                .and_then(Value::as_str)
                .is_some_and(valid_record_id)
            || intent.get("requiresExplicitConfirmation") != Some(&Value::Bool(true))
            || intent
                .get("prompt")
                .and_then(Value::as_str)
                .is_none_or(|text| text.is_empty() || text.len() > 8_000)
            || intent
                .get("referenceBindingIds")
                .and_then(Value::as_array)
                .is_none_or(|ids| {
                    ids.len() > 20
                        || ids
                            .iter()
                            .any(|id| !id.as_str().is_some_and(valid_record_id))
                })
        {
            return Err(
                "Artboard-Agentvorschlag enthält eine ungültige Bildgenerierungsabsicht.".into(),
            );
        }
    }
    let mut receipt_ids = std::collections::HashSet::new();
    for receipt in object["receipts"].as_array().unwrap() {
        let receipt = receipt
            .as_object()
            .ok_or("Operationsbeleg muss ein Objekt sein.")?;
        let id = receipt.get("operationId").and_then(Value::as_str);
        if !exact_keys(receipt, &["operationId", "payloadFingerprint", "result"])
            || !id.is_some_and(valid_record_id)
            || !receipt_ids.insert(id.unwrap().to_string())
            || receipt
                .get("payloadFingerprint")
                .and_then(Value::as_str)
                .is_none_or(|value| value.len() > 64 * 1024)
        {
            return Err("Artboard-Agentvorschlag enthält ungültige Operationsbelege.".into());
        }
    }
    if object.get("state").and_then(Value::as_str) == Some("frozen") {
        let resolved = object["resolved"]
            .as_object()
            .ok_or("Aufgelöster Artboard-Agentvorschlag fehlt.")?;
        let batch = resolved
            .get("batch")
            .and_then(Value::as_object)
            .ok_or("Artboard-Agentbatch fehlt.")?;
        if resolved.get("proposalId") != object.get("proposalId")
            || batch.get("expectedRevisionId") != object.get("expectedRevisionId")
            || batch.get("expectedRevisionNumber") != object.get("expectedRevisionNumber")
            || batch.get("operations") != object.get("operations")
            || resolved.get("followUpIntents").unwrap_or(&json!([]))
                != object.get("imageGenerationIntents").unwrap()
        {
            return Err(
                "Aufgelöster Artboard-Agentvorschlag stimmt nicht mit seinem Entwurf überein."
                    .into(),
            );
        }
    } else if object.contains_key("resolved") {
        return Err("Ein offener Artboard-Agentvorschlag darf kein Ergebnis enthalten.".into());
    }
    Ok(())
}

fn proposal_array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value[key].as_array().map(Vec::as_slice).unwrap_or(&[])
}

fn validate_proposal_transition(previous: &Value, next: &Value) -> Result<(), String> {
    if previous == next {
        return Ok(());
    }
    if previous.get("state").and_then(Value::as_str) == Some("frozen") {
        return Err("Ein abgeschlossener Artboard-Vorschlag ist unveränderlich.".into());
    }
    for key in [
        "proposalId",
        "workspaceId",
        "branchId",
        "expectedRevisionId",
        "expectedRevisionNumber",
        "createdAt",
    ] {
        if previous.get(key) != next.get(key) {
            return Err(
                "Der Artboard-Vorschlag kollidiert mit einer neueren persistenten Version.".into(),
            );
        }
    }
    for key in ["operations", "imageGenerationIntents"] {
        let old = proposal_array(previous, key);
        let new = proposal_array(next, key);
        if new.len() < old.len() || new.get(..old.len()) != Some(old) {
            return Err(
                "Der Artboard-Vorschlag kollidiert mit einer neueren persistenten Version.".into(),
            );
        }
    }
    let old_receipts = proposal_array(previous, "receipts");
    let new_receipts = proposal_array(next, "receipts");
    if new_receipts.len() != old_receipts.len() + 1
        || new_receipts.get(..old_receipts.len()) != Some(old_receipts)
    {
        return Err(
            "Der Artboard-Vorschlag kollidiert mit einer neueren persistenten Version.".into(),
        );
    }
    Ok(())
}

#[tauri::command]
pub fn artboard_agent_proposal_find(
    proposal_id: String,
    state: tauri::State<'_, AgentRepositoryState>,
) -> Result<Option<Value>, String> {
    if !valid_record_id(&proposal_id) {
        return Err("Ungültige Proposal-ID.".into());
    }
    let _guard = state
        .lock
        .lock()
        .map_err(|_| "Agentzustand ist gesperrt.".to_string())?;
    let proposal = state
        .load()?
        .proposals
        .into_iter()
        .find(|item| proposal_record_id(item) == Some(proposal_id.as_str()));
    if let Some(value) = proposal.as_ref() {
        validate_proposal(value)?;
    }
    Ok(proposal)
}

#[tauri::command]
pub fn artboard_agent_proposal_save(
    proposal: Value,
    state: tauri::State<'_, AgentRepositoryState>,
) -> Result<(), String> {
    validate_proposal(&proposal)?;
    let id = proposal_record_id(&proposal)
        .ok_or("Proposal-ID fehlt.")?
        .to_string();
    let _guard = state
        .lock
        .lock()
        .map_err(|_| "Agentzustand ist gesperrt.".to_string())?;
    let mut file = state.load()?;
    if let Some(previous) = file
        .proposals
        .iter()
        .find(|item| proposal_record_id(item) == Some(id.as_str()))
    {
        validate_proposal(previous)?;
        validate_proposal_transition(previous, &proposal)?;
    }
    file.proposals
        .retain(|item| proposal_record_id(item) != Some(id.as_str()));
    file.proposals.push(proposal);
    state.save(&file)
}

#[tauri::command]
pub fn artboard_agent_proposal_delete(
    proposal_id: String,
    state: tauri::State<'_, AgentRepositoryState>,
) -> Result<(), String> {
    if !valid_record_id(&proposal_id) {
        return Err("Ungültige Proposal-ID.".into());
    }
    let _guard = state
        .lock
        .lock()
        .map_err(|_| "Agentzustand ist gesperrt.".to_string())?;
    let mut file = state.load()?;
    if file
        .proposals
        .iter()
        .find(|item| proposal_record_id(item) == Some(proposal_id.as_str()))
        .and_then(|item| item.get("state"))
        .and_then(Value::as_str)
        == Some("frozen")
    {
        return Err("Ein abgeschlossener Artboard-Vorschlag ist unveränderlich.".into());
    }
    file.proposals
        .retain(|item| proposal_record_id(item) != Some(proposal_id.as_str()));
    state.save(&file)
}

#[tauri::command]
pub async fn codex_agent_start(
    app: AppHandle,
    state: tauri::State<'_, CodexAppServerState>,
) -> Result<(), String> {
    state.spawn(&app)?;
    let state_copy = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state_copy.request_blocking("initialize", json!({"clientInfo":{"name":"flowz_artboard","title":"FlowZ Artboard","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}}))?;
        state_copy.write(&json!({"method":"initialized","params":{}}))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn codex_agent_request(
    request: RpcRequest,
    state: tauri::State<'_, CodexAppServerState>,
) -> Result<Value, String> {
    validate_codex_rpc_request(&request, &state.app_data)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.request_blocking(&request.method, request.params)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn codex_agent_respond(
    response: RpcResponse,
    state: tauri::State<'_, CodexAppServerState>,
) -> Result<(), String> {
    if !response.id.is_string() && !response.id.is_number() {
        return Err("Ungültige Codex-RPC-Antwort-ID.".into());
    }
    validate_codex_tool_response(&response.result)?;
    let key = serde_json::to_string(&response.id)
        .map_err(|_| "Ungültige Codex-RPC-Antwort-ID.".to_string())?;
    let registered = state
        .server_requests
        .lock()
        .map_err(|_| "Codex-Serveranfragensperre ist beschädigt.".to_string())?
        .remove(&key);
    if registered.as_deref() != Some("item/tool/call") {
        return Err(
            "Diese Codex-Serveranfrage ist nicht als Dynamic-Tool-Aufruf registriert.".into(),
        );
    }
    state.write(&json!({"id":response.id,"result":response.result}))
}

#[tauri::command]
pub fn codex_agent_scratch(
    workspace_id: String,
    state: tauri::State<'_, CodexAppServerState>,
) -> Result<ScratchDirectory, String> {
    if workspace_id.is_empty()
        || workspace_id.len() > 128
        || !workspace_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._:-".contains(c))
    {
        return Err("Ungültige Workspace-ID.".into());
    }
    let root = state
        .app_data
        .join("artboard-agent-scratch")
        .join(workspace_id);
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(ScratchDirectory {
        path: root.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn codex_agent_close(state: tauri::State<'_, CodexAppServerState>) -> Result<(), String> {
    if let Some(mut process) = state
        .process
        .lock()
        .map_err(|_| "Codex-Prozesssperre ist beschädigt.".to_string())?
        .take()
    {
        let _ = process.child.kill();
        let _ = process.child.wait();
    }
    if let Ok(mut pending) = state.pending.lock() {
        pending.clear();
    }
    if let Ok(mut pending) = state.server_requests.lock() {
        pending.clear();
    }
    Ok(())
}

const ARTBOARD_TOOLS: &[&str] = &[
    "get_workspace_info",
    "get_selection",
    "get_board",
    "get_layer_tree",
    "get_layers",
    "get_bound_inputs",
    "render_preview",
    "create_board",
    "duplicate_board_as_variant",
    "delete_board",
    "create_layers",
    "update_layers",
    "delete_layers",
    "duplicate_layers",
    "reorder_layers",
    "set_board_properties",
    "bind_layer_resource",
    "propose_image_generation",
    "finish_working",
];

fn validate_openrouter_body(body: &Value) -> Result<(), String> {
    let object = body
        .as_object()
        .ok_or("OpenRouter-Agentbody muss ein Objekt sein.")?;
    if object.keys().any(|key| {
        ![
            "model",
            "messages",
            "tools",
            "tool_choice",
            "parallel_tool_calls",
            "reasoning",
            "stream",
            "usage",
        ]
        .contains(&key.as_str())
    }) {
        return Err("OpenRouter-Agentbody enthält unbekannte Parameter.".into());
    }
    let model = object.get("model").and_then(Value::as_str).unwrap_or("");
    if model.is_empty() || model.len() > 200 {
        return Err("Ungültiges OpenRouter-Modell.".into());
    }
    let messages = object
        .get("messages")
        .and_then(Value::as_array)
        .ok_or("OpenRouter-Agentnachrichten fehlen.")?;
    if messages.is_empty()
        || messages.len() > 64
        || serde_json::to_vec(messages)
            .map_err(|e| e.to_string())?
            .len()
            > 512 * 1024
    {
        return Err("OpenRouter-Agentkontext ist zu groß.".into());
    }
    let tools = object
        .get("tools")
        .and_then(Value::as_array)
        .ok_or("Artboard-Tools fehlen.")?;
    if tools.len() != ARTBOARD_TOOLS.len() {
        return Err("Es müssen exakt die freigegebenen Artboard-Tools gesendet werden.".into());
    }
    let mut names = tools
        .iter()
        .map(|tool| {
            let object = tool
                .as_object()
                .ok_or("Ungültige OpenRouter-Tooldefinition.")?;
            if !exact_keys(object, &["type", "function"])
                || object.get("type").and_then(Value::as_str) != Some("function")
            {
                return Err("Ungültige OpenRouter-Tooldefinition.".to_string());
            }
            let function = object
                .get("function")
                .and_then(Value::as_object)
                .ok_or("Ungültige OpenRouter-Funktion.")?;
            if !exact_keys(function, &["name", "description", "parameters"])
                || !function
                    .get("description")
                    .and_then(Value::as_str)
                    .is_some_and(|value| !value.is_empty() && value.len() <= 500)
                || !function.get("parameters").is_some_and(Value::is_object)
            {
                return Err("Ungültige OpenRouter-Funktion.".to_string());
            }
            function
                .get("name")
                .and_then(Value::as_str)
                .ok_or("OpenRouter-Toolname fehlt.".to_string())
        })
        .collect::<Result<Vec<_>, String>>()?;
    names.sort_unstable();
    let mut expected = ARTBOARD_TOOLS.to_vec();
    expected.sort_unstable();
    if names != expected {
        return Err("OpenRouter erhielt nicht exakt die freigegebenen Artboard-Tools.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn openrouter_artboard_step(
    request: OpenRouterStepRequest,
    app: AppHandle,
    state: tauri::State<'_, OpenRouterArtboardState>,
) -> Result<(), String> {
    if !valid_record_id(&request.run_id) || request.run_id.len() > 128 {
        return Err("Ungültige Agentlauf-ID.".into());
    }
    validate_openrouter_body(&request.body)?;
    let token = CancellationToken::new();
    {
        let mut runs = state
            .0
            .lock()
            .map_err(|_| "OpenRouter-Abbruchsperre ist beschädigt.".to_string())?;
        if runs.contains_key(&request.run_id) {
            return Err("Für diese Agentlauf-ID läuft bereits eine OpenRouter-Anfrage.".into());
        }
        runs.insert(request.run_id.clone(), token.clone());
    }
    let run_id = request.run_id;
    let result = async {
        let mut body = request.body;
        body["stream"] = Value::Bool(true);
        body["usage"] = json!({"include":true});
        let response = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|e| e.to_string())?
            .post("https://openrouter.ai/api/v1/chat/completions")
            .bearer_auth(super::api_key()?)
            .header("HTTP-Referer", "https://flowz.dev")
            .header("X-Title", "FlowZ Artboard")
            .json(&body)
            .send().await.map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(format!("OpenRouter-Agentanfrage fehlgeschlagen ({status}): {}", text.chars().take(400).collect::<String>()));
        }
        let mut stream = response.bytes_stream().eventsource();
        while let Some(event) = tokio::select! { _ = token.cancelled() => { return Err("OPENROUTER_CANCELLED".into()) }, item = stream.next() => item } {
            let event = event.map_err(|e| e.to_string())?;
            if event.data == "[DONE]" { break; }
            if event.data.len() > 256 * 1024 { return Err("OpenRouter-Streamchunk ist zu groß.".into()); }
            let chunk: Value = serde_json::from_str(&event.data).map_err(|_| "OpenRouter lieferte ungültiges Stream-JSON.".to_string())?;
            app.emit("openrouter-artboard-chunk", json!({"runId":run_id,"chunk":chunk})).map_err(|e| e.to_string())?;
        }
        Ok(())
    }.await;
    state.0.lock().ok().map(|mut runs| runs.remove(&run_id));
    result
}

#[tauri::command]
pub fn openrouter_artboard_cancel(
    run_id: String,
    state: tauri::State<'_, OpenRouterArtboardState>,
) -> bool {
    state
        .0
        .lock()
        .ok()
        .and_then(|runs| runs.get(&run_id).cloned())
        .is_some_and(|token| {
            token.cancel();
            true
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_session(conversation_id: &str, provider_session_id: &str) -> AgentSession {
        AgentSession {
            workspace_id: "workspace-1".into(),
            branch_id: "branch-main".into(),
            conversation_id: conversation_id.into(),
            provider: "openrouter".into(),
            tool_contract_version: ARTBOARD_TOOL_CONTRACT_VERSION.into(),
            provider_session_id: provider_session_id.into(),
            model_id: "model-1".into(),
            reasoning_effort: None,
            last_turn_id: None,
            manual_context_checkpoint: None,
        }
    }

    fn test_run(
        run_id: &str,
        conversation_id: &str,
        submitted_at: &str,
        state: &str,
        proposal_id: Option<&str>,
    ) -> AgentRun {
        AgentRun {
            run_id: run_id.into(),
            workspace_id: "workspace-1".into(),
            branch_id: "branch-main".into(),
            conversation_id: conversation_id.into(),
            provider: "openrouter".into(),
            tool_contract_version: ARTBOARD_TOOL_CONTRACT_VERSION.into(),
            provider_session_id: format!("provider-{conversation_id}"),
            provider_turn_id: Some(format!("turn-{run_id}")),
            model_id: "model-1".into(),
            reasoning_effort: None,
            input_revision: 1,
            selected_board_revision_ids: Vec::new(),
            state: state.into(),
            submitted_at: submitted_at.into(),
            proposal_id: proposal_id.map(str::to_owned),
            error: None,
        }
    }

    #[test]
    fn openrouter_body_requires_exact_artboard_tool_surface() {
        let tools = ARTBOARD_TOOLS.iter().map(|name| json!({"type":"function","function":{"name":name,"description":"Bounded Artboard tool.","parameters":{"type":"object"}}})).collect::<Vec<_>>();
        let valid = json!({"model":"provider/model","messages":[{"role":"user","content":"x"}],"tools":tools,"stream":true,"usage":{"include":true}});
        assert!(validate_openrouter_body(&valid).is_ok());
        let mut invalid = valid.clone();
        invalid["tools"]
            .as_array_mut()
            .unwrap()
            .push(json!({"type":"function","function":{"name":"shell"}}));
        assert!(validate_openrouter_body(&invalid)
            .unwrap_err()
            .contains("exakt"));
        let mut extra = valid;
        extra["plugins"] = json!([{"id":"web"}]);
        assert!(validate_openrouter_body(&extra)
            .unwrap_err()
            .contains("unbekannte"));
    }

    #[test]
    fn codex_rpc_rejects_escalation_and_accepts_bounded_turn() {
        let temporary = tempfile::tempdir().unwrap();
        let safe = RpcRequest {
            method: "turn/start".into(),
            params: json!({
                "threadId":"thread-1", "model":"gpt-test", "effort":null,
                "approvalPolicy":"never", "sandboxPolicy":{"type":"readOnly","networkAccess":false},
                "input":[{"type":"text","text":"Create a proposal"}]
            }),
        };
        assert!(validate_codex_rpc_request(&safe, temporary.path()).is_ok());
        let mut escalated = safe.params.clone();
        escalated["sandboxPolicy"] = json!({"type":"dangerFullAccess"});
        assert!(validate_codex_rpc_request(
            &RpcRequest {
                method: "turn/start".into(),
                params: escalated
            },
            temporary.path()
        )
        .unwrap_err()
        .contains("Unsichere"));
        assert!(validate_codex_rpc_request(
            &RpcRequest {
                method: "thread/shellCommand".into(),
                params: json!({})
            },
            temporary.path()
        )
        .is_err());
        assert!(validate_codex_rpc_request(
            &RpcRequest {
                method: "thread/resume".into(),
                params: json!({"threadId":"thread-from-another-surface"})
            },
            temporary.path()
        )
        .is_err());
    }

    #[test]
    fn codex_tool_response_accepts_only_bounded_local_preview_images() {
        assert!(validate_codex_tool_response(
            &json!({"contentItems":[{"type":"inputText","text":"{\"ok\":true}"}],"success":true})
        )
        .is_ok());
        assert!(validate_codex_tool_response(&json!({"contentItems":[{"type":"inputText","text":"{\"preview\":true}"},{"type":"inputImage","imageUrl":"data:image/png;base64,iVBORw0KGgo="}],"success":true})).is_ok());
        assert!(validate_codex_tool_response(&json!({"contentItems":[{"type":"inputText","text":"x"},{"type":"inputImage","imageUrl":"https://example.com/x"}],"success":true})).is_err());
        assert!(validate_codex_tool_response(
            &json!({"contentItems":[],"success":true,"token":"secret"})
        )
        .is_err());
    }

    #[test]
    fn agent_repository_roundtrips_without_credentials() {
        let temporary = tempfile::tempdir().unwrap();
        let repository = AgentRepositoryState::new(temporary.path());
        let session = test_session("conversation-1", "session-1");
        validate_session(&session).unwrap();
        let mut file = repository.load().unwrap();
        file.sessions.push(session);
        repository.save(&file).unwrap();
        let bytes = fs::read(&repository.path).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("sk-or-"));
        assert_eq!(repository.load().unwrap().sessions.len(), 1);
    }

    #[test]
    fn agent_sessions_are_isolated_by_bounded_conversation_id() {
        let mut file = AgentRepositoryFile::default();
        let mut first = test_session("conversation-1", "provider-session-1");
        first.last_turn_id = Some("turn-1".into());
        let mut second = test_session("conversation-2", "provider-session-2");
        second.last_turn_id = Some("turn-2".into());
        upsert_session(&mut file, first);
        upsert_session(&mut file, second);

        assert_eq!(file.sessions.len(), 2);
        let key = SessionKey {
            workspace_id: "workspace-1".into(),
            branch_id: "branch-main".into(),
            conversation_id: "conversation-2".into(),
            provider: "openrouter".into(),
            tool_contract_version: ARTBOARD_TOOL_CONTRACT_VERSION.into(),
        };
        validate_session_key(&key).unwrap();
        let found = file
            .sessions
            .iter()
            .find(|session| session_matches_key(session, &key))
            .unwrap();
        assert_eq!(found.provider_session_id, "provider-session-2");
        assert_eq!(found.last_turn_id.as_deref(), Some("turn-2"));

        let replacement = test_session("conversation-2", "provider-session-2b");
        upsert_session(&mut file, replacement);
        assert_eq!(file.sessions.len(), 2);
        assert!(file
            .sessions
            .iter()
            .any(|session| session.provider_session_id == "provider-session-1"));
        assert!(file
            .sessions
            .iter()
            .any(|session| session.provider_session_id == "provider-session-2b"));

        for invalid in ["", "contains/slash"] {
            let invalid = test_session(invalid, "provider-session");
            assert!(validate_session(&invalid).is_err());
        }
        assert!(validate_session(&test_session(&"x".repeat(129), "provider-session")).is_err());
    }

    #[test]
    fn latest_run_returns_proposal_ready_run_for_exact_conversation_only() {
        let key = SessionKey {
            workspace_id: "workspace-1".into(),
            branch_id: "branch-main".into(),
            conversation_id: "conversation-1".into(),
            provider: "openrouter".into(),
            tool_contract_version: ARTBOARD_TOOL_CONTRACT_VERSION.into(),
        };
        let mut file = AgentRepositoryFile::default();
        file.runs.push(test_run(
            "run-old",
            "conversation-1",
            "2026-07-12T10:00:00Z",
            "failed",
            None,
        ));
        file.runs.push(test_run(
            "run-ready",
            "conversation-1",
            "2026-07-12T11:00:00Z",
            "proposal-ready",
            Some("proposal-1"),
        ));
        file.runs.push(test_run(
            "run-other-chat",
            "conversation-2",
            "2026-07-13T12:00:00Z",
            "proposal-ready",
            Some("proposal-other"),
        ));

        let latest = latest_run_for_key(&file, &key).unwrap().unwrap();
        assert_eq!(latest.run_id, "run-ready");
        assert_eq!(latest.state, "proposal-ready");
        assert_eq!(latest.proposal_id.as_deref(), Some("proposal-1"));

        let other_key = SessionKey {
            conversation_id: "conversation-2".into(),
            ..key
        };
        let other = latest_run_for_key(&file, &other_key).unwrap().unwrap();
        assert_eq!(other.run_id, "run-other-chat");
    }

    #[test]
    fn run_repository_accepts_only_known_states_including_terminal_review_outcomes() {
        for state in ["applied", "rejected"] {
            assert!(validate_run(&test_run(
                "run-terminal",
                "conversation-1",
                "2026-07-12T11:00:00Z",
                state,
                Some("proposal-1")
            ))
            .is_ok());
        }
        assert!(validate_run(&test_run(
            "run-invalid",
            "conversation-1",
            "2026-07-12T11:00:00Z",
            "silently-resubmit",
            None
        ))
        .is_err());
    }

    #[test]
    fn latest_run_uses_persisted_run_order_for_equal_submission_times() {
        let key = SessionKey {
            workspace_id: "workspace-1".into(),
            branch_id: "branch-main".into(),
            conversation_id: "conversation-1".into(),
            provider: "openrouter".into(),
            tool_contract_version: ARTBOARD_TOOL_CONTRACT_VERSION.into(),
        };
        let submitted_at = "2026-07-12T11:00:00Z";
        let mut file = AgentRepositoryFile::default();
        file.runs.push(test_run(
            "run-first",
            "conversation-1",
            submitted_at,
            "failed",
            None,
        ));
        file.runs.push(test_run(
            "run-second",
            "conversation-1",
            submitted_at,
            "proposal-ready",
            Some("proposal-2"),
        ));

        assert_eq!(
            latest_run_for_key(&file, &key).unwrap().unwrap().run_id,
            "run-second"
        );
    }

    #[test]
    fn legacy_single_chat_session_gets_stable_default_conversation() {
        let raw = json!({
            "sessions": [{
                "workspaceId": "workspace-1",
                "branchId": "branch-main",
                "provider": "openrouter",
                "toolContractVersion": ARTBOARD_TOOL_CONTRACT_VERSION,
                "providerSessionId": "legacy-provider-session",
                "modelId": "model-1",
                "reasoningEffort": null,
                "lastTurnId": "legacy-turn"
            }],
            "runs": [{
                "runId": "legacy-run",
                "workspaceId": "workspace-1",
                "branchId": "branch-main",
                "provider": "openrouter",
                "toolContractVersion": ARTBOARD_TOOL_CONTRACT_VERSION,
                "providerSessionId": "legacy-provider-session",
                "providerTurnId": "legacy-turn",
                "modelId": "model-1",
                "reasoningEffort": null,
                "inputRevision": 1,
                "selectedBoardRevisionIds": [],
                "state": "failed",
                "submittedAt": "2026-07-12T10:00:00Z",
                "proposalId": null,
                "error": null
            }],
            "usage": [],
            "proposals": []
        });
        let migrated: AgentRepositoryFile = serde_json::from_value(raw).unwrap();
        assert_eq!(migrated.sessions[0].conversation_id, LEGACY_CONVERSATION_ID);
        assert_eq!(migrated.runs[0].conversation_id, LEGACY_CONVERSATION_ID);
        assert_eq!(
            migrated.sessions[0].provider_session_id,
            "legacy-provider-session"
        );
        assert_eq!(
            migrated.sessions[0].last_turn_id.as_deref(),
            Some("legacy-turn")
        );
        validate_session(&migrated.sessions[0]).unwrap();
        validate_run(&migrated.runs[0]).unwrap();

        let serialized = serde_json::to_value(migrated).unwrap();
        assert_eq!(
            serialized["sessions"][0]["conversationId"],
            LEGACY_CONVERSATION_ID
        );
    }

    #[test]
    fn proposal_repository_roundtrips_frozen_restart_state_and_rejects_oversize() {
        let temporary = tempfile::tempdir().unwrap();
        let repository = AgentRepositoryState::new(temporary.path());
        let proposal = json!({
            "proposalId":"proposal-1","workspaceId":"workspace-1","branchId":"branch-main",
            "expectedRevisionId":"revision-4","expectedRevisionNumber":4,"state":"frozen",
            "operations":[],"imageGenerationIntents":[],"receipts":[],
            "createdAt":"2026-07-12T12:00:00.000Z","updatedAt":"2026-07-12T12:00:01.000Z",
            "resolved":{"proposalId":"proposal-1","summary":"Fertig","batch":{"operationId":"apply-1","expectedRevisionId":"revision-4","expectedRevisionNumber":4,"operations":[]},"changes":[]}
        });
        validate_proposal(&proposal).unwrap();
        let mut file = repository.load().unwrap();
        file.proposals.push(proposal.clone());
        repository.save(&file).unwrap();
        let restarted = AgentRepositoryState::new(temporary.path()).load().unwrap();
        assert_eq!(
            proposal_record_id(&restarted.proposals[0]),
            Some("proposal-1")
        );
        let mut too_many = proposal.clone();
        too_many["operations"] = Value::Array(vec![json!({}); 81]);
        assert!(validate_proposal(&too_many).is_err());
        let mut changed = proposal.clone();
        changed["updatedAt"] = json!("2026-07-12T12:00:02.000Z");
        assert!(validate_proposal_transition(&proposal, &changed).is_err());
        assert_eq!(ARTBOARD_TOOLS.len(), 19);
        let unique = ARTBOARD_TOOLS
            .iter()
            .copied()
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(unique.len(), ARTBOARD_TOOLS.len());
    }

    #[test]
    fn proposal_validator_accepts_empty_story_board_created_beside_square_board() {
        let operation = json!({
            "type":"create-board",
            "board":{
                "id":"board-agent-story",
                "name":"Story-Variante",
                "activeRevisionId":"revision-story",
                "document":{
                    "schemaVersion":1,
                    "id":"document-story",
                    "name":"Story-Variante",
                    "format":{"preset":"instagram-story","width":1080,"height":1920},
                    "paint":{"kind":"solid","color":"#FFFFFF"},
                    "rootLayerIds":[],
                    "layers":{},
                    "bindings":{},
                    "tokenRefs":{}
                },
                "inputSnapshot":{
                    "id":"snapshot-story",
                    "createdAt":"2026-07-12T12:00:00.000Z",
                    "bindings":{}
                },
                "ancestry":{"branchId":"branch-main"},
                "createdAt":"2026-07-12T12:00:00.000Z"
            },
            "placement":{"x":1208,"y":64}
        });
        let proposal = json!({
            "proposalId":"proposal-story","workspaceId":"workspace-1","branchId":"branch-main",
            "expectedRevisionId":"revision-4","expectedRevisionNumber":4,"state":"frozen",
            "operations":[operation.clone()],"imageGenerationIntents":[],"receipts":[],
            "createdAt":"2026-07-12T12:00:00.000Z","updatedAt":"2026-07-12T12:00:01.000Z",
            "resolved":{
                "proposalId":"proposal-story","summary":"Story-Artboard neben dem quadratischen Ausgangsboard erstellt.",
                "batch":{"operationId":"apply-story","expectedRevisionId":"revision-4","expectedRevisionNumber":4,"operations":[operation]},
                "changes":[{"id":"board:board-agent-story","label":"Story-Variante","kind":"add"}]
            }
        });

        validate_proposal(&proposal).unwrap();

        let mut unexpected_board_field = proposal.clone();
        unexpected_board_field["operations"][0]["board"]["legacy"] = json!(true);
        unexpected_board_field["resolved"]["batch"]["operations"] =
            unexpected_board_field["operations"].clone();
        assert!(validate_proposal(&unexpected_board_field)
            .unwrap_err()
            .contains("ungültiges neues Board"));

        let mut board_id_instead_of_board = proposal;
        board_id_instead_of_board["operations"][0] =
            json!({"type":"create-board","boardId":"board-agent-story"});
        board_id_instead_of_board["resolved"]["batch"]["operations"] =
            board_id_instead_of_board["operations"].clone();
        assert!(validate_proposal(&board_id_instead_of_board)
            .unwrap_err()
            .contains("ungültiges neues Board"));
    }

    #[test]
    fn proposal_validator_accepts_exact_whole_board_removal() {
        let operation = json!({"type":"delete-board","boardId":"board-2"});
        let proposal = json!({
            "proposalId":"proposal-remove","workspaceId":"workspace-1","branchId":"branch-main",
            "expectedRevisionId":"revision-4","expectedRevisionNumber":4,"state":"frozen",
            "operations":[operation.clone()],"imageGenerationIntents":[],"receipts":[],
            "createdAt":"2026-07-12T12:00:00.000Z","updatedAt":"2026-07-12T12:00:01.000Z",
            "resolved":{
                "proposalId":"proposal-remove","summary":"Artboard entfernen.",
                "batch":{"operationId":"apply-remove","expectedRevisionId":"revision-4","expectedRevisionNumber":4,"operations":[operation]},
                "changes":[{"id":"board:board-2","label":"Artboard entfernen","kind":"remove"}]
            }
        });
        validate_proposal(&proposal).unwrap();
        let mut unknown = proposal;
        unknown["operations"][0]["force"] = json!(true);
        unknown["resolved"]["batch"]["operations"] = unknown["operations"].clone();
        assert!(validate_proposal(&unknown).is_err());
    }
}
