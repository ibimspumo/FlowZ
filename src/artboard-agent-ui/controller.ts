import {
  ARTBOARD_AGENT_TOOL_CONTRACT_VERSION,
  selectableArtboardModels,
  type AgentEvent,
  type ArtboardAgentAdapter,
  type ArtboardAgentProvider,
  type ArtboardAgentRunState,
  type AgentRunSnapshot,
} from "../artboard-agent";
import type {
  AgentConversationItem,
  ArtboardAgentContext,
  ArtboardAgentControllerOptions,
  ArtboardAgentControllerState,
  ProviderViewState,
} from "./types";
import { proposalRevisionError, validateResolvedProposal } from "./validation";
import type { TranslationKey } from "../i18n";

const providers: ArtboardAgentProvider[] = ["openrouter", "codex-local"];
const activeStates = new Set<ArtboardAgentRunState>(["submitting", "streaming", "tool-executing", "cancel-requested", "finalizing", "recovering"]);

const initialProvider = (): ProviderViewState => ({ status: { state: "probing" }, models: [] });
const message = (id: string, role: AgentConversationItem["role"], text: string, createdAt: string, state?: AgentConversationItem["state"], translationKey?: TranslationKey): AgentConversationItem => ({ id, role, text, createdAt, state, translationKey });
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export class ArtboardAgentController {
  private state: ArtboardAgentControllerState;
  private context: ArtboardAgentContext;
  private listeners = new Set<() => void>();
  private adapters = new Map<ArtboardAgentProvider, Promise<ArtboardAgentAdapter>>();
  private disposed = false;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(private readonly options: ArtboardAgentControllerOptions) {
    this.context = options.context;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.state = {
      provider: "openrouter",
      providers: { openrouter: initialProvider(), "codex-local": initialProvider() },
      modelId: "",
      prompt: "",
      messages: [],
      tools: [],
      runState: "idle",
      usage: {},
      applying: false,
    };
  }

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = () => this.state;
  private emit(patch: Partial<ArtboardAgentControllerState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private adapter(provider: ArtboardAgentProvider) {
    let current = this.adapters.get(provider);
    if (!current) {
      current = Promise.resolve(this.options.adapterFactory.create(provider, this.options.toolExecutor));
      this.adapters.set(provider, current);
    }
    return current;
  }

  async initialize() { await Promise.all(providers.map((provider) => this.probe(provider))); }
  async probe(provider: ArtboardAgentProvider) {
    const previous = this.state.providers[provider];
    this.emit({ providers: { ...this.state.providers, [provider]: { ...previous, status: { state: "probing" }, error: undefined } } });
    try {
      const adapter = await this.adapter(provider);
      const status = await adapter.probe();
      const models = status.state === "ready" ? selectableArtboardModels(await adapter.listModels(), false) : [];
      const next = { status, models } satisfies ProviderViewState;
      const providerStates = { ...this.state.providers, [provider]: next };
      const patch: Partial<ArtboardAgentControllerState> = { providers: providerStates };
      if (provider === this.state.provider && status.state === "ready") {
        const selected = models.find((model) => model.id === this.state.modelId) ?? models.find((model) => model.isDefault) ?? models[0];
        patch.modelId = selected?.id ?? "";
        patch.reasoningEffort = selected?.defaultReasoningEffort;
      }
      this.emit(patch);
    } catch (error) {
      const reason = errorText(error);
      this.emit({ providers: { ...this.state.providers, [provider]: { status: { state: "unavailable", reason }, models: [], error: reason } } });
    }
  }

  updateContext(context: ArtboardAgentContext) {
    this.context = context;
    if (this.state.proposal) {
      const error = proposalRevisionError(this.state.proposal, context);
      if (error) this.emit({ error });
    }
  }
  /** Updates reactive shell metadata without ever replacing the persisted workspace snapshot with optimistic UI state. */
  updateViewContext(context: ArtboardAgentContext) {
    this.context = { ...this.context, branchId: context.branchId, revision: context.revision, selection: context.selection };
    if (this.state.proposal) {
      const error = proposalRevisionError(this.state.proposal, this.context);
      if (error) this.emit({ error });
    }
  }
  setPrompt(prompt: string) { this.emit({ prompt }); }
  selectProvider(provider: ArtboardAgentProvider) {
    if (activeStates.has(this.state.runState) || provider === this.state.provider) return;
    const available = this.state.providers[provider].models;
    const model = available.find((item) => item.isDefault) ?? available[0];
    this.emit({ provider, modelId: model?.id ?? "", reasoningEffort: model?.defaultReasoningEffort, error: undefined });
  }
  selectModel(modelId: string) {
    if (activeStates.has(this.state.runState)) return;
    const model = this.state.providers[this.state.provider].models.find((item) => item.id === modelId);
    if (!model) return;
    this.emit({ modelId, reasoningEffort: model.defaultReasoningEffort, error: undefined });
  }
  setReasoningEffort(reasoningEffort?: string) { if (!activeStates.has(this.state.runState)) this.emit({ reasoningEffort }); }

  private updateAssistant(id: string, updater: (item: AgentConversationItem) => AgentConversationItem) {
    this.emit({ messages: this.state.messages.map((item) => item.id === id ? updater(item) : item) });
  }
  private handleEvent(event: AgentEvent, assistantId: string) {
    if (event.type === "status") this.emit({ runState: event.status, run: this.state.run ? { ...this.state.run, state: event.status } : undefined });
    else if (event.type === "provider-turn-started" && this.state.run) this.emit({ run: { ...this.state.run, providerTurnId: event.providerTurnId } });
    else if (event.type === "text-delta") this.updateAssistant(assistantId, (item) => ({ ...item, text: item.text + event.text, state: "streaming" }));
    else if (event.type === "tool-started") this.emit({ runState: "tool-executing", tools: [...this.state.tools.filter((item) => item.id !== event.operationId), { id: event.operationId, tool: event.tool, state: "running" }] });
    else if (event.type === "tool-completed") this.emit({ tools: this.state.tools.map((item) => item.id === event.operationId ? { ...item, state: event.success ? "complete" : "failed" } : item), runState: "streaming" });
    else if (event.type === "proposal-updated" && this.state.run) this.emit({ run: { ...this.state.run, proposalId: event.proposalId } });
    else if (event.type === "completed" && this.state.run) this.emit({ runState: "proposal-ready", run: { ...this.state.run, state: "proposal-ready", proposalId: event.proposalId } });
    else if (event.type === "usage") this.emit({ usage: { inputTokens: event.inputTokens, outputTokens: event.outputTokens, costMicrounits: event.costMicrounits, generationId: event.generationId } });
    else if (event.type === "interrupted") { this.emit({ runState: "interrupted", run: this.state.run ? { ...this.state.run, state: "interrupted" } : undefined }); this.updateAssistant(assistantId, (item) => item.text ? { ...item, state: "complete" } : { ...item, state: "complete", translationKey: "agent.message.interrupted" }); }
    else if (event.type === "failed") { this.emit({ error: event.error, runState: "failed", run: this.state.run ? { ...this.state.run, state: "failed", error: event.error } : undefined }); this.updateAssistant(assistantId, (item) => ({ ...item, state: "error", text: item.text || event.error })); }
  }

  async submit() {
    const userText = this.state.prompt.trim();
    const providerState = this.state.providers[this.state.provider];
    if (!userText || activeStates.has(this.state.runState) || providerState.status.state !== "ready" || !this.state.modelId) return;
    const timestamp = this.now().toISOString();
    const userId = this.createId();
    const assistantId = this.createId();
    let adapter: ArtboardAgentAdapter;
    let session;
    try {
      adapter = await this.adapter(this.state.provider);
      session = await adapter.openSession({
        workspaceId: this.context.workspace.id,
        branchId: this.context.branchId,
        provider: this.state.provider,
        toolContractVersion: ARTBOARD_AGENT_TOOL_CONTRACT_VERSION,
        modelId: this.state.modelId,
        reasoningEffort: this.state.reasoningEffort,
      });
    } catch (error) {
      this.emit({ runState: "failed", error: `Agent-Session konnte nicht gestartet werden: ${errorText(error)}` });
      return;
    }
    const run: AgentRunSnapshot = {
      workspaceId: this.context.workspace.id,
      branchId: this.context.branchId,
      provider: this.state.provider,
      toolContractVersion: ARTBOARD_AGENT_TOOL_CONTRACT_VERSION,
      runId: this.createId(), providerSessionId: session.providerSessionId,
      modelId: this.state.modelId, reasoningEffort: this.state.reasoningEffort,
      inputRevision: this.context.revision.number,
      selectedBoardRevisionIds: this.context.selection.boardIds.map((id) => this.context.workspace.boards[id]?.activeRevisionId).filter((id): id is string => Boolean(id)),
      state: "submitting", submittedAt: timestamp,
    };
    this.emit({
      prompt: "", error: undefined, proposal: undefined, usage: {}, tools: [], run, runState: "submitting",
      messages: [...this.state.messages, message(userId, "user", userText, timestamp, "complete"), message(assistantId, "assistant", "", timestamp, "streaming")],
    });
    try {
      const result = await adapter.runTurn(run, userText, (event) => this.handleEvent(event, assistantId));
      const effectiveProposalId = this.state.run?.proposalId;
      if (!effectiveProposalId) {
        // The adapters emit `completed` before resolving. Capture it via a small event-independent fallback only when their snapshot already has it.
        throw new Error(`Der Agentenlauf ${result.providerTurnId} lieferte keinen lesbaren Vorschlag.`);
      }
      const proposal = validateResolvedProposal(await this.options.resolveProposal(effectiveProposalId), this.context);
      if (proposal.proposalId !== effectiveProposalId) throw new Error("Der geladene Vorschlag gehört nicht zu diesem Agentenlauf.");
      this.emit({ proposal, runState: "proposal-ready", run: this.state.run ? { ...this.state.run, providerTurnId: result.providerTurnId, proposalId: effectiveProposalId, state: "proposal-ready" } : undefined });
      this.updateAssistant(assistantId, (item) => ({ ...item, state: "complete", text: item.text || proposal.summary }));
    } catch (error) {
      const text = errorText(error);
      const processLost = text.includes("CODEX_PROCESS_LOST");
      const interrupted = text.includes("INTERRUPTED") || this.state.runState === "interrupted";
      const state: ArtboardAgentRunState = processLost ? "process-lost" : interrupted ? "interrupted" : this.state.runState === "failed" ? "failed" : "failed";
      this.emit({ error: processLost ? "Codex lokal wurde unerwartet beendet. Der Lauf wird niemals automatisch erneut gesendet." : interrupted ? undefined : text, runState: state, run: this.state.run ? { ...this.state.run, state, error: processLost || !interrupted ? text : undefined } : undefined });
      this.updateAssistant(assistantId, (item) => item.text ? { ...item, state: interrupted ? "complete" : "error" } : interrupted ? { ...item, state: "complete", translationKey: "agent.message.interrupted" } : { ...item, state: "error", text });
    }
  }

  async cancel() {
    if (!this.state.run || !activeStates.has(this.state.runState)) return;
    const adapter = await this.adapter(this.state.run.provider);
    this.emit({ runState: "cancel-requested", run: { ...this.state.run, state: "cancel-requested" } });
    try { await adapter.cancel(this.state.run.runId); }
    catch (error) { this.emit({ error: errorText(error) }); }
  }

  async recover() {
    if (!this.state.run || !["process-lost", "unknown", "failed"].includes(this.state.runState)) return;
    const adapter = await this.adapter(this.state.run.provider);
    this.emit({ runState: "recovering", error: undefined });
    try {
      const run = await adapter.recover(this.state.run);
      this.emit({ run, runState: run.state, error: run.error });
      if (run.state === "proposal-ready" && run.proposalId) this.emit({ proposal: validateResolvedProposal(await this.options.resolveProposal(run.proposalId), this.context) });
    } catch (error) { this.emit({ runState: "process-lost", error: errorText(error) }); }
  }

  abandonUnknown() {
    if (!this.state.run || this.state.runState !== "unknown") return;
    this.emit({ run: { ...this.state.run, state: "idle", error: undefined }, runState: "idle", error: undefined });
  }

  rejectProposal() {
    if (!this.state.proposal || this.state.applying) return;
    const item = message(this.createId(), "system", "", this.now().toISOString(), "complete", "agent.message.rejected");
    this.emit({ proposal: undefined, runState: "idle", run: this.state.run ? { ...this.state.run, state: "idle", proposalId: undefined } : undefined, messages: [...this.state.messages, item], error: undefined });
  }

  async applyProposal() {
    if (!this.state.proposal || this.state.applying) return;
    try {
      const proposal = validateResolvedProposal(this.state.proposal, this.context);
      if (!proposal.batch.operations.length) throw new Error("Dieser Vorschlag enthält keine direkten Artboard-Änderungen. Der kostenpflichtige Folgeauftrag bleibt bewusst getrennt und wurde nicht gestartet.");
      this.emit({ applying: true, runState: "applying", error: undefined });
      await this.options.onApplyProposal(structuredClone(proposal.batch), structuredClone(proposal));
      const item = message(this.createId(), "system", "", this.now().toISOString(), "complete", "agent.message.applied");
      this.emit({ applying: false, proposal: undefined, runState: "idle", run: this.state.run ? { ...this.state.run, state: "idle", proposalId: undefined } : undefined, messages: [...this.state.messages, item] });
    } catch (error) { this.emit({ applying: false, runState: "proposal-ready", error: errorText(error) }); }
  }

  async dispose() {
    if (this.disposed) return;
    const activeRun = this.state.run && activeStates.has(this.state.runState) ? this.state.run : undefined;
    this.disposed = true;
    const settled = await Promise.allSettled([...this.adapters.values()]);
    const adapters = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    if (activeRun) {
      const adapter = adapters.find((item) => item.provider === activeRun.provider);
      if (adapter) await Promise.allSettled([adapter.cancel(activeRun.runId)]);
    }
    await Promise.allSettled(adapters.map((adapter) => adapter.close()));
    this.listeners.clear();
  }
}

export function isAgentBusy(state: ArtboardAgentControllerState) { return activeStates.has(state.runState) || state.applying; }
