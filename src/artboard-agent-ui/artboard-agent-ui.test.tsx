import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentProviderStatus, AgentRunSnapshot, ArtboardAgentAdapter, ArtboardAgentProvider, ArtboardAgentToolExecutor } from "../artboard-agent";
import { ARTBOARD_DOCUMENT_VERSION, ARTBOARD_WORKSPACE_VERSION, type ArtboardWorkspace } from "../nodes/brand/artboard-domain";
import {
  AgentChatDeleteConfirmation, AgentChatMenu, AgentConversationViewport, AgentTimeline, ArtboardDesignAgent,
  ConversationFollowButton, conversationActivityKey, conversationDistanceFromBottom, isConversationNearBottom, shouldAutoFollowConversation,
} from "./ArtboardDesignAgent";
import { ArtboardAgentController } from "./controller";
import { ARTBOARD_AGENT_PROVIDER_ORDER, type AgentAdapterFactory, type ResolvedArtboardProposal } from "./types";
import { validateResolvedProposal } from "./validation";
import { setLocale } from "../i18n";
import { MarkdownView } from "../components/MarkdownView";

afterEach(()=>{setLocale('de');vi.unstubAllGlobals();});

function installLocalStorage() {
  const values = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  } satisfies Storage;
  vi.stubGlobal("window", { localStorage });
  return localStorage;
}

const workspace: ArtboardWorkspace = {
  schemaVersion: ARTBOARD_WORKSPACE_VERSION, id: "workspace-1", name: "Launch", activeBoardId: "board-1", selectedBoardIds: ["board-1"],
  placements: { "board-1": { x: 0, y: 0 } }, pasteboard: { margin: 100, gap: 200, grid: 20 },
  boards: { "board-1": {
    id: "board-1", name: "Titel", activeRevisionId: "board-revision-1", createdAt: "2026-07-12T10:00:00.000Z",
    ancestry: { branchId: "branch-main" }, inputSnapshot: { id: "snapshot-1", createdAt: "2026-07-12T10:00:00.000Z", bindings: {} },
    document: { schemaVersion: ARTBOARD_DOCUMENT_VERSION, id: "document-1", name: "Titel", format: { preset: "instagram-post", width: 1080, height: 1080 }, paint: { kind: "solid", color: "#FFFFFF" }, layers: {}, rootLayerIds: [], bindings: {}, tokenRefs: {} },
  } },
};
const context = { workspace, branchId: "branch-main", revision: { id: "revision-4", number: 4 }, selection: { activeBoardId: "board-1", boardIds: ["board-1"], layerIds: [] } };
const proposal: ResolvedArtboardProposal = {
  proposalId: "proposal-1", summary: "Titel in Pink", changes: [{ id: "diff-1", kind: "change", label: "Hintergrund", before: "Weiß", after: "Pink" }],
  batch: { operationId: "agent-operation-1", expectedRevisionId: "revision-4", expectedRevisionNumber: 4, operations: [{ type: "set-board-paint", boardId: "board-1", color: "#EE3399" }] },
};

class MockAdapter implements ArtboardAgentAdapter {
  constructor(readonly provider: ArtboardAgentProvider) {}
  probe = vi.fn(async (): Promise<AgentProviderStatus> => ({ state: "ready" as const }));
  listModels = vi.fn(async () => [{ provider: this.provider, id: `${this.provider}-model`, name: `${this.provider} Model`, inputModalities: ["text" as const], reasoningEfforts: this.provider === "codex-local" ? ["medium", "high"] : undefined }]);
  latestRun = vi.fn<ArtboardAgentAdapter["latestRun"]>(async () => undefined);
  saveRun = vi.fn<ArtboardAgentAdapter["saveRun"]>(async () => undefined);
  openSession = vi.fn(async (input) => ({ ...input, providerSessionId: `${this.provider}-session` }));
  runTurn = vi.fn(async (run: AgentRunSnapshot, _text: string, onEvent: (event: AgentEvent) => void) => {
    onEvent({ type: "provider-turn-started", providerTurnId: "turn-1" });
    onEvent({ type: "text-delta", text: "Ich habe einen klareren Entwurf vorbereitet." });
    onEvent({ type: "tool-started", tool: "set_board_properties", operationId: "op-1" });
    onEvent({ type: "tool-completed", tool: "set_board_properties", operationId: "op-1", success: true });
    onEvent({ type: "usage", inputTokens: 120, outputTokens: 40, costMicrounits: 2500 });
    onEvent({ type: "proposal-updated", proposalId: "proposal-1" });
    onEvent({ type: "completed", proposalId: "proposal-1" });
    return { providerTurnId: "turn-1" };
  });
  cancel = vi.fn(async () => undefined);
  recover = vi.fn(async (run: AgentRunSnapshot) => run);
  close = vi.fn(async () => undefined);
}

const executor: ArtboardAgentToolExecutor = { execute: vi.fn(async () => ({ content: {} })) };
const makeFactory = () => {
  const adapters = { openrouter: new MockAdapter("openrouter"), "codex-local": new MockAdapter("codex-local") };
  const factory: AgentAdapterFactory = { create: vi.fn((provider: ArtboardAgentProvider) => adapters[provider]) };
  return { adapters, factory };
};

describe("Artboard Design Agent controller", () => {
  it("restores a frozen proposal-ready run for the active persisted conversation", async () => {
    installLocalStorage();
    const { factory, adapters } = makeFactory();
    const seed = new ArtboardAgentController({ context, adapterFactory: factory, toolExecutor: executor, resolveProposal: async () => proposal, onApplyProposal: vi.fn() });
    const conversationId = seed.getSnapshot().activeChatId;
    await seed.dispose();
    adapters["codex-local"].latestRun = vi.fn(async () => ({
      runId: "restored-run", workspaceId: workspace.id, branchId: context.branchId, conversationId,
      provider: "codex-local", toolContractVersion: "flowz-artboard-tools-v2", providerSessionId: "thread-restored",
      modelId: "codex-local-model", inputRevision: 4, selectedBoardRevisionIds: ["board-revision-1"], state: "proposal-ready",
      submittedAt: "2026-07-12T10:00:00.000Z", proposalId: proposal.proposalId,
    }));
    const controller = new ArtboardAgentController({ context, adapterFactory: factory, toolExecutor: executor, resolveProposal: async () => proposal, onApplyProposal: vi.fn() });
    await controller.initialize();
    expect(controller.getSnapshot()).toMatchObject({ activeChatId: conversationId, runState: "proposal-ready", proposal: { proposalId: "proposal-1" }, run: { runId: "restored-run" } });
  });

  it("persists bounded conversations per workspace and isolates provider sessions by conversation id", async () => {
    const localStorage = installLocalStorage();
    const { factory, adapters } = makeFactory();
    const first = new ArtboardAgentController({ context, adapterFactory: factory, toolExecutor: executor, resolveProposal: async () => proposal, onApplyProposal: vi.fn() });
    await first.initialize();
    const firstChatId = first.getSnapshot().activeChatId;
    first.setPrompt("Erstelle eine elegante Story");
    await first.submit();
    expect(first.getSnapshot().chats.find((chat) => chat.id === firstChatId)?.title).toBe("Erstelle eine elegante Story");

    first.createChat();
    const secondChatId = first.getSnapshot().activeChatId;
    expect(secondChatId).not.toBe(firstChatId);
    expect(first.getSnapshot().messages).toEqual([]);
    first.setPrompt("Zweite Richtung");
    await first.submit();
    expect(adapters["codex-local"].openSession.mock.calls.map(([input]) => input.conversationId)).toEqual([firstChatId, secondChatId]);

    first.selectChat(firstChatId);
    expect(first.getSnapshot().messages.some((item) => item.text.includes("elegante Story"))).toBe(true);
    first.renameChat(firstChatId, "Story Kampagne");
    first.selectChat(secondChatId);
    await first.dispose();

    const restored = new ArtboardAgentController({ context, adapterFactory: makeFactory().factory, toolExecutor: executor, resolveProposal: async () => proposal, onApplyProposal: vi.fn() });
    expect(restored.getSnapshot().activeChatId).toBe(secondChatId);
    expect(restored.getSnapshot().chats).toHaveLength(2);
    expect(restored.getSnapshot().chats.find((chat) => chat.id === firstChatId)?.title).toBe("Story Kampagne");
    expect(localStorage.getItem(`flowz.artboard-agent.chats.v2:${workspace.id}`)).not.toMatch(/https?:|data:image|sk-/i);
    restored.deleteChat(secondChatId);
    expect(restored.getSnapshot().activeChatId).toBe(firstChatId);
  });

  it("defaults to Codex local and never silently falls back when it is unavailable", async () => {
    const { factory, adapters } = makeFactory();
    adapters["codex-local"].probe = vi.fn(async () => ({ state: "unavailable" as const, reason: "Codex CLI fehlt." }));
    const controller = new ArtboardAgentController({ context, adapterFactory: factory, toolExecutor: executor, resolveProposal: async () => proposal, onApplyProposal: vi.fn() });
    await controller.initialize();
    expect(controller.getSnapshot()).toMatchObject({ provider: "codex-local", modelId: "", providers: { "codex-local": { status: { state: "unavailable", reason: "Codex CLI fehlt." } }, openrouter: { status: { state: "ready" } } } });
    controller.setPrompt("Entwurf"); await controller.submit();
    expect(adapters["codex-local"].openSession).not.toHaveBeenCalled();
    expect(adapters.openrouter.openSession).not.toHaveBeenCalled();
  });

  it("streams through mock adapters but never applies a proposal before explicit confirmation", async () => {
    const { factory } = makeFactory(); const apply = vi.fn();
    const ids = ["user-1", "assistant-1", "run-1", "system-1"];
    const controller = new ArtboardAgentController({ context, adapterFactory: factory, toolExecutor: executor, resolveProposal: vi.fn(async () => proposal), onApplyProposal: apply, createId: () => ids.shift() ?? "next" });
    await controller.initialize();
    expect(controller.getSnapshot()).toMatchObject({ provider: "codex-local", modelId: "codex-local-model" });
    controller.setPrompt("Mach den Hintergrund pink");
    await controller.submit();
    expect(apply).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ runState: "proposal-ready", proposal: { proposalId: "proposal-1" }, usage: { inputTokens: 120, outputTokens: 40, costMicrounits: 2500 } });
    expect(controller.getSnapshot().messages[1].text).toContain("klareren Entwurf");
    expect(controller.getSnapshot().tools[0]).toMatchObject({ tool: "set_board_properties", state: "complete" });
    await controller.applyProposal();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(proposal.batch, proposal);
    expect(controller.getSnapshot().proposal).toBeUndefined();
    expect(controller.getSnapshot().messages.at(-1)?.translationKey).toBe("agent.message.applied");
  });

  it("starts a new assistant bubble after every dynamic tool boundary", async () => {
    const { factory, adapters } = makeFactory();
    adapters["codex-local"].runTurn = vi.fn(async (_run, _text, onEvent) => {
      onEvent({ type: "text-delta", text: "Vor **dem Tool**" });
      onEvent({ type: "tool-started", tool: "get_board", operationId: "read-board" });
      onEvent({ type: "tool-completed", tool: "get_board", operationId: "read-board", success: true });
      onEvent({ type: "text-delta", text: "Nach `layout.ts`" });
      onEvent({ type: "proposal-updated", proposalId: "proposal-1" });
      onEvent({ type: "completed", proposalId: "proposal-1" });
      return { providerTurnId: "turn-segmented" };
    });
    const controller = new ArtboardAgentController({ context, adapterFactory: factory, toolExecutor: executor, resolveProposal: async () => proposal, onApplyProposal: vi.fn() });
    await controller.initialize();
    controller.setPrompt("Layout prüfen");
    await controller.submit();

    const assistantMessages = controller.getSnapshot().messages.filter((item) => item.role === "assistant");
    const [before, after] = assistantMessages;
    const tool = controller.getSnapshot().tools[0];
    expect(assistantMessages.map((item) => item.text)).toEqual(["Vor **dem Tool**", "Nach `layout.ts`"]);
    expect(before.sequence).toBeLessThan(tool.sequence);
    expect(tool.sequence).toBeLessThan(after.sequence);
    expect(assistantMessages.every((item) => item.state === "complete")).toBe(true);

    adapters["codex-local"].runTurn = vi.fn(async (_run, _text, onEvent) => {
      onEvent({ type: "text-delta", text: "Zweiter Turn ohne Werkzeug." });
      onEvent({ type: "proposal-updated", proposalId: "proposal-1" });
      onEvent({ type: "completed", proposalId: "proposal-1" });
      return { providerTurnId: "turn-two" };
    });
    controller.setPrompt("Noch einmal prüfen");
    await controller.submit();
    expect(controller.getSnapshot().tools).toContainEqual(expect.objectContaining({ id: "read-board", state: "complete" }));
  });

  it("rejects stale or structurally invalid batches before they reach the host", async () => {
    expect(() => validateResolvedProposal({ ...proposal, batch: { ...proposal.batch, expectedRevisionNumber: 3 } }, context)).toThrow(/seit diesem Vorschlag geändert/);
    expect(() => validateResolvedProposal({ ...proposal, batch: { ...proposal.batch, operations: [{ type: "set-board-paint", boardId: "missing", color: "#000000" }] } }, context)).toThrow(/nicht vorhandenes Artboard/);
  });

  it("fails closed when the workspace revision changes before confirmation", async () => {
    const { factory } = makeFactory(); const apply = vi.fn();
    const controller = new ArtboardAgentController({ context, adapterFactory: factory, toolExecutor: executor, resolveProposal: async () => proposal, onApplyProposal: apply });
    await controller.initialize(); controller.setPrompt("Hintergrund ändern"); await controller.submit();
    controller.updateContext({ ...context, revision: { id: "revision-5", number: 5 } });
    await controller.applyProposal();
    expect(apply).not.toHaveBeenCalled();
    expect(controller.getSnapshot().error).toMatch(/seit diesem Vorschlag geändert/);
    expect(controller.getSnapshot().proposal?.proposalId).toBe("proposal-1");
  });

  it("does not replace its persisted workspace snapshot with optimistic surface content", async () => {
    const { factory, adapters } = makeFactory();
    const optimistic = structuredClone(workspace);
    optimistic.boards["board-optimistic"] = { ...structuredClone(workspace.boards["board-1"]), id: "board-optimistic", name: "Noch nicht gespeichert" };
    optimistic.placements["board-optimistic"] = { x: 1200, y: 0 };
    const optimisticProposal: ResolvedArtboardProposal = { ...proposal, batch: { ...proposal.batch, operations: [{ type: "set-board-paint", boardId: "board-optimistic", color: "#000000" }] } };
    const controller = new ArtboardAgentController({ context, adapterFactory: factory, toolExecutor: executor, resolveProposal: async () => optimisticProposal, onApplyProposal: vi.fn() });
    await controller.initialize();
    controller.updateViewContext({ ...context, workspace: optimistic });
    controller.setPrompt("Optimistisches Board ändern"); await controller.submit();
    expect(adapters["codex-local"].runTurn).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().proposal).toBeUndefined();
    expect(controller.getSnapshot().error).toMatch(/nicht vorhandenes Artboard/);
  });

  it("exposes provider probing, model switching and cancellation through injected adapters", async () => {
    const { factory, adapters } = makeFactory();
    let finish: (() => void) | undefined;
    adapters["codex-local"].runTurn = vi.fn(async (_run, _text, onEvent) => {
      onEvent({ type: "status", status: "streaming" });
      await new Promise<void>((resolve) => { finish = resolve; });
      onEvent({ type: "interrupted" });
      throw new Error("CODEX_INTERRUPTED");
    });
    const controller = new ArtboardAgentController({ context, adapterFactory: factory, toolExecutor: executor, resolveProposal: vi.fn(async () => proposal), onApplyProposal: vi.fn() });
    await controller.initialize(); controller.selectProvider("codex-local"); controller.selectModel("codex-local-model"); controller.setReasoningEffort("high"); controller.setPrompt("Variante bauen");
    const running = controller.submit();
    await vi.waitFor(() => expect(controller.getSnapshot().runState).toBe("streaming"));
    await controller.cancel();
    expect(adapters["codex-local"].cancel).toHaveBeenCalledOnce();
    finish?.(); await running;
    expect(controller.getSnapshot().runState).toBe("interrupted");
  });

  it("surfaces a lost local process without resubmitting the paid turn", async () => {
    const { factory, adapters } = makeFactory();
    adapters["codex-local"].runTurn = vi.fn(async () => { throw new Error("CODEX_PROCESS_LOST"); });
    adapters["codex-local"].recover = vi.fn(async (run) => ({ ...run, state: "unknown", error: "Turn nicht eindeutig auffindbar." }));
    const controller = new ArtboardAgentController({ context, adapterFactory: factory, toolExecutor: executor, resolveProposal: async () => proposal, onApplyProposal: vi.fn() });
    await controller.initialize(); controller.selectProvider("codex-local"); controller.setPrompt("Neue Variante"); await controller.submit();
    expect(controller.getSnapshot().runState).toBe("process-lost");
    expect(adapters["codex-local"].runTurn).toHaveBeenCalledTimes(1);
    await controller.recover();
    expect(controller.getSnapshot().runState).toBe("unknown");
    expect(adapters["codex-local"].runTurn).toHaveBeenCalledTimes(1);
  });

  it("cancels an active provider turn before closing adapters on unmount", async () => {
    const { factory, adapters } = makeFactory();
    let release: (() => void) | undefined;
    adapters.openrouter.runTurn = vi.fn(async (_run, _text, onEvent) => {
      onEvent({ type: "status", status: "streaming" });
      await new Promise<void>((resolve) => { release = resolve; });
      throw new Error("INTERRUPTED");
    });
    const controller = new ArtboardAgentController({ context, adapterFactory: factory, toolExecutor: executor, resolveProposal: async () => proposal, onApplyProposal: vi.fn() });
    await controller.initialize(); controller.selectProvider("openrouter"); controller.setPrompt("Neue Variante"); const running = controller.submit();
    await vi.waitFor(() => expect(controller.getSnapshot().runState).toBe("streaming"));
    await controller.dispose();
    expect(adapters.openrouter.cancel).toHaveBeenCalledOnce();
    expect(adapters.openrouter.close).toHaveBeenCalledOnce();
    release?.(); await running;
  });

  it("keeps a paid fal.ai intent visible but cannot apply it as a silent empty batch", async () => {
    const { factory, adapters } = makeFactory(); const apply = vi.fn();
    const paidOnly: ResolvedArtboardProposal = {
      proposalId: "proposal-paid", summary: "Bildwunsch vorbereitet",
      batch: { operationId: "agent-paid", expectedRevisionId: "revision-4", expectedRevisionNumber: 4, operations: [] },
      changes: [{ id: "fal-intent-1", kind: "add", label: "Bildgenerierung vorbereiten" }],
      followUpIntents: [{ id: "fal-intent-1", provider: "fal.ai", boardId: "board-1", prompt: "Produktfoto", role: "Hero", aspectRatio: "1:1", referenceBindingIds: [], requiresExplicitConfirmation: true }],
    };
    expect(validateResolvedProposal(paidOnly, context).followUpIntents).toHaveLength(1);
    adapters.openrouter.runTurn = vi.fn(async (_run, _text, onEvent) => {
      onEvent({ type: "proposal-updated", proposalId: "proposal-paid" });
      onEvent({ type: "completed", proposalId: "proposal-paid" });
      return { providerTurnId: "turn-paid" };
    });
    const controller = new ArtboardAgentController({ context, adapterFactory: factory, toolExecutor: executor, resolveProposal: async () => paidOnly, onApplyProposal: apply });
    await controller.initialize(); controller.selectProvider("openrouter");
    // Inject through the normal run path so the persisted resolver remains authoritative.
    controller.setPrompt("Hero-Bild vormerken"); await controller.submit();
    await controller.applyProposal();
    expect(apply).not.toHaveBeenCalled();
    expect(controller.getSnapshot().proposal?.followUpIntents).toHaveLength(1);
  });

  it("persists apply and reject as terminal outcomes so a restart cannot revive the proposal", async () => {
    installLocalStorage();
    const { factory, adapters } = makeFactory();
    const applied = new ArtboardAgentController({ context, adapterFactory: factory, toolExecutor: executor, resolveProposal: async () => proposal, onApplyProposal: vi.fn() });
    await applied.initialize(); applied.setPrompt("Anwenden"); await applied.submit(); await applied.applyProposal();
    expect(applied.getSnapshot()).toMatchObject({ runState: "applied", proposal: undefined });
    expect(adapters["codex-local"].saveRun).toHaveBeenLastCalledWith(expect.objectContaining({ state: "applied", proposalId: "proposal-1" }));

    applied.createChat(); applied.setPrompt("Verwerfen"); await applied.submit(); await applied.rejectProposal();
    expect(applied.getSnapshot()).toMatchObject({ runState: "rejected", proposal: undefined });
    expect(adapters["codex-local"].saveRun).toHaveBeenLastCalledWith(expect.objectContaining({ state: "rejected", proposalId: "proposal-1" }));
    expect(adapters["codex-local"].saveRun.mock.calls.slice(-2).map(([run]) => run.state)).toEqual(["rejecting", "rejected"]);
  });

  it("deleting an inactive chat cannot clear the active chat proposal", async () => {
    installLocalStorage();
    const { factory } = makeFactory();
    const controller = new ArtboardAgentController({ context, adapterFactory: factory, toolExecutor: executor, resolveProposal: async () => proposal, onApplyProposal: vi.fn() });
    await controller.initialize();
    const first = controller.getSnapshot().activeChatId;
    controller.createChat(); const inactive = controller.getSnapshot().activeChatId;
    controller.selectChat(first); await Promise.resolve();
    controller.setPrompt("Aktiver Vorschlag"); await controller.submit();
    controller.deleteChat(inactive);
    expect(controller.getSnapshot()).toMatchObject({ activeChatId: first, runState: "proposal-ready", proposal: { proposalId: "proposal-1" } });
  });

  it("restores a non-ready persisted run without resubmitting it", async () => {
    installLocalStorage();
    const { factory, adapters } = makeFactory();
    const seed = new ArtboardAgentController({ context, adapterFactory: factory, toolExecutor: executor, resolveProposal: async () => proposal, onApplyProposal: vi.fn() });
    const conversationId = seed.getSnapshot().activeChatId; await seed.dispose();
    adapters["codex-local"].latestRun = vi.fn(async () => ({
      runId: "run-recover", workspaceId: workspace.id, branchId: context.branchId, conversationId,
      provider: "codex-local", toolContractVersion: "flowz-artboard-tools-v2", providerSessionId: "thread-recover", providerTurnId: "turn-recover",
      modelId: "codex-local-model", inputRevision: 4, selectedBoardRevisionIds: [], state: "streaming", submittedAt: "2026-07-12T10:00:00.000Z",
    }));
    adapters["codex-local"].recover = vi.fn(async (run) => ({ ...run, state: "unknown" as const, error: "Status nicht eindeutig." }));
    const controller = new ArtboardAgentController({ context, adapterFactory: factory, toolExecutor: executor, resolveProposal: async () => proposal, onApplyProposal: vi.fn() });
    await controller.initialize();
    expect(adapters["codex-local"].recover).toHaveBeenCalledOnce();
    expect(adapters["codex-local"].runTurn).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ runState: "unknown", error: "Status nicht eindeutig." });
  });

  it("restores the active provider without waiting for an unrelated provider probe", async () => {
    installLocalStorage();
    const { factory, adapters } = makeFactory();
    adapters.openrouter.probe = vi.fn(() => new Promise<AgentProviderStatus>(() => undefined));
    const controller = new ArtboardAgentController({ context, adapterFactory: factory, toolExecutor: executor, resolveProposal: async () => proposal, onApplyProposal: vi.fn() });
    await Promise.race([
      controller.initialize(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("initialize waited for the inactive provider")), 100)),
    ]);
    expect(controller.getSnapshot().providers["codex-local"].status.state).toBe("ready");
    expect(controller.getSnapshot().providers.openrouter.status.state).toBe("probing");
  });
});

describe("Artboard Design Agent view", () => {
  it("only follows conversation activity while the reader remains near the bottom", () => {
    expect(conversationDistanceFromBottom({ scrollHeight: 1000, scrollTop: 460, clientHeight: 500 })).toBe(40);
    expect(isConversationNearBottom({ scrollHeight: 1000, scrollTop: 460, clientHeight: 500 })).toBe(true);
    expect(isConversationNearBottom({ scrollHeight: 1000, scrollTop: 439, clientHeight: 500 })).toBe(false);
    expect(isConversationNearBottom({ scrollHeight: 300, scrollTop: 0, clientHeight: 500 })).toBe(true);
    expect(shouldAutoFollowConversation({ wasFollowing: false, changedChat: false, submitted: false, runStarted: false })).toBe(false);
    expect(shouldAutoFollowConversation({ wasFollowing: false, changedChat: true, submitted: false, runStarted: false })).toBe(true);
    expect(shouldAutoFollowConversation({ wasFollowing: false, changedChat: false, submitted: true, runStarted: false })).toBe(true);

    const message = { id: "assistant-1", role: "assistant" as const, text: "Entwurf", createdAt: "2026-07-12T10:00:00.000Z", state: "streaming" as const, sequence: 1 };
    const initial = conversationActivityKey([message], [{ id: "tool-1", tool: "get_board", state: "running", sequence: 2 }]);
    expect(conversationActivityKey([{ ...message, text: "Entwurf wächst" }], [{ id: "tool-1", tool: "get_board", state: "running", sequence: 2 }])).not.toBe(initial);
    expect(conversationActivityKey([message], [{ id: "tool-1", tool: "get_board", state: "complete", sequence: 2 }])).not.toBe(initial);
  });

  it("renders an accessible localized unread affordance and keyboard-scrollable history", () => {
    const button = renderToStaticMarkup(<ConversationFollowButton onClick={() => undefined} />);
    expect(button).toContain("Zum neuesten Stand");
    expect(button).toContain("<button");
    expect(button).toContain('aria-hidden="true"');
    const history = renderToStaticMarkup(<AgentConversationViewport messages={[]} tools={[]} activeChatId="chat-1" runState="idle" />);
    expect(history).toContain('tabindex="0"');
    expect(history).toContain('aria-label="Chatverlauf"');

    setLocale("en");
    expect(renderToStaticMarkup(<ConversationFollowButton onClick={() => undefined} />)).toContain("Jump to latest");
    expect(renderToStaticMarkup(<AgentConversationViewport messages={[]} tools={[]} activeChatId="chat-1" runState="idle" />)).toContain('aria-label="Chat history"');
  });

  it("renders the chat selector CRUD surface with accessible labels and explicit deletion confirmation", () => {
    const chats = [
      { id: "chat-1", title: "Launch-Konzept", createdAt: "2026-07-12T08:00:00.000Z", updatedAt: "2026-07-12T10:30:00.000Z" },
      { id: "chat-2", title: "Story-Varianten", createdAt: "2026-07-12T09:00:00.000Z", updatedAt: "2026-07-12T11:00:00.000Z" },
    ];
    const html = renderToStaticMarkup(<AgentChatMenu chats={chats} activeChatId="chat-2" onSelect={() => undefined} onCreate={() => undefined} onRename={() => undefined} onDelete={() => undefined} onClose={() => undefined} />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-label="Chats"');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("Launch-Konzept");
    expect(html).toContain("Story-Varianten");
    expect(html).toContain("Neuer Chat");
    expect(html).toContain('aria-label="„Launch-Konzept“ umbenennen"');
    expect(html).toContain('aria-label="„Launch-Konzept“ löschen"');

    const confirmation = renderToStaticMarkup(<AgentChatDeleteConfirmation title="Launch-Konzept" onCancel={() => undefined} onConfirm={() => undefined} />);
    expect(confirmation).toContain('role="alert"');
    expect(confirmation).toContain("„Launch-Konzept“ wirklich löschen?");
    expect(confirmation).toContain("Abbrechen");
    expect(confirmation).toContain("Löschen");
  });

  it("localizes the complete chat selector surface in English", () => {
    setLocale("en");
    const html = renderToStaticMarkup(<AgentChatMenu chats={[{ id: "chat-1", title: "Launch", createdAt: "2026-07-12T08:00:00.000Z", updatedAt: "2026-07-12T10:30:00.000Z" }]} activeChatId="chat-1" onSelect={() => undefined} onCreate={() => undefined} onRename={() => undefined} onDelete={() => undefined} onClose={() => undefined} />);
    expect(html).toContain("New chat");
    expect(html).toContain('aria-label="Rename “Launch”"');
    expect(html).toContain('aria-label="Delete “Launch”"');
    expect(renderToStaticMarkup(<AgentChatDeleteConfirmation title="Launch" onCancel={() => undefined} onConfirm={() => undefined} />)).toContain("Delete “Launch”?");
  });

  it("renders messages and tool activity in chronological order and supports compact Markdown semantics", () => {
    const html = renderToStaticMarkup(<AgentTimeline
      messages={[
        { id: "assistant-before", role: "assistant", text: "Vor **dem Tool**", createdAt: "2026-07-12T10:00:00.000Z", state: "complete", sequence: 1 },
        { id: "assistant-after", role: "assistant", text: "Nach `layout.ts`", createdAt: "2026-07-12T10:00:01.000Z", state: "complete", sequence: 3 },
      ]}
      tools={[{ id: "tool-1", tool: "get_board", state: "complete", sequence: 2 }]}
    />);
    const beforeIndex = html.indexOf('message-assistant-before');
    const toolIndex = html.indexOf('tool-tool-1');
    const afterIndex = html.indexOf('message-assistant-after');
    expect(beforeIndex).toBeGreaterThan(-1);
    expect(beforeIndex).toBeLessThan(toolIndex);
    expect(toolIndex).toBeLessThan(afterIndex);

    const markdown = renderToStaticMarkup(<MarkdownView value={"**Fett** mit `layout.ts`\n\n- Eins\n- Zwei\n\n[Quelle](https://example.com)"} />);
    expect(markdown).toContain("<strong>Fett</strong>");
    expect(markdown).toContain("<code>layout.ts</code>");
    expect(markdown).toContain("<ul>");
    expect(markdown).toContain('href="https://example.com"');
  });

  it("renders a compact non-modal canvas palette with custom provider controls", () => {
    const { factory } = makeFactory();
    const html = renderToStaticMarkup(<ArtboardDesignAgent workspace={workspace} branchId="branch-main" revision={context.revision} selection={context.selection} adapterFactory={factory} toolExecutor={executor} resolveProposal={async () => proposal} onApplyProposal={() => undefined} initiallyOpen />);
    expect(html).toContain("Design-Agent");
    expect(html).toContain("Designänderung beschreiben");
    expect(html).toContain("Nichts wird ohne Bestätigung angewendet");
    expect(html).toContain('role="region"');
    expect(html).not.toContain('role="dialog"');
    expect(ARTBOARD_AGENT_PROVIDER_ORDER).toEqual(["codex-local", "openrouter"]);
  });
  it('localizes the agent chrome without translating workspace content',()=>{setLocale('en');const {factory}=makeFactory();const html=renderToStaticMarkup(<ArtboardDesignAgent workspace={workspace} branchId="branch-main" revision={context.revision} selection={context.selection} adapterFactory={factory} toolExecutor={executor} resolveProposal={async()=>proposal} onApplyProposal={()=>undefined} initiallyOpen/>);expect(html).toContain('Design agent');expect(html).toContain('Describe a design change');expect(html).toContain('Nothing is applied without confirmation');expect(workspace.boards['board-1'].name).toBe('Titel');});
});
