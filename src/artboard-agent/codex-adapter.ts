import { ARTBOARD_AGENT_TOOL_CONTRACT_VERSION, validateToolInvocation, type ToolBudget } from "./tool-contract";
import { ARTBOARD_AGENT_TOOL_SPECS } from "./tool-specs";
import type { ArtboardAgentRepository } from "./repository";
import type { AgentEvent, AgentProviderStatus, AgentRunSnapshot, ArtboardAgentAdapter, ArtboardAgentModel, ArtboardAgentToolExecutor, AgentSessionKey, PersistedAgentSession } from "./types";

export type CodexServerEvent =
  | { method: "turn/started"; params: { threadId: string; turn: { id: string } } }
  | { method: "item/agentMessage/delta"; params: { threadId: string; turnId: string; delta: string } }
  | { method: "item/tool/call"; id: string | number; params: { callId: string; threadId: string; turnId: string; tool: string; arguments: unknown } }
  | { method: "item/started"; params: { threadId: string; turnId: string; item: { type: string } } }
  | { method: "turn/completed"; params: { threadId: string; turn: { id: string; status: "completed" | "interrupted" | "failed"; error?: { message?: string } } } }
  | { method: "process/lost"; params?: Record<string, never> };

export interface CodexAppServerTransport {
  start(): Promise<void>;
  request<T>(method: string, params: Record<string, unknown>): Promise<T>;
  respond(id: string | number, result: unknown): Promise<void>;
  subscribe(listener: (event: CodexServerEvent) => void): () => void;
  scratchDirectory(workspaceId: string): Promise<string>;
  close(): Promise<void>;
}

const CODEX_INSTRUCTIONS = "You are FlowZ's Artboard design agent. Use only the supplied dynamic Artboard tools. Read bounded state, then create proposal operations. Never use shell, files, URLs, web, MCP, apps, skills, or built-in tools. Never claim that a proposal is applied. Finish only after finish_working.";

export class CodexLocalArtboardAgentAdapter implements ArtboardAgentAdapter {
  readonly provider = "codex-local" as const;
  private active = new Map<string, { threadId: string; turnId?: string }>();
  constructor(private readonly transport: CodexAppServerTransport, private readonly repository: ArtboardAgentRepository, private readonly executor: ArtboardAgentToolExecutor) {}
  private async ready() { await this.transport.start(); }
  private async secureThreadParameters(workspaceId: string, modelId: string) {
    const cwd = await this.transport.scratchDirectory(workspaceId);
    return { model: modelId, cwd, approvalPolicy: "never", sandbox: "read-only", config: { sandbox_policy: { type: "readOnly", networkAccess: false }, mcp_servers: {}, web_search: "disabled", features: { apps: false, plugins: false, shell_tool: false, unified_exec: false, browser_use: false, browser_use_external: false, browser_use_full_cdp_access: false, in_app_browser: false, computer_use: false, image_generation: false, multi_agent: false, workspace_dependencies: false, code_mode_host: false, tool_suggest: false, skill_mcp_dependency_install: false, remote_plugin: false, plugin_sharing: false, auth_elicitation: false, enable_mcp_apps: false } }, developerInstructions: CODEX_INSTRUCTIONS, dynamicTools: ARTBOARD_AGENT_TOOL_SPECS.map((tool) => ({ type: "function", name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) };
  }
  async probe(): Promise<AgentProviderStatus> {
    try { await this.ready(); const value = await this.transport.request<{ account: null | { type: string; email?: string }; requiresOpenaiAuth: boolean }>("account/read", { refreshToken: false });
      return value.account ? { state: "ready", accountLabel: value.account.email } : value.requiresOpenaiAuth ? { state: "auth-required" } : { state: "unavailable", reason: "Kein lokales Codex-Konto aktiv." };
    } catch (error) { return { state: "unavailable", reason: error instanceof Error ? error.message : String(error) }; }
  }
  async listModels(): Promise<ArtboardAgentModel[]> {
    await this.ready(); const result = await this.transport.request<{ data: { id: string; displayName?: string; hidden?: boolean; supportedReasoningEfforts?: { reasoningEffort: string; isDefault?: boolean }[]; inputModalities?: string[] }[] }>("model/list", { includeHidden: false });
    return result.data.map((model) => ({ provider: this.provider, id: model.id, name: model.displayName ?? model.id, hidden: model.hidden, inputModalities: model.inputModalities?.includes("image") ? ["text", "image"] : ["text"], reasoningEfforts: model.supportedReasoningEfforts?.map((item) => item.reasoningEffort), defaultReasoningEffort: model.supportedReasoningEfforts?.find((item) => item.isDefault)?.reasoningEffort }));
  }
  async openSession(input: AgentSessionKey & { modelId: string; reasoningEffort?: string; previousProviderSessionId?: string }): Promise<PersistedAgentSession> {
    await this.ready(); const previous = input.previousProviderSessionId ?? (await this.repository.findSession(input))?.providerSessionId; const security = await this.secureThreadParameters(input.workspaceId, input.modelId);
    const response = previous
      ? await this.transport.request<{ thread: { id: string } }>("thread/resume", { threadId: previous, ...security })
      : await this.transport.request<{ thread: { id: string } }>("thread/start", { ...security, serviceName: "flowz_artboard" });
    const session = { ...input, providerSessionId: response.thread.id }; await this.repository.saveSession(session); return session;
  }
  async runTurn(input: AgentRunSnapshot, userText: string, onEvent: (event: AgentEvent) => void): Promise<{ providerTurnId: string }> {
    if (input.provider !== this.provider || input.toolContractVersion !== ARTBOARD_AGENT_TOOL_CONTRACT_VERSION) throw new Error("Inkompatibler lokaler Codex-Agentlauf.");
    if ([...this.active.values()].some((active) => active.threadId === input.providerSessionId)) throw new Error("In dieser Artboard-Session läuft bereits ein Codex-Turn.");
    await this.ready(); let budget: ToolBudget = { calls: 0, mutations: 0 }; let proposalId: string | undefined; let settled = false;
    await this.repository.saveRun({ ...input, state: "submitting" }); onEvent({ type: "status", status: "submitting" });
    return await new Promise<{ providerTurnId: string }>(async (resolve, reject) => {
      const finish = async (snapshot: AgentRunSnapshot, outcome: { type: "resolve"; providerTurnId: string } | { type: "reject"; error: Error }) => {
        try { await this.repository.saveRun(snapshot); }
        catch (error) { reject(error); return; }
        if (outcome.type === "resolve") resolve({ providerTurnId: outcome.providerTurnId }); else reject(outcome.error);
      };
      const unsubscribe = this.transport.subscribe((event) => {
        if (event.method === "process/lost") { if (!settled) { settled = true; unsubscribe(); this.active.delete(input.runId); void finish({ ...input, state: "process-lost", error: "Codex App Server wurde beendet." }, { type: "reject", error: new Error("CODEX_PROCESS_LOST") }); } return; }
        if (event.method === "item/started" && event.params.threadId === input.providerSessionId && this.active.get(input.runId)?.turnId === event.params.turnId && ["commandExecution", "fileChange", "mcpToolCall", "webSearch", "imageView"].includes(event.params.item.type)) { const active = this.active.get(input.runId); if (active?.turnId) void this.transport.request("turn/interrupt", { threadId: active.threadId, turnId: active.turnId }); return; }
        if (event.method === "turn/started" && event.params.threadId === input.providerSessionId && this.active.has(input.runId) && (!this.active.get(input.runId)?.turnId || this.active.get(input.runId)?.turnId === event.params.turn.id)) { this.active.set(input.runId, { threadId: input.providerSessionId, turnId: event.params.turn.id }); onEvent({ type: "provider-turn-started", providerTurnId: event.params.turn.id }); onEvent({ type: "status", status: "streaming" }); }
        else if (event.method === "item/agentMessage/delta" && event.params.threadId === input.providerSessionId && this.active.get(input.runId)?.turnId === event.params.turnId) onEvent({ type: "text-delta", text: event.params.delta });
        else if (event.method === "item/tool/call" && event.params.threadId === input.providerSessionId && this.active.get(input.runId)?.turnId === event.params.turnId) {
          void (async () => { try { const checked = validateToolInvocation({ tool: event.params.tool, arguments: event.params.arguments }, budget); budget = checked.nextBudget; const operationId = typeof checked.invocation.arguments.operationId === "string" ? checked.invocation.arguments.operationId : event.params.callId; onEvent({ type: "tool-started", tool: checked.invocation.tool, operationId }); const result = await this.executor.execute(checked.invocation); proposalId = result.proposalId ?? proposalId; await this.transport.respond(event.id, { contentItems: [{ type: "inputText", text: JSON.stringify(result.content) }], success: true }); onEvent({ type: "tool-completed", tool: checked.invocation.tool, operationId, success: true }); if (result.proposalId) onEvent({ type: "proposal-updated", proposalId: result.proposalId }); } catch (error) { await this.transport.respond(event.id, { contentItems: [{ type: "inputText", text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }], success: false }); } })();
        } else if (event.method === "turn/completed" && event.params.threadId === input.providerSessionId && this.active.get(input.runId)?.turnId === event.params.turn.id && !settled) {
          settled = true; unsubscribe(); this.active.delete(input.runId);
          if (event.params.turn.status === "interrupted") { onEvent({ type: "interrupted" }); void finish({ ...input, providerTurnId: event.params.turn.id, state: "interrupted" }, { type: "reject", error: new Error("CODEX_INTERRUPTED") }); }
          else if (event.params.turn.status === "failed" || !proposalId) { const message = event.params.turn.error?.message ?? "Der lokale Design-Agent hat keinen Vorschlag erzeugt."; onEvent({ type: "failed", error: message }); void finish({ ...input, providerTurnId: event.params.turn.id, state: "failed", error: message }, { type: "reject", error: new Error(message) }); }
          else { onEvent({ type: "status", status: "finalizing" }); onEvent({ type: "completed", proposalId }); void finish({ ...input, providerTurnId: event.params.turn.id, proposalId, state: "proposal-ready" }, { type: "resolve", providerTurnId: event.params.turn.id }); }
        }
      });
      try { this.active.set(input.runId, { threadId: input.providerSessionId }); const result = await this.transport.request<{ turn: { id: string } }>("turn/start", { threadId: input.providerSessionId, model: input.modelId, effort: input.reasoningEffort, approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false }, input: [{ type: "text", text: userText }] }); const announced = this.active.get(input.runId)?.turnId; if (announced && announced !== result.turn.id) throw new Error("Codex lieferte widersprüchliche Turn-IDs."); if (!announced) { this.active.set(input.runId, { threadId: input.providerSessionId, turnId: result.turn.id }); onEvent({ type: "provider-turn-started", providerTurnId: result.turn.id }); } }
      catch (error) { settled = true; unsubscribe(); this.active.delete(input.runId); const message = error instanceof Error ? error.message : String(error); await finish({ ...input, state: "failed", error: message }, { type: "reject", error: error instanceof Error ? error : new Error(message) }); }
    });
  }
  async cancel(runId: string) { const active = this.active.get(runId); if (active?.turnId) await this.transport.request("turn/interrupt", { threadId: active.threadId, turnId: active.turnId }); }
  async recover(run: AgentRunSnapshot): Promise<AgentRunSnapshot> {
    if (!run.providerTurnId) return { ...run, state: "unknown", error: "Ohne bestätigte Turn-ID wird der Lauf nicht erneut gesendet." };
    try { await this.ready(); const security = await this.secureThreadParameters(run.workspaceId, run.modelId); await this.transport.request("thread/resume", { threadId: run.providerSessionId, ...security }); const thread = await this.transport.request<{ thread: { turns?: { id: string; status: string }[] } }>("thread/read", { threadId: run.providerSessionId, includeTurns: true }); const turn = thread.thread.turns?.find((item) => item.id === run.providerTurnId); if (!turn) return { ...run, state: "unknown", error: "Der bestätigte Codex-Turn ist nicht mehr auffindbar." }; if (turn.status === "interrupted") return { ...run, state: "interrupted" }; if (turn.status === "failed") return { ...run, state: "failed" }; return { ...run, state: turn.status === "completed" && run.proposalId ? "proposal-ready" : "unknown" }; }
    catch { return { ...run, state: "process-lost", error: "Codex App Server konnte nicht wiederhergestellt werden." }; }
  }
  async close() { await this.transport.close(); }
}
