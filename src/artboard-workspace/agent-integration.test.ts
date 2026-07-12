import { describe, expect, it } from "vitest";
import { ARTBOARD_DOCUMENT_VERSION, ARTBOARD_WORKSPACE_VERSION, type ArtboardWorkspace } from "../nodes/brand/artboard-domain";
import type { OpenArtboardDocument } from "./repository";
import { assertAgentBatchMatchesHead, SurfaceArtboardAgentContextProvider } from "./agent-integration";

const workspace: ArtboardWorkspace = {
  schemaVersion: ARTBOARD_WORKSPACE_VERSION, id: "workspace-1", name: "Launch", activeBoardId: "board-1", selectedBoardIds: ["board-1"],
  placements: { "board-1": { x: 0, y: 0 } }, pasteboard: { margin: 100, gap: 200, grid: 20 },
  boards: { "board-1": { id: "board-1", name: "Post", activeRevisionId: "board-revision-1", createdAt: "2026-07-12T12:00:00.000Z", ancestry: { branchId: "branch-1" }, inputSnapshot: { id: "snapshot-1", createdAt: "2026-07-12T12:00:00.000Z", bindings: {} }, document: { schemaVersion: ARTBOARD_DOCUMENT_VERSION, id: "document-1", name: "Post", format: { preset: "instagram-post", width: 1080, height: 1080 }, paint: { kind: "solid", color: "#FFFFFF" }, rootLayerIds: [], layers: {}, bindings: {}, tokenRefs: {} } } },
};

const opened = (): OpenArtboardDocument => ({
  record: { id: "record-1", name: "Launch", createdAt: "2026-07-12T12:00:00.000Z", updatedAt: "2026-07-12T12:00:00.000Z", branches: [] },
  branch: { id: "branch-1", workspaceId: "record-1", name: "Main", headRevisionId: "revision-4", createdAt: "2026-07-12T12:00:00.000Z" },
  revision: { id: "revision-4", workspaceId: "record-1", branchId: "branch-1", revisionNumber: 4, operationId: "operation-4", operations: [], createdAt: "2026-07-12T12:00:00.000Z", workspace },
});

describe("Artboard agent surface integration", () => {
  it("serves only the exact persisted head and current ephemeral selection", async () => {
    const current = opened();
    const provider = new SurfaceArtboardAgentContextProvider(() => current, () => ({ activeBoardId: "board-1", boardIds: ["board-1"], layerIds: ["headline"] }));
    const context = await provider.getContext({ workspaceId: "workspace-1", branchId: "branch-1", expectedRevisionId: "revision-4", expectedRevisionNumber: 4 });
    expect(context.revision).toEqual({ id: "revision-4", number: 4 });
    expect(context.selection.layerIds).toEqual(["headline"]);
    context.workspace.name = "mutated copy";
    expect(current.revision.workspace.name).toBe("Launch");
    await expect(provider.getContext({ workspaceId: "workspace-1", branchId: "branch-1", expectedRevisionNumber: 3 })).rejects.toThrow(/exakte Revision/);
    provider.pinRevision(current);
    current.revision = { ...current.revision, id: "revision-5", revisionNumber: 5 };
    await expect(provider.getContext({ workspaceId: "workspace-1", branchId: "branch-1" })).rejects.toThrow(/exakte Revision/);
  });

  it("blocks a proposal after autosave advanced the authoritative revision", () => {
    const current = opened();
    expect(() => assertAgentBatchMatchesHead(current, { operationId: "agent-1", expectedRevisionId: "revision-3", expectedRevisionNumber: 3, operations: [{ type: "set-board-paint", boardId: "board-1", color: "#EE3399" }] })).toThrow(/seit diesem Vorschlag geändert/);
    expect(() => assertAgentBatchMatchesHead(current, { operationId: "agent-1", expectedRevisionId: "revision-4", expectedRevisionNumber: 4, operations: [] })).toThrow(/keine anwendbaren/);
  });
});
