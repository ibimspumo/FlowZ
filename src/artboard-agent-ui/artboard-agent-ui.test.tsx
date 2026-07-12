import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentRunSnapshot, ArtboardAgentAdapter, ArtboardAgentProvider, ArtboardAgentToolExecutor } from "../artboard-agent";
import { ARTBOARD_DOCUMENT_VERSION, ARTBOARD_WORKSPACE_VERSION, type ArtboardWorkspace } from "../nodes/brand/artboard-domain";
import { ArtboardDesignAgent } from "./ArtboardDesignAgent";
import { ArtboardAgentController } from "./controller";
import type { AgentAdapterFactory, ResolvedArtboardProposal } from "./types";
import { validateResolvedProposal } from "./validation";
import { setLocale } from "../i18n";

afterEach(()=>setLocale('de'));

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
  probe = vi.fn(async () => ({ state: "ready" as const }));
  listModels = vi.fn(async () => [{ provider: this.provider, id: `${this.provider}-model`, name: `${this.provider} Model`, inputModalities: ["text" as const], reasoningEfforts: this.provider === "codex-local" ? ["medium", "high"] : undefined }]);
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
  it("streams through mock adapters but never applies a proposal before explicit confirmation", async () => {
    const { factory } = makeFactory(); const apply = vi.fn();
    const ids = ["user-1", "assistant-1", "run-1", "system-1"];
    const controller = new ArtboardAgentController({ context, adapterFactory: factory, toolExecutor: executor, resolveProposal: vi.fn(async () => proposal), onApplyProposal: apply, createId: () => ids.shift() ?? "next" });
    await controller.initialize();
    expect(controller.getSnapshot().modelId).toBe("openrouter-model");
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
    expect(adapters.openrouter.runTurn).toHaveBeenCalledOnce();
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
    await controller.initialize(); controller.setPrompt("Neue Variante"); const running = controller.submit();
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
    await controller.initialize();
    // Inject through the normal run path so the persisted resolver remains authoritative.
    controller.setPrompt("Hero-Bild vormerken"); await controller.submit();
    await controller.applyProposal();
    expect(apply).not.toHaveBeenCalled();
    expect(controller.getSnapshot().proposal?.followUpIntents).toHaveLength(1);
  });
});

describe("Artboard Design Agent view", () => {
  it("renders a compact non-modal canvas palette with custom provider controls", () => {
    const { factory } = makeFactory();
    const html = renderToStaticMarkup(<ArtboardDesignAgent workspace={workspace} branchId="branch-main" revision={context.revision} selection={context.selection} adapterFactory={factory} toolExecutor={executor} resolveProposal={async () => proposal} onApplyProposal={() => undefined} initiallyOpen />);
    expect(html).toContain("Design-Agent");
    expect(html).toContain("Designänderung beschreiben");
    expect(html).toContain("Nichts wird ohne Bestätigung angewendet");
    expect(html).toContain('role="region"');
    expect(html).not.toContain('role="dialog"');
  });
  it('localizes the agent chrome without translating workspace content',()=>{setLocale('en');const {factory}=makeFactory();const html=renderToStaticMarkup(<ArtboardDesignAgent workspace={workspace} branchId="branch-main" revision={context.revision} selection={context.selection} adapterFactory={factory} toolExecutor={executor} resolveProposal={async()=>proposal} onApplyProposal={()=>undefined} initiallyOpen/>);expect(html).toContain('Design agent');expect(html).toContain('Describe a design change');expect(html).toContain('Nothing is applied without confirmation');expect(workspace.boards['board-1'].name).toBe('Titel');});
});
