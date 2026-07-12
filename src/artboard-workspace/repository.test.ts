import { describe, expect, it, vi } from "vitest";
import { ARTBOARD_DOCUMENT_VERSION, ARTBOARD_WORKSPACE_VERSION, validateArtboardWorkspace, type ArtboardWorkspace } from "../nodes/brand/artboard-domain";
import { addBlankBoard, applyWorkspaceOperations, catalogArtboardRecord } from "./repository";

vi.stubGlobal("crypto", { randomUUID: vi.fn(() => `id-${Math.random().toString(36).slice(2)}`) });

const workspace = (): ArtboardWorkspace => ({
  schemaVersion: ARTBOARD_WORKSPACE_VERSION, id: "workspace-1", name: "Launch", activeBoardId: "board-1", selectedBoardIds: ["board-1"], placements: { "board-1": { x: 64, y: 64 } }, pasteboard: { margin: 64, gap: 64, grid: 8 },
  boards: { "board-1": { id: "board-1", name: "Post", activeRevisionId: "board-revision-1", createdAt: "2026-07-12T12:00:00.000Z", ancestry: { branchId: "branch-main" }, inputSnapshot: { id: "snapshot-1", createdAt: "2026-07-12T12:00:00.000Z", bindings: {} }, document: { schemaVersion: ARTBOARD_DOCUMENT_VERSION, id: "document-1", name: "Post", format: { preset: "instagram-post", width: 1080, height: 1080 }, paint: { kind: "solid", color: "#FFFFFF" }, rootLayerIds: ["headline"], layers: { headline: { id: "headline", type: "text", name: "Headline", locked: false, visible: true, version: 1, geometry: { x: 80, y: 80, width: 800, height: 180, rotation: 0 }, text: "FlowZ", color: "#111111", fontSize: 90, align: "left" } }, bindings: {}, tokenRefs: {} } } },
});

describe("artboard document repository boundary", () => {
  it("maps healthy catalog records into first-class home documents", () => {
    const document = catalogArtboardRecord({ id: "workspace-1", kind: "artboard", name: "Launch", createdAt: "2026-07-12T12:00:00.000Z", updatedAt: "2026-07-12T13:00:00.000Z", revision: 3, fingerprint: "abc", health: "healthy" });
    expect(document).toMatchObject({ id: "workspace-1", kind: "artboard", name: "Launch", revision: 3, contentFingerprint: "abc", health: { state: "healthy" } });
  });

  it("applies one controlled operation batch without mutating the persisted source", () => {
    const source = workspace();
    const next = applyWorkspaceOperations(source, [{ type: "update-layer", boardId: "board-1", layerId: "headline", patch: { text: "Neue Headline", version: 2 } }]);
    expect(next.boards["board-1"].document.layers.headline).toMatchObject({ text: "Neue Headline", version: 2 });
    expect(source.boards["board-1"].document.layers.headline).toMatchObject({ text: "FlowZ", version: 1 });
    expect(() => validateArtboardWorkspace(next)).not.toThrow();
  });

  it("creates a non-overlapping standalone board with the requested format", () => {
    const next = addBlankBoard(workspace(), "youtube-thumbnail", "board-1");
    expect(Object.keys(next.boards)).toHaveLength(2);
    expect(next.boards[next.activeBoardId].document.format).toMatchObject({ preset: "youtube-thumbnail", width: 1280, height: 720 });
    expect(() => validateArtboardWorkspace(next)).not.toThrow();
  });

  it("persists versioned palette and font token snapshots with the board inputs", () => {
    const snapshot = { id:"snapshot-2",createdAt:"2026-07-12T14:00:00.000Z",bindings:{
      "palette-0":{ id:"palette-0",source:{projectId:"flow",nodeId:"palette",portId:"palette",resultId:"palette-result"},snapshot:{kind:"artifact" as const,artifactType:"flowz.color-palette",artifactHash:"a".repeat(64)},mode:"live" as const },
      "fonts-0":{ id:"fonts-0",source:{projectId:"flow",nodeId:"fonts",portId:"pairing",resultId:"fonts-result"},snapshot:{kind:"artifact" as const,artifactType:"flowz.font-pairing",artifactHash:"b".repeat(64)},mode:"live" as const },
    }};
    const next = applyWorkspaceOperations(workspace(), [{ type:"set-board-inputs",boardId:"board-1",snapshot }]);
    expect(next.boards["board-1"].inputSnapshot.id).toBe("snapshot-2");
    expect(next.boards["board-1"].document.tokenRefs).toEqual({ palette:{artifactId:"palette-result",snapshotHash:"a".repeat(64)},fonts:{artifactId:"fonts-result",snapshotHash:"b".repeat(64)} });
    expect(() => validateArtboardWorkspace(next)).not.toThrow();
  });
});
