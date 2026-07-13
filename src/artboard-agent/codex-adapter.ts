import { ARTBOARD_AGENT_TOOL_CONTRACT_VERSION, ARTBOARD_WRITE_TOOLS, validateToolInvocation, type ToolBudget } from "./tool-contract";
import { ARTBOARD_AGENT_TOOL_SPECS } from "./tool-specs";
import { agentSessionKey, type ArtboardAgentRepository } from "./repository";
import { prepareArtboardTurnDelta, sessionWithArtboardTurnCheckpoint } from "./manual-context-delta";
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

const CODEX_INSTRUCTIONS = "You are FlowZ's Artboard design agent. Use only the supplied dynamic Artboard tools. Every turn includes a current bounded snapshot with exact board/layer IDs; use it directly and do not repeat reads unless one required field is absent. Keep small requested edits on the existing board. For a new direction, variant, or format adaptation, use create_board or duplicate_board_as_variant so the original remains and the collision-free result is placed beside it; multiple boards may have different supported sizes. Use delete_board only when the user explicitly asks to remove that whole Artboard; it is proposal-only and the user still confirms it in FlowZ. Never remove the final Artboard. For a system font such as Georgia set fontFamily and omit fontHash. Only reuse an imported Google/CAS fontHash that is present in the snapshot, always together with fontFamily; never invent a hash. If a mutation is rejected, make at most one targeted recovery read and one corrected mutation. After drafting writes, call render_preview with the same proposalId and visually inspect the returned image for overlap, crop, contrast, and hierarchy. If you identify a concrete issue, make at most one targeted correction call and then call render_preview again to verify it. Only then call finish_working. Never use shell, files, URLs, web, MCP, apps, skills, or built-in tools. Never claim that a proposal is applied.";

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
  latestRun(key: AgentSessionKey) { return this.repository.findLatestRun(agentSessionKey(key)); }
  saveRun(run: AgentRunSnapshot) { return this.repository.saveRun(run); }
  async openSession(input: AgentSessionKey & { modelId: string; reasoningEffort?: string; previousProviderSessionId?: string }): Promise<PersistedAgentSession> {
    await this.ready(); const existing = await this.repository.findSession(agentSessionKey(input)); const previous = input.previousProviderSessionId ?? existing?.providerSessionId; const security = await this.secureThreadParameters(input.workspaceId, input.modelId);
    let response: { thread: { id: string } };
    if (previous) {
      try { response = await this.transport.request<{ thread: { id: string } }>("thread/resume", { threadId: previous, ...security }); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/no rollout found|thread (?:was )?not found|unknown thread/i.test(message)) throw error;
        response = await this.transport.request<{ thread: { id: string } }>("thread/start", { ...security, serviceName: "flowz_artboard" });
      }
    } else response = await this.transport.request<{ thread: { id: string } }>("thread/start", { ...security, serviceName: "flowz_artboard" });
    const session: PersistedAgentSession = { ...agentSessionKey(input), providerSessionId: response.thread.id, modelId: input.modelId, reasoningEffort: input.reasoningEffort, ...(existing?.providerSessionId === response.thread.id && existing.lastTurnId ? { lastTurnId: existing.lastTurnId } : {}), ...(existing?.manualContextCheckpoint ? { manualContextCheckpoint: existing.manualContextCheckpoint } : {}) }; await this.repository.saveSession(session); return session;
  }
  async runTurn(input: AgentRunSnapshot, userText: string, onEvent: (event: AgentEvent) => void): Promise<{ providerTurnId: string }> {
    if (input.provider !== this.provider || input.toolContractVersion !== ARTBOARD_AGENT_TOOL_CONTRACT_VERSION) throw new Error("Inkompatibler lokaler Codex-Agentlauf.");
    if ([...this.active.values()].some((active) => active.threadId === input.providerSessionId)) throw new Error("In dieser Artboard-Session läuft bereits ein Codex-Turn.");
    await this.ready(); let budget: ToolBudget = { calls: 0, mutations: 0 }; let proposalId: string | undefined; let settled = false;
    const preparedDelta = await prepareArtboardTurnDelta(this.executor, this.repository, input);
    const binding = `Bound Artboard context (use these exact values in every dynamic tool call): workspaceId=${input.workspaceId}; branchId=${input.branchId}; expectedRevision=${input.inputRevision}. The current snapshot below is authoritative; use its exact IDs. Only make one targeted read if a required field is absent.`;
    const contextualUserText = `${binding}\n\n${preparedDelta.initialContext}${preparedDelta.delta ? `\n\n${preparedDelta.delta}` : ""}\n\nUser request:\n${userText}`;
    let visualPreviewCount = 0; let mutationAfterPreview = false; let correctionCalls = 0;
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
        if (event.method === "turn/started" && event.params.threadId === input.providerSessionId && this.active.has(input.runId) && (!this.active.get(input.runId)?.turnId || this.active.get(input.runId)?.turnId === event.params.turn.id)) { this.active.set(input.runId, { threadId: input.providerSessionId, turnId: event.params.turn.id }); void this.repository.saveRun({ ...input, providerTurnId: event.params.turn.id, state: "streaming" }).catch(() => undefined); onEvent({ type: "provider-turn-started", providerTurnId: event.params.turn.id }); onEvent({ type: "status", status: "streaming" }); }
        else if (event.method === "item/agentMessage/delta" && event.params.threadId === input.providerSessionId && this.active.get(input.runId)?.turnId === event.params.turnId) onEvent({ type: "text-delta", text: event.params.delta });
        else if (event.method === "item/tool/call" && event.params.threadId === input.providerSessionId && this.active.get(input.runId)?.turnId === event.params.turnId) {
          void (async () => {
            let tool = event.params.tool;
            const rawArguments = event.params.arguments && typeof event.params.arguments === "object" ? event.params.arguments as Record<string, unknown> : undefined;
            let operationId = typeof rawArguments?.operationId === "string" ? rawArguments.operationId : event.params.callId;
            onEvent({ type: "tool-started", tool, operationId });
            try {
            const checked = validateToolInvocation({ tool: event.params.tool, arguments: event.params.arguments }, budget); budget = checked.nextBudget;
            tool = checked.invocation.tool; const toolArguments = checked.invocation.arguments;
            if (tool === "finish_working" && (visualPreviewCount < 1 || mutationAfterPreview)) throw new Error("Vor finish_working muss der aktuelle Proposal-Entwurf mit render_preview visuell geprüft werden; nach einer Korrektur ist eine Kontrollvorschau erforderlich.");
            if (tool === "render_preview" && proposalId && toolArguments.proposalId !== proposalId) throw new Error("render_preview muss den aktuellen proposalId verwenden.");
            if (tool !== "finish_working" && (ARTBOARD_WRITE_TOOLS as readonly string[]).includes(tool) && visualPreviewCount > 0) { correctionCalls += 1; if (correctionCalls > 1) throw new Error("Nach der visuellen Vorschau ist höchstens eine gezielte Korrektur erlaubt."); mutationAfterPreview = true; }
            operationId = typeof toolArguments.operationId === "string" ? toolArguments.operationId : event.params.callId;
            const result = await this.executor.execute(checked.invocation); proposalId = result.proposalId ?? proposalId;
            if (result.proposalId) await this.repository.saveRun({ ...input, providerTurnId: this.active.get(input.runId)?.turnId, proposalId: result.proposalId, state: "tool-executing" });
            if (tool === "render_preview") { if (!result.imageDataUrl) throw new Error("render_preview lieferte keine visuelle PNG-Evidenz."); visualPreviewCount += 1; mutationAfterPreview = false; }
            const contentItems: ({ type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string })[] = [{ type: "inputText", text: JSON.stringify(result.content) }];
            if (result.imageDataUrl) contentItems.push({ type: "inputImage", imageUrl: result.imageDataUrl });
            await this.transport.respond(event.id, { contentItems, success: true }); onEvent({ type: "tool-completed", tool, operationId, success: true }); if (result.proposalId) onEvent({ type: "proposal-updated", proposalId: result.proposalId });
          } catch (error) {
            onEvent({ type: "tool-completed", tool, operationId, success: false });
            await this.transport.respond(event.id, { contentItems: [{ type: "inputText", text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }], success: false });
          } })();
        } else if (event.method === "turn/completed" && event.params.threadId === input.providerSessionId && this.active.get(input.runId)?.turnId === event.params.turn.id && !settled) {
          settled = true; unsubscribe(); this.active.delete(input.runId);
          if (event.params.turn.status === "interrupted") { onEvent({ type: "interrupted" }); void finish({ ...input, providerTurnId: event.params.turn.id, state: "interrupted" }, { type: "reject", error: new Error("CODEX_INTERRUPTED") }); }
          else if (event.params.turn.status === "failed" || !proposalId) { const message = event.params.turn.error?.message ?? "Der lokale Design-Agent hat keinen Vorschlag erzeugt."; onEvent({ type: "failed", error: message }); void finish({ ...input, providerTurnId: event.params.turn.id, state: "failed", error: message }, { type: "reject", error: new Error(message) }); }
          else { onEvent({ type: "status", status: "finalizing" }); onEvent({ type: "completed", proposalId }); void (async () => { await this.repository.saveSession(sessionWithArtboardTurnCheckpoint({ ...agentSessionKey(input), providerSessionId: input.providerSessionId, modelId: input.modelId, reasoningEffort: input.reasoningEffort, lastTurnId: event.params.turn.id }, preparedDelta)); await finish({ ...input, providerTurnId: event.params.turn.id, proposalId, state: "proposal-ready" }, { type: "resolve", providerTurnId: event.params.turn.id }); })().catch(reject); }
        }
      });
      try { this.active.set(input.runId, { threadId: input.providerSessionId }); const result = await this.transport.request<{ turn: { id: string } }>("turn/start", { threadId: input.providerSessionId, model: input.modelId, effort: input.reasoningEffort ?? null, approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false }, input: [{ type: "text", text: contextualUserText }] }); const announced = this.active.get(input.runId)?.turnId; if (announced && announced !== result.turn.id) throw new Error("Codex lieferte widersprüchliche Turn-IDs."); if (!announced) { this.active.set(input.runId, { threadId: input.providerSessionId, turnId: result.turn.id }); await this.repository.saveRun({ ...input, providerTurnId: result.turn.id, proposalId, state: "streaming" }); onEvent({ type: "provider-turn-started", providerTurnId: result.turn.id }); } }
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
