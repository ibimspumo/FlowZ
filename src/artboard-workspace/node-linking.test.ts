import { describe, expect, it, vi } from "vitest";
import { artboardNodeRequestFromFlow, createArtboardInputSnapshot, persistedArtboardBindingFromRevision } from "./node-linking";
import type { FlowEdge, FlowNode } from "../types";
import type { OpenArtboardDocument } from "./repository";

describe("Artboard Flow linking", () => {
  it("captures typed upstream values with stable source provenance", async () => {
    const palette = JSON.stringify({ artifact: "flowz.color-palette", version: 1, data: { colors: [] } });
    const nodes = [{ id: "palette-node", type: "flowNode", position: { x: 0, y: 0 }, data: { kind: "colorPalette", label: "Palette", status: "fresh", updatePolicy: "manual", value: palette, outputValues: { palette } } }] as FlowNode[];
    const edges = [{ id: "edge-1", source: "palette-node", target: "artboard-node", sourceHandle: "palette", targetHandle: "palette", data: { dataType: "json", order: 0 } }] as FlowEdge[];
    const snapshot = await createArtboardInputSnapshot({ flowId: "flow-1", nodeId: "artboard-node", upstream: { fingerprint: "current", palette: [palette], fonts: [], images: [] } }, nodes, edges);
    expect(snapshot.bindings["palette-0"]).toMatchObject({ source: { projectId: "flow-1", nodeId: "palette-node", portId: "palette" }, snapshot: { kind: "artifact", artifactType: "flowz.color-palette" }, mode: "live" });
    const expected = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(palette));
    const expectedHash = [...new Uint8Array(expected)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    expect(snapshot.bindings["palette-0"].snapshot.kind === "artifact" && snapshot.bindings["palette-0"].snapshot.artifactHash).toBe(expectedHash);
  });

  it("keeps the persisted result provenance for values exposed through a list output", async () => {
    const hash = "a".repeat(64);
    const output = `flowz-cas:${hash}`;
    const nodes = [{
      id: "image-node", type: "flowNode", position: { x: 0, y: 0 },
      data: { kind: "imageGeneration", label: "Bilder", status: "fresh", updatePolicy: "manual", outputValues: { images: [output] }, history: [{ id: "result-real", createdAt: "2026-07-12T10:00:00.000Z", value: "flowz-media://localhost/preview", blobHash: hash, active: true }] },
    }] as FlowNode[];
    const edges = [{ id: "edge-image", source: "image-node", target: "artboard-node", sourceHandle: "images", targetHandle: "images", data: { dataType: "image", order: 0 } }] as FlowEdge[];
    const snapshot = await createArtboardInputSnapshot({ flowId: "flow-1", nodeId: "artboard-node", upstream: { fingerprint: "current", palette: [], fonts: [], images: [output] } }, nodes, edges);
    expect(snapshot.bindings["images-0"]).toMatchObject({ source: { resultId: "result-real" }, snapshot: { kind: "cas", hash } });
    expect(artboardNodeRequestFromFlow("flow-1", "artboard-node", nodes, edges)).toEqual({
      flowId: "flow-1", nodeId: "artboard-node",
      upstream: { fingerprint: JSON.stringify({ palette: [], fonts: [], images: [output] }), palette: [], fonts: [], images: [output] },
    });
  });

  it("publishes only complete revision-bound composite PNG hashes", async () => {
    const workspace = {
      schemaVersion: 1, id: "workspace-1", name: "Launch", activeBoardId: "board-1", selectedBoardIds: ["board-1"],
      placements: { "board-1": { x: 64, y: 64 } }, pasteboard: { margin: 64, gap: 64, grid: 8 },
      boards: { "board-1": { id: "board-1", name: "Post", activeRevisionId: "board-revision-1", createdAt: "2026-07-12T10:00:00.000Z", ancestry: { branchId: "branch-1" }, inputSnapshot: { id: "snapshot-1", createdAt: "2026-07-12T10:00:00.000Z", bindings: {} }, document: { schemaVersion: 1, id: "document-1", name: "Post", format: { preset: "instagram-post", width: 1080, height: 1080 }, paint: { kind: "solid", color: "#FFFFFF" }, rootLayerIds: [], layers: {}, bindings: {}, tokenRefs: {} } } },
    } as const;
    const opened = { record: { id: "workspace-1" }, revision: { id: "revision-2", revisionNumber: 2, workspace }, branch: {} } as unknown as OpenArtboardDocument;
    const blobHash = "d".repeat(64);
    const persist = vi.fn(async (request: Parameters<typeof import("../api").persistArtboardComposites>[0]) => request.composites.map((item) => ({ boardId: item.boardId, active: item.active, selectedIndex: item.selectedIndex, resultId: "result-1", assetId: "asset-1", blobHash, mediaType: "image/png" as const, width: 1080, height: 1080, createdAt: "2026-07-12T10:00:01.000Z" })));
    const binding = await persistedArtboardBindingFromRevision(opened, { flowId: "flow-1", nodeId: "node-1", upstream: { fingerprint: "inputs", palette: [], fonts: [], images: [] } }, { render: async () => "data:image/png;base64,AQID", persist });
    expect(binding).toMatchObject({ revisionId: "revision-2", activeImageHash: blobHash, selectedImageHashes: [blobHash] });
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ projectId: "flow-1", nodeId: "node-1", workspaceId: "workspace-1", revisionId: "revision-2", composites: [{ boardId: "board-1", active: true, selectedIndex: 0, pngBytes: [1, 2, 3] }] }));
  });
});
