import { describe, expect, it } from "vitest";
import { ARTBOARD_INITIAL_CONTEXT_MAX_CHARS, buildArtboardInitialContext } from "./initial-context";

const run = { workspaceId: "workspace-1", branchId: "branch-main", inputRevision: 7 };

describe("initial Artboard chat context", () => {
  it("serializes a bounded, explicitly untrusted structured snapshot without binary data", () => {
    const hugeText = `Headline ${"x".repeat(4_000)} data:image/png;base64,${"A".repeat(40_000)}`;
    const result = buildArtboardInitialContext({
      workspace: { name: "Launch", boards: [{ id: "board-1", name: "Post", format: { width: 1080, height: 1080 }, placement: { x: 64, y: 80 }, layerCount: 1 }] },
      selection: { activeBoardId: "board-1", boardIds: ["board-1"], layerIds: ["headline"] },
      activeBoard: { id: "board-1", name: "Post", format: { width: 1080, height: 1080 }, bindingIds: ["hero"] },
      layerTree: { boardId: "board-1", roots: [{ id: "headline", type: "text", name: "Headline" }] },
      layers: [{ boardId: "board-1", id: "headline", type: "text", name: "Headline", text: hugeText, color: "#111111", fontFamily: "Inter", fontWeight: 700, fontSize: 96, geometry: { x: 80, y: 80, width: 920, height: 160, rotation: 0 } }],
      bindings: [{ boardId: "board-1", id: "hero", mode: "pinned", source: { projectId: "flow", nodeId: "image", portId: "out", resultId: "result" }, snapshot: { kind: "cas", hash: "a".repeat(64) } }],
    }, run);
    expect(result).toContain("UNTRUSTED_DOCUMENT_CONTEXT");
    expect(result).toContain('"expectedRevision":7');
    expect(result).toContain('"fontFamily":"Inter"');
    expect(result).toContain('"nodeId":"image"');
    expect(result.length).toBeLessThanOrEqual(ARTBOARD_INITIAL_CONTEXT_MAX_CHARS + 64);
    expect(result).not.toContain("A".repeat(1_000));
  });

  it("hard-caps collections", () => {
    const boards = Array.from({ length: 100 }, (_, index) => ({ id: `board-${index}`, name: `Board ${index}`, format: { width: 1080, height: 1080 }, placement: { x: index, y: index } }));
    const result = buildArtboardInitialContext({ workspace: { name: "Many", boards }, selection: { activeBoardId: "board-0", boardIds: boards.map((board) => board.id), layerIds: [] } }, run);
    expect(result).toContain('"boardsTruncated":true');
    expect(result).not.toContain('"id":"board-99"');
    expect(result.length).toBeLessThan(ARTBOARD_INITIAL_CONTEXT_MAX_CHARS);
  });
});
