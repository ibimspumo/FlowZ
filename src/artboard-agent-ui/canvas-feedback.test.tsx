import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ArtboardWorkspace } from "../nodes/brand/artboard-domain";
import { ArtboardCanvas } from "../artboard-workspace/ArtboardCanvas";
import type { ArtboardAgentControllerState } from "./types";
import { deriveAgentCanvasFeedback, fitAgentCanvasFeedback } from "./canvas-feedback";

const sourceBoard = {
  id: "board-source", name: "Original", activeRevisionId: "board-revision-source", createdAt: "2026-07-13T06:00:00.000Z",
  ancestry: { branchId: "branch-main" }, inputSnapshot: { id: "snapshot-source", createdAt: "2026-07-13T06:00:00.000Z", bindings: {} },
  document: {
    schemaVersion: 1 as const, id: "document-source", name: "Original", format: { preset: "instagram-post" as const, width: 1080, height: 1080 },
    paint: { kind: "solid" as const, color: "#FFFFFF" }, rootLayerIds: [], layers: {}, bindings: {}, tokenRefs: {},
  },
};

const workspace: ArtboardWorkspace = {
  schemaVersion: 1, id: "workspace-1", name: "Campaign", boards: { [sourceBoard.id]: sourceBoard },
  placements: { [sourceBoard.id]: { x: 100, y: 100 } }, selectedBoardIds: [sourceBoard.id], activeBoardId: sourceBoard.id,
  pasteboard: { margin: 100, gap: 220, grid: 20 },
};

const proposalBoard = {
  ...structuredClone(sourceBoard), id: "board-story", name: "Neue Perspektive", activeRevisionId: "board-revision-story", createdAt: "2026-07-13T06:01:00.000Z",
  ancestry: { branchId: "branch-main", parentBoardId: sourceBoard.id, sourceRevisionId: sourceBoard.activeRevisionId },
  inputSnapshot: { ...structuredClone(sourceBoard.inputSnapshot), id: "snapshot-story" },
  document: {
    ...structuredClone(sourceBoard.document), id: "document-story", name: "Neue Perspektive",
    format: { preset: "instagram-story" as const, width: 1080, height: 1920 }, paint: { kind: "solid" as const, color: "#17151C" },
    rootLayerIds: ["headline"],
    layers: {
      headline: { id: "headline", type: "text" as const, name: "Headline", locked: false, visible: true, version: 1, geometry: { x: 90, y: 140, width: 900, height: 260, rotation: 0 }, text: "NEUE PERSPEKTIVE", color: "#FFFFFF", fontSize: 96, align: "left" as const },
    },
  },
};

function state(patch: Partial<ArtboardAgentControllerState> = {}): ArtboardAgentControllerState {
  return {
    provider: "codex-local", providers: { "codex-local": { status: { state: "ready" }, models: [] }, openrouter: { status: { state: "ready" }, models: [] } },
    modelId: "gpt", prompt: "", messages: [], tools: [], chats: [], activeChatId: "chat-1", runState: "idle", usage: {}, applying: false,
    ...patch,
  };
}

const selection = { activeBoardId: sourceBoard.id, boardIds: [sourceBoard.id], layerIds: [] };

describe("artboard agent canvas feedback", () => {
  it("renders a complete transient candidate next to an unchanged source board", () => {
    const feedback = deriveAgentCanvasFeedback(state({
      runState: "proposal-ready",
      proposal: {
        proposalId: "proposal-story", summary: "Story erstellt", changes: [{ id: "change-1", kind: "add", label: "Story" }],
        batch: { operationId: "operation-story", expectedRevisionId: "revision-1", expectedRevisionNumber: 1, operations: [{ type: "create-board", board: proposalBoard, placement: { x: 1400, y: 100 } }] },
      },
    }), workspace, selection);

    expect(workspace.boards[sourceBoard.id].document.paint).toEqual({ kind: "solid", color: "#FFFFFF" });
    expect(Object.keys(workspace.boards)).toEqual([sourceBoard.id]);
    expect(feedback?.renderError).toBeUndefined();
    expect(feedback?.ghostBoards[0]).toMatchObject({ phase: "preview", placement: { x: 1400, y: 100 }, format: { width: 1080, height: 1920 } });

    const html = renderToStaticMarkup(<ArtboardCanvas
      workspace={workspace} zoom={.35} pan={{ x: 0, y: 0 }} resolveAsset={(hash) => `flowz-media:${hash}`}
      agentFeedback={feedback} onSelectBoard={vi.fn()} onSelectLayer={vi.fn()} onCommit={vi.fn()} onPan={vi.fn()}
    />);
    expect(html).toContain('data-board-id="board-source"');
    expect(html).toContain('data-agent-ghost-id="agent-preview-board-story"');
    expect(html).toContain("NEUE%20PERSPEKTIVE");
    expect(html).toContain("%2317151C");
    expect(html).toContain("Unangewendete Vorschau");

    const fit = fitAgentCanvasFeedback(feedback!, workspace, { width: 1600, height: 1000 });
    expect(fit).toBeDefined();
    const candidateLeft = feedback!.ghostBoards[0].placement.x * fit!.zoom + fit!.pan.x;
    const candidateRight = candidateLeft + feedback!.ghostBoards[0].format.width * fit!.zoom;
    expect(candidateLeft).toBeGreaterThanOrEqual(48);
    expect(candidateRight).toBeLessThanOrEqual(1600 - 452 + 1);
  });

  it("shows an early collision-free working ghost using dimensions from the request", () => {
    const feedback = deriveAgentCanvasFeedback(state({
      runState: "tool-executing",
      run: { workspaceId: workspace.id, branchId: "branch-main", conversationId: "chat-1", provider: "codex-local", toolContractVersion: "v2", runId: "run-1", providerSessionId: "session-1", modelId: "gpt", inputRevision: 1, selectedBoardRevisionIds: [sourceBoard.activeRevisionId], state: "tool-executing", submittedAt: "2026-07-13T06:01:00.000Z" },
      messages: [{ id: "message-1", role: "user", text: "Erstelle rechts eine Story in 1080 × 1920.", createdAt: "2026-07-13T06:01:00.000Z", sequence: 1 }],
      tools: [
        { id: "tool-1", runId: "run-1", tool: "create_board", state: "complete", sequence: 2 },
        { id: "tool-2", runId: "run-1", tool: "create_layers", state: "running", sequence: 3 },
      ],
    }), workspace, selection);
    expect(feedback).toMatchObject({ phase: "working", boardIds: [], ghostBoards: [{ format: { width: 1080, height: 1920 }, phase: "working" }] });
    expect(feedback!.ghostBoards[0].placement.x).toBeGreaterThanOrEqual(1400);
  });

  it("never reuses a prior create turn as a ghost during a later edit turn", () => {
    const feedback = deriveAgentCanvasFeedback(state({
      runState: "tool-executing",
      run: { workspaceId: workspace.id, branchId: "branch-main", conversationId: "chat-1", provider: "codex-local", toolContractVersion: "v2", runId: "run-edit", providerSessionId: "session-1", modelId: "gpt", inputRevision: 2, selectedBoardRevisionIds: [sourceBoard.activeRevisionId], state: "tool-executing", submittedAt: "2026-07-13T06:02:00.000Z" },
      tools: [
        { id: "old-create", runId: "run-create", tool: "duplicate_board_as_variant", state: "complete", sequence: 2 },
        { id: "current-edit", runId: "run-edit", tool: "update_layers", state: "running", sequence: 3 },
      ],
    }), workspace, selection);
    expect(feedback).toMatchObject({ phase: "working", boardIds: [sourceBoard.id], ghostBoards: [] });
  });

  it("removes transient feedback after failure or rejection", () => {
    expect(deriveAgentCanvasFeedback(state({ runState: "failed" }), workspace, selection)).toBeUndefined();
    expect(deriveAgentCanvasFeedback(state({ runState: "idle" }), workspace, selection)).toBeUndefined();
  });

  it("marks a whole-board removal as an unapplied destructive candidate", () => {
    const removable = { ...structuredClone(proposalBoard), id: "board-removable", name: "Alte Variante" };
    const twoBoards: ArtboardWorkspace = { ...structuredClone(workspace), boards: { [sourceBoard.id]: structuredClone(sourceBoard), [removable.id]: removable }, placements: { [sourceBoard.id]: { x: 100, y: 100 }, [removable.id]: { x: 1400, y: 100 } }, activeBoardId: removable.id, selectedBoardIds: [removable.id] };
    const feedback = deriveAgentCanvasFeedback(state({
      runState: "proposal-ready",
      proposal: { proposalId: "proposal-remove", summary: "Variante entfernen", changes: [{ id: "board:board-removable", kind: "remove", label: "Alte Variante entfernen" }], batch: { operationId: "operation-remove", expectedRevisionId: "revision-1", expectedRevisionNumber: 1, operations: [{ type: "delete-board", boardId: removable.id }] } },
    }), twoBoards, { activeBoardId: removable.id, boardIds: [removable.id], layerIds: [] });
    expect(feedback).toMatchObject({ phase: "preview", boardIds: [removable.id], removedBoardIds: [removable.id], ghostBoards: [] });
    const html = renderToStaticMarkup(<ArtboardCanvas workspace={twoBoards} zoom={.35} pan={{x:0,y:0}} resolveAsset={(hash)=>`flowz-media:${hash}`} agentFeedback={feedback} onSelectBoard={vi.fn()} onSelectLayer={vi.fn()} onCommit={vi.fn()} onPan={vi.fn()}/>);
    expect(html).toContain("is-agent-removing");
    expect(html).toContain("Wird nach Bestätigung entfernt");
    expect(twoBoards.boards[removable.id]).toBeDefined();
  });

  it("fails closed when the canonical candidate cannot be built", () => {
    const feedback = deriveAgentCanvasFeedback(state({
      runState: "proposal-ready",
      proposal: {
        proposalId: "proposal-invalid", summary: "Ungültig", changes: [],
        batch: { operationId: "operation-invalid", expectedRevisionId: "revision-1", expectedRevisionNumber: 1, operations: [{ type: "create-board", board: { ...proposalBoard, id: sourceBoard.id }, placement: { x: 1400, y: 100 } }] },
      },
    }), workspace, selection);
    expect(feedback?.renderError).toMatch(/existiert bereits|bereits/);
    expect(feedback?.ghostBoards).toEqual([]);
    expect(fitAgentCanvasFeedback(feedback!, workspace, { width: 1600, height: 1000 })).toBeUndefined();
  });
});
