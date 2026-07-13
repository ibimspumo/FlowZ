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
  PersistedAgentChat,
  ArtboardAgentContext,
  ArtboardAgentControllerOptions,
  ArtboardAgentControllerState,
  ProviderViewState,
} from "./types";
import { ARTBOARD_AGENT_PROVIDER_ORDER } from "./types";
import { proposalRevisionError, validateResolvedProposal } from "./validation";
import { providerErrorMessage, type TranslationKey } from "../i18n";

const providers: readonly ArtboardAgentProvider[] = ARTBOARD_AGENT_PROVIDER_ORDER;
const activeStates = new Set<ArtboardAgentRunState>(["submitting", "streaming", "tool-executing", "cancel-requested", "finalizing", "recovering", "applying", "rejecting"]);
const PROVIDER_PREFERENCE_KEY = "flowz.artboard-agent.provider.v1";
const CHAT_STORAGE_PREFIX = "flowz.artboard-agent.chats.v2:";
const LEGACY_CHAT_STORAGE_PREFIX = "flowz.artboard-agent.chat.v1:";
const MAX_CHATS = 20;
const MAX_MESSAGES = 200;
const MAX_TOOLS = 100;
const MAX_PERSISTED_BYTES = 256 * 1024;

function preferredProvider(): ArtboardAgentProvider {
  try { const value = typeof window === "undefined" ? null : window.localStorage.getItem(PROVIDER_PREFERENCE_KEY); return value === "openrouter" || value === "codex-local" ? value : "codex-local"; }
  catch { return "codex-local"; }
}

function rememberProvider(provider: ArtboardAgentProvider) { try { if (typeof window !== "undefined") window.localStorage.setItem(PROVIDER_PREFERENCE_KEY, provider); } catch { /* Preference persistence must never block the Artboard. */ } }

const initialProvider = (): ProviderViewState => ({ status: { state: "probing" }, models: [] });
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

type TurnStream = { activeAssistantId?: string };

function safePersistedText(value: unknown, max = 12_000) {
  if (typeof value !== "string") return "";
  return value.slice(0, max)
    .replace(/data:[^\s)]{32,}/gi, "[nicht gespeichert]")
    .replace(/https?:\/\/[^\s)]+/gi, "[externer Link]")
    .replace(/\b(?:sk-|BS[A-Za-z0-9]|fal_[A-Za-z0-9])[A-Za-z0-9_:\-]{16,}\b/g, "[geschützt]");
}

function chatTitle(prompt: string) {
  const compact = prompt.replace(/\s+/g, " ").trim();
  return compact.length > 46 ? `${compact.slice(0, 45).trimEnd()}…` : compact;
}

export class ArtboardAgentController {
  private state: ArtboardAgentControllerState;
  private context: ArtboardAgentContext;
  private listeners = new Set<() => void>();
  private adapters = new Map<ArtboardAgentProvider, Promise<ArtboardAgentAdapter>>();
  private disposed = false;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private sequence = 0;
  private chats = new Map<string, PersistedAgentChat>();
  private readonly chatStorageKey: string;

  constructor(private readonly options: ArtboardAgentControllerOptions) {
    this.context = options.context;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.chatStorageKey = `${CHAT_STORAGE_PREFIX}${options.context.workspace.id}`;
    const restored = this.loadChats();
    for (const chat of restored) this.chats.set(chat.id, chat);
    const active = restored.find((chat) => chat.id === this.loadActiveChatId()) ?? restored[0] ?? this.newChatRecord();
    this.chats.set(active.id, active);
    this.sequence = Math.max(0, ...restored.flatMap((chat) => [...chat.messages.map((item) => item.sequence), ...chat.tools.map((item) => item.sequence)])) + 1;
    this.state = {
      provider: preferredProvider(),
      providers: { openrouter: initialProvider(), "codex-local": initialProvider() },
      modelId: "",
      prompt: "",
      messages: active.messages,
      tools: active.tools,
      chats: this.chatSummaries(),
      activeChatId: active.id,
      runState: "idle",
      usage: {},
      applying: false,
    };
    this.persistChats();
  }

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = () => this.state;
  private emit(patch: Partial<ArtboardAgentControllerState>) {
    if (this.disposed) return;
    const next = { ...this.state, ...patch };
    if (patch.messages || patch.tools) {
      const current = this.chats.get(next.activeChatId);
      if (current) {
        const updated = { ...current, updatedAt: this.now().toISOString(), messages: next.messages.slice(-MAX_MESSAGES), tools: next.tools.slice(-MAX_TOOLS) };
        this.chats.set(updated.id, updated);
        next.messages = updated.messages;
        next.tools = updated.tools;
        next.chats = this.chatSummaries();
      }
    }
    this.state = next;
    this.persistChats();
    this.listeners.forEach((listener) => listener());
  }

  private newChatRecord(): PersistedAgentChat {
    const now = this.now().toISOString();
    return { id: this.createId(), title: "", createdAt: now, updatedAt: now, messages: [], tools: [] };
  }
  private chatSummaries() {
    return [...this.chats.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(({ id, title, createdAt, updatedAt }) => ({ id, title, createdAt, updatedAt }));
  }
  private loadActiveChatId() {
    try { return typeof window === "undefined" ? undefined : window.localStorage.getItem(`${this.chatStorageKey}:active`) ?? undefined; }
    catch { return undefined; }
  }
  private loadChats(): PersistedAgentChat[] {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem(this.chatStorageKey) ?? window.localStorage.getItem(`${LEGACY_CHAT_STORAGE_PREFIX}${this.options.context.workspace.id}`);
      if (!raw || raw.length > MAX_PERSISTED_BYTES) return [];
      const parsed: unknown = JSON.parse(raw);
      const candidates = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray((parsed as { chats?: unknown }).chats) ? (parsed as { chats: unknown[] }).chats : parsed && typeof parsed === "object" && Array.isArray((parsed as { messages?: unknown }).messages) ? [{ ...(parsed as object), id: "conversation-legacy", title: "", createdAt: this.now().toISOString(), updatedAt: this.now().toISOString() }] : [];
      return candidates.slice(0, MAX_CHATS).flatMap((candidate): PersistedAgentChat[] => {
        if (!candidate || typeof candidate !== "object") return [];
        const value = candidate as Partial<PersistedAgentChat>;
        if (typeof value.id !== "string" || !value.id || typeof value.title !== "string" || !Array.isArray(value.messages) || !Array.isArray(value.tools)) return [];
        const messages = value.messages.slice(-MAX_MESSAGES).flatMap((item): AgentConversationItem[] => item && typeof item === "object" && typeof item.id === "string" && ["user", "assistant", "system"].includes(item.role) && typeof item.sequence === "number" ? [{ ...item, text: safePersistedText(item.text), createdAt: typeof item.createdAt === "string" ? item.createdAt : this.now().toISOString() } as AgentConversationItem] : []);
        const tools = value.tools.slice(-MAX_TOOLS).flatMap((item) => item && typeof item === "object" && typeof item.id === "string" && typeof item.tool === "string" && ["running", "complete", "failed"].includes(item.state) && typeof item.sequence === "number" ? [{ id: item.id, tool: safePersistedText(item.tool, 120), state: item.state, sequence: item.sequence } as const] : []);
        const createdAt = typeof value.createdAt === "string" ? value.createdAt : this.now().toISOString();
        return [{ id: value.id, title: safePersistedText(value.title, 64), createdAt, updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : createdAt, messages, tools }];
      });
    } catch { return []; }
  }
  private persistChats() {
    if (typeof window === "undefined") return;
    try {
      let chats = [...this.chats.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_CHATS).map((chat) => ({ ...chat, title: safePersistedText(chat.title, 64), messages: chat.messages.slice(-MAX_MESSAGES).map((item) => ({ ...item, text: safePersistedText(item.text) })), tools: chat.tools.slice(-MAX_TOOLS).map((item) => ({ ...item, tool: safePersistedText(item.tool, 120) })) }));
      let serialized = JSON.stringify({ version: 2, chats });
      while (serialized.length > MAX_PERSISTED_BYTES && chats.some((chat) => chat.messages.length > 1)) {
        chats = chats.map((chat) => ({ ...chat, messages: chat.messages.slice(Math.ceil(chat.messages.length / 4)) }));
        serialized = JSON.stringify({ version: 2, chats });
      }
      if (serialized.length > MAX_PERSISTED_BYTES) return;
      window.localStorage.setItem(this.chatStorageKey, serialized);
      window.localStorage.setItem(`${this.chatStorageKey}:active`, this.state.activeChatId);
    } catch { /* Bounded local history must never block the editor. */ }
  }

  createChat() {
    if (activeStates.has(this.state.runState)) return;
    if (this.chats.size >= MAX_CHATS) {
      const oldest = [...this.chats.values()].filter((item) => item.id !== this.state.activeChatId).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
      if (oldest) this.chats.delete(oldest.id);
    }
    const chat = this.newChatRecord();
    this.chats.set(chat.id, chat);
    this.state = { ...this.state, activeChatId: chat.id, chats: this.chatSummaries(), messages: [], tools: [], run: undefined, runState: "idle", proposal: undefined, usage: {}, error: undefined };
    this.persistChats(); this.listeners.forEach((listener) => listener());
  }
  selectChat(id: string) {
    if (activeStates.has(this.state.runState) || id === this.state.activeChatId) return;
    const chat = this.chats.get(id); if (!chat) return;
    this.state = { ...this.state, activeChatId: id, chats: this.chatSummaries(), messages: chat.messages, tools: chat.tools, run: undefined, runState: "idle", proposal: undefined, usage: {}, error: undefined };
    this.persistChats(); this.listeners.forEach((listener) => listener());
    void this.restoreActiveChatRun();
  }
  renameChat(id: string, title: string) {
    const chat = this.chats.get(id); const clean = safePersistedText(title, 64).trim(); if (!chat || !clean) return;
    this.chats.set(id, { ...chat, title: clean, updatedAt: this.now().toISOString() });
    this.emit({ chats: this.chatSummaries() });
  }
  deleteChat(id: string) {
    if (activeStates.has(this.state.runState) || !this.chats.has(id) || this.chats.size <= 1) return;
    const deletingActive = id === this.state.activeChatId;
    this.chats.delete(id);
    if (!deletingActive) {
      this.state = { ...this.state, chats: this.chatSummaries() };
      this.persistChats(); this.listeners.forEach((listener) => listener());
      return;
    }
    const replacement = this.chatSummaries()[0];
    const record = replacement ? this.chats.get(replacement.id) : undefined; if (!record) return;
    this.state = { ...this.state, activeChatId: record.id, chats: this.chatSummaries(), messages: record.messages, tools: record.tools, run: undefined, runState: "idle", proposal: undefined, usage: {}, error: undefined };
    this.persistChats(); this.listeners.forEach((listener) => listener());
    void this.restoreActiveChatRun();
  }
  private adapter(provider: ArtboardAgentProvider) {
    let current = this.adapters.get(provider);
    if (!current) {
      current = Promise.resolve(this.options.adapterFactory.create(provider, this.options.toolExecutor));
      this.adapters.set(provider, current);
    }
    return current;
  }

  async initialize() {
    const activeProvider = this.state.provider;
    const backgroundProbes = providers.filter((provider) => provider !== activeProvider).map((provider) => this.probe(provider));
    await Promise.all([this.probe(activeProvider), this.restoreActiveChatRun()]);
    void Promise.allSettled(backgroundProbes);
  }
  private async restoreActiveChatRun() {
    const provider = this.state.provider;
    const conversationId = this.state.activeChatId;
    try {
      const adapter = await this.adapter(provider);
      const run = await adapter.latestRun({ workspaceId: this.context.workspace.id, branchId: this.context.branchId, conversationId, provider, toolContractVersion: ARTBOARD_AGENT_TOOL_CONTRACT_VERSION });
      if (this.state.provider !== provider || this.state.activeChatId !== conversationId) return;
      if (run?.state === "proposal-ready" && run.proposalId) {
        const proposal = await this.options.resolveProposal(run.proposalId);
        if (this.state.provider !== provider || this.state.activeChatId !== conversationId) return;
        this.emit({ run, runState: "proposal-ready", proposal, error: proposalRevisionError(proposal, this.context) });
      } else if (run && ["submitting", "streaming", "tool-executing", "cancel-requested", "finalizing", "recovering"].includes(run.state)) {
        this.emit({ run: { ...run, state: "recovering" }, runState: "recovering", proposal: undefined, error: undefined });
        const recovered = await adapter.recover(run);
        if (this.state.provider !== provider || this.state.activeChatId !== conversationId) return;
        if (recovered.state === "proposal-ready" && recovered.proposalId) {
          const proposal = validateResolvedProposal(await this.options.resolveProposal(recovered.proposalId), this.context);
          if (this.state.provider !== provider || this.state.activeChatId !== conversationId) return;
          this.emit({ run: recovered, runState: "proposal-ready", proposal, error: proposalRevisionError(proposal, this.context) });
        } else this.emit({ run: recovered, runState: recovered.state, proposal: undefined, error: recovered.error });
      } else if (run && ["failed", "process-lost", "unknown", "interrupted"].includes(run.state)) {
        this.emit({ run, runState: run.state, proposal: undefined, error: run.error });
      } else if (run && ["applying", "rejecting"].includes(run.state)) {
        const uncertain = { ...run, state: "unknown" as const, error: "Der letzte Vorschlag wurde beim Beenden gerade bestätigt. FlowZ wendet ihn nicht automatisch erneut an." };
        await adapter.saveRun(uncertain);
        if (this.state.provider !== provider || this.state.activeChatId !== conversationId) return;
        this.emit({ run: uncertain, runState: "unknown", proposal: undefined, error: uncertain.error });
      } else if (!activeStates.has(this.state.runState)) this.emit({ run: undefined, runState: "idle", proposal: undefined, error: undefined });
    } catch (error) {
      if (this.state.provider === provider && this.state.activeChatId === conversationId) this.emit({ error: errorText(error) });
    }
  }
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
    rememberProvider(provider);
    this.emit({ provider, modelId: model?.id ?? "", reasoningEffort: model?.defaultReasoningEffort, error: undefined });
    void this.restoreActiveChatRun();
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
  private message(id: string, role: AgentConversationItem["role"], text: string, createdAt: string, state?: AgentConversationItem["state"], translationKey?: TranslationKey): AgentConversationItem {
    return { id, role, text, createdAt, state, translationKey, sequence: this.sequence++ };
  }
  private currentAssistant(stream: TurnStream) {
    return stream.activeAssistantId ? this.state.messages.find((item) => item.id === stream.activeAssistantId) : undefined;
  }
  private appendAssistantDelta(stream: TurnStream, text: string) {
    if (!stream.activeAssistantId) {
      const item = this.message(this.createId(), "assistant", text, this.now().toISOString(), "streaming");
      stream.activeAssistantId = item.id;
      this.emit({ messages: [...this.state.messages, item] });
      return;
    }
    this.updateAssistant(stream.activeAssistantId, (item) => ({ ...item, text: item.text + text, state: "streaming" }));
  }
  private closeAssistantForTool(stream: TurnStream) {
    const current = this.currentAssistant(stream);
    if (current?.text) this.updateAssistant(current.id, (item) => ({ ...item, state: "complete" }));
    else if (current) this.emit({ messages: this.state.messages.filter((item) => item.id !== current.id) });
    stream.activeAssistantId = undefined;
  }
  private finishAssistant(stream: TurnStream, fallback: { text?: string; translationKey?: TranslationKey; state?: AgentConversationItem["state"] }) {
    const current = this.currentAssistant(stream);
    if (current) {
      this.updateAssistant(current.id, (item) => ({
        ...item,
        state: fallback.state ?? "complete",
        text: item.text || fallback.text || "",
        translationKey: item.text ? item.translationKey : fallback.translationKey,
      }));
      return;
    }
    const item = this.message(this.createId(), "assistant", fallback.text ?? "", this.now().toISOString(), fallback.state ?? "complete", fallback.translationKey);
    stream.activeAssistantId = item.id;
    this.emit({ messages: [...this.state.messages, item] });
  }
  private handleEvent(event: AgentEvent, stream: TurnStream) {
    if (event.type === "status") this.emit({ runState: event.status, run: this.state.run ? { ...this.state.run, state: event.status } : undefined });
    else if (event.type === "provider-turn-started" && this.state.run) this.emit({ run: { ...this.state.run, providerTurnId: event.providerTurnId } });
    else if (event.type === "text-delta") this.appendAssistantDelta(stream, event.text);
    else if (event.type === "tool-started") {
      this.closeAssistantForTool(stream);
      this.emit({ runState: "tool-executing", tools: [...this.state.tools.filter((item) => item.id !== event.operationId).slice(-99), { id: event.operationId, runId: this.state.run?.runId, tool: event.tool, state: "running", sequence: this.sequence++ }] });
    }
    else if (event.type === "tool-completed") this.emit({ tools: this.state.tools.map((item) => item.id === event.operationId ? { ...item, state: event.success ? "complete" : "failed" } : item), runState: "streaming" });
    else if (event.type === "proposal-updated" && this.state.run) this.emit({ run: { ...this.state.run, proposalId: event.proposalId } });
    else if (event.type === "completed" && this.state.run) this.emit({ runState: "proposal-ready", run: { ...this.state.run, state: "proposal-ready", proposalId: event.proposalId } });
    else if (event.type === "usage") this.emit({ usage: { inputTokens: event.inputTokens, outputTokens: event.outputTokens, costMicrounits: event.costMicrounits, generationId: event.generationId } });
    else if (event.type === "interrupted") { this.emit({ runState: "interrupted", run: this.state.run ? { ...this.state.run, state: "interrupted" } : undefined }); this.finishAssistant(stream, { translationKey: "agent.message.interrupted" }); }
    else if (event.type === "failed") { this.emit({ error: event.error, runState: "failed", run: this.state.run ? { ...this.state.run, state: "failed", error: event.error } : undefined }); this.finishAssistant(stream, { text: event.error, state: "error" }); }
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
    const activeChat = this.chats.get(this.state.activeChatId);
    if (activeChat && !activeChat.messages.length && !activeChat.title) this.renameChat(activeChat.id, chatTitle(userText));
    try {
      adapter = await this.adapter(this.state.provider);
      session = await adapter.openSession({
        workspaceId: this.context.workspace.id,
        branchId: this.context.branchId,
        conversationId: this.state.activeChatId,
        provider: this.state.provider,
        toolContractVersion: ARTBOARD_AGENT_TOOL_CONTRACT_VERSION,
        modelId: this.state.modelId,
        reasoningEffort: this.state.reasoningEffort,
      });
    } catch (error) {
      this.emit({ runState: "failed", error: providerErrorMessage(this.state.provider === "codex-local" ? "Codex lokal" : "OpenRouter", `Agent-Session konnte nicht gestartet werden: ${errorText(error)}`) });
      return;
    }
    const run: AgentRunSnapshot = {
      workspaceId: this.context.workspace.id,
      branchId: this.context.branchId,
      conversationId: this.state.activeChatId,
      provider: this.state.provider,
      toolContractVersion: ARTBOARD_AGENT_TOOL_CONTRACT_VERSION,
      runId: this.createId(), providerSessionId: session.providerSessionId,
      modelId: this.state.modelId, reasoningEffort: this.state.reasoningEffort,
      inputRevision: this.context.revision.number,
      selectedBoardRevisionIds: this.context.selection.boardIds.map((id) => this.context.workspace.boards[id]?.activeRevisionId).filter((id): id is string => Boolean(id)),
      state: "submitting", submittedAt: timestamp,
    };
    this.emit({
      // Keep the bounded timeline for auditability. Every new activity receives
      // this runId; transient canvas feedback filters by that ownership.
      prompt: "", error: undefined, proposal: undefined, usage: {}, tools: this.state.tools.slice(-100), run, runState: "submitting",
      messages: [...this.state.messages, this.message(userId, "user", userText, timestamp, "complete"), this.message(assistantId, "assistant", "", timestamp, "streaming")],
    });
    const stream: TurnStream = { activeAssistantId: assistantId };
    try {
      const result = await adapter.runTurn(run, userText, (event) => this.handleEvent(event, stream));
      const effectiveProposalId = this.state.run?.proposalId;
      if (!effectiveProposalId) {
        // The adapters emit `completed` before resolving. Capture it via a small event-independent fallback only when their snapshot already has it.
        throw new Error(`Der Agentenlauf ${result.providerTurnId} lieferte keinen lesbaren Vorschlag.`);
      }
      const proposal = validateResolvedProposal(await this.options.resolveProposal(effectiveProposalId), this.context);
      if (proposal.proposalId !== effectiveProposalId) throw new Error("Der geladene Vorschlag gehört nicht zu diesem Agentenlauf.");
      this.emit({ proposal, runState: "proposal-ready", run: this.state.run ? { ...this.state.run, providerTurnId: result.providerTurnId, proposalId: effectiveProposalId, state: "proposal-ready" } : undefined });
      this.finishAssistant(stream, { text: proposal.summary });
    } catch (error) {
      const text = errorText(error);
      const processLost = text.includes("CODEX_PROCESS_LOST");
      const interrupted = text.includes("INTERRUPTED") || this.state.runState === "interrupted";
      const state: ArtboardAgentRunState = processLost ? "process-lost" : interrupted ? "interrupted" : this.state.runState === "failed" ? "failed" : "failed";
      this.emit({ error: processLost ? "Codex lokal wurde unerwartet beendet. Der Lauf wird niemals automatisch erneut gesendet." : interrupted ? undefined : text, runState: state, run: this.state.run ? { ...this.state.run, state, error: processLost || !interrupted ? text : undefined } : undefined });
      this.finishAssistant(stream, interrupted ? { translationKey: "agent.message.interrupted" } : { text, state: "error" });
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

  async abandonUnknown() {
    if (!this.state.run || this.state.runState !== "unknown") return;
    const idle = { ...this.state.run, state: "idle" as const, error: undefined };
    try {
      await (await this.adapter(idle.provider)).saveRun(idle);
      this.emit({ run: idle, runState: "idle", error: undefined });
    } catch (error) { this.emit({ error: errorText(error) }); }
  }

  async rejectProposal() {
    if (!this.state.proposal || this.state.applying) return;
    const run = this.state.run;
    try {
      if (run) {
        const adapter = await this.adapter(run.provider);
        const rejecting = { ...run, state: "rejecting" as const };
        await adapter.saveRun(rejecting);
        this.emit({ run: rejecting, runState: "rejecting", error: undefined });
        const rejected = { ...rejecting, state: "rejected" as const };
        await adapter.saveRun(rejected);
        const item = this.message(this.createId(), "system", "", this.now().toISOString(), "complete", "agent.message.rejected");
        this.emit({ proposal: undefined, runState: "rejected", run: rejected, messages: [...this.state.messages, item], error: undefined });
      } else {
        const item = this.message(this.createId(), "system", "", this.now().toISOString(), "complete", "agent.message.rejected");
        this.emit({ proposal: undefined, runState: "rejected", messages: [...this.state.messages, item], error: undefined });
      }
    } catch (error) {
      this.emit({ run, runState: "proposal-ready", error: errorText(error) });
    }
  }

  async applyProposal() {
    if (!this.state.proposal || this.state.applying) return;
    const originalRun = this.state.run;
    let hostApplied = false;
    try {
      const proposal = validateResolvedProposal(this.state.proposal, this.context);
      if (!proposal.batch.operations.length) throw new Error("Dieser Vorschlag enthält keine direkten Artboard-Änderungen. Der kostenpflichtige Folgeauftrag bleibt bewusst getrennt und wurde nicht gestartet.");
      const run = this.state.run;
      const adapter = run ? await this.adapter(run.provider) : undefined;
      const applyingRun = run ? { ...run, state: "applying" as const } : undefined;
      if (adapter && applyingRun) await adapter.saveRun(applyingRun);
      this.emit({ applying: true, runState: "applying", run: applyingRun, error: undefined });
      await this.options.onApplyProposal(structuredClone(proposal.batch), structuredClone(proposal));
      hostApplied = true;
      const appliedRun = applyingRun ? { ...applyingRun, state: "applied" as const } : undefined;
      if (adapter && appliedRun) await adapter.saveRun(appliedRun);
      const item = this.message(this.createId(), "system", "", this.now().toISOString(), "complete", "agent.message.applied");
      this.emit({ applying: false, proposal: undefined, runState: "applied", run: appliedRun, messages: [...this.state.messages, item] });
    } catch (error) {
      if (hostApplied) {
        this.emit({ applying: false, proposal: undefined, runState: "unknown", run: this.state.run ? { ...this.state.run, state: "unknown", error: errorText(error) } : undefined, error: `Die Änderungen wurden angewendet, aber der Abschlussstatus konnte nicht gespeichert werden: ${errorText(error)}` });
        return;
      }
      if (originalRun) {
        try { await (await this.adapter(originalRun.provider)).saveRun({ ...originalRun, state: "proposal-ready" }); }
        catch { /* The persisted applying marker intentionally prevents an unsafe automatic re-apply. */ }
      }
      this.emit({ applying: false, run: originalRun, runState: "proposal-ready", error: errorText(error) });
    }
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
