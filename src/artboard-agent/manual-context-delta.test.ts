import { describe, expect, it } from "vitest";
import { ARTBOARD_MANUAL_DELTA_MAX_CHARS, buildArtboardManualDelta } from "./manual-context-delta";
import type { ArtboardManualContextCheckpoint, ArtboardManualLayerSnapshot } from "./types";

const layer = (patch: Partial<ArtboardManualLayerSnapshot> = {}): ArtboardManualLayerSnapshot => ({
  id: "headline", type: "text", name: "Headline", index: 0,
  properties: {
    name: "Headline", geometry: { x: 80, y: 80, width: 800, height: 160, rotation: 0 },
    color: "#111111", font: { family: "Inter", weight: 700, size: 80 }, text: "Launch",
  },
  ...patch,
});

const checkpoint = (revision: number, patch: Partial<ArtboardManualContextCheckpoint> = {}): ArtboardManualContextCheckpoint => ({
  schemaVersion: 1, revision: { id: `revision-${revision}`, number: revision },
  boards: [{
    id: "board-1", name: "Post", placement: { x: 100, y: 100 }, format: { preset: "instagram-post", width: 1080, height: 1080 },
    background: { kind: "solid", color: "#FFFFFF" }, rootLayerIds: ["headline"], layerCount: 1, bindingCount: 0,
    layers: [layer()], bindings: [],
  }],
  ...patch,
});

describe("bounded Artboard turn delta", () => {
  it("describes semantic layer edits including geometry, color, font, order, parent and binding", () => {
    const before = checkpoint(4);
    const after = checkpoint(7, { boards: [{
      ...before.boards[0],
      rootLayerIds: ["container"],
      bindings: [{ id: "hero", mode: "pinned", snapshot: { kind: "cas", hash: "a".repeat(64) } }],
      layers: [layer({ parentId: "container", index: 2, properties: {
        ...layer().properties,
        geometry: { x: 120, y: 90, width: 760, height: 190, rotation: 2 },
        color: "#EE3399", font: { family: "Fraunces", weight: 650, size: 92 },
        resource: { bindingId: "hero" },
      } })],
    }] });
    const delta = buildArtboardManualDelta(before, after)!;
    expect(delta).toContain("Workspace changes since the previous successful agent turn");
    expect(delta).toContain('"field":"geometry"');
    expect(delta).toContain('"field":"color"');
    expect(delta).toContain('"field":"font"');
    expect(delta).toContain('"field":"parentId"');
    expect(delta).toContain('"field":"order"');
    expect(delta).toContain('"field":"resource"');
    expect(delta).toContain('"field":"bindings"');
    expect(delta.length).toBeLessThanOrEqual(ARTBOARD_MANUAL_DELTA_MAX_CHARS + 80);
  });

  it("reports board additions and deletions deterministically", () => {
    const first = checkpoint(1);
    const added = checkpoint(2, { boards: [...first.boards, {
      id: "board-story", name: "Story", placement: { x: 1400, y: 100 }, format: { preset: "instagram-story", width: 1080, height: 1920 },
      rootLayerIds: [], layerCount: 0, bindingCount: 0, layers: [], bindings: [],
    }] });
    const addDelta = buildArtboardManualDelta(first, added)!;
    expect(addDelta).toContain('"kind":"add","boardId":"board-story"');
    expect(addDelta).toContain('"width":1080,"height":1920');
    const deleteDelta = buildArtboardManualDelta(added, checkpoint(3))!;
    expect(deleteDelta).toContain('"kind":"remove","boardId":"board-story"');
  });

  it("emits no delta for an initial or newly isolated chat checkpoint", () => {
    expect(buildArtboardManualDelta(undefined, checkpoint(1))).toBeUndefined();
  });

  it("collapses undo/redo back to the baseline into no change", () => {
    const baseline = checkpoint(4);
    expect(buildArtboardManualDelta(baseline, structuredClone(baseline))).toBeUndefined();
  });
});
