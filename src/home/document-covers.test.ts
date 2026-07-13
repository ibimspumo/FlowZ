import { afterEach, describe, expect, it, vi } from "vitest";
import { consumeArtboardCoverRenderQueue, createArtboardCoverLayout, createArtboardCoverRenderQueue, DocumentCoverCoordinator, renderFlowCoverSvg } from "./document-covers";
import { createFlowCoverModel } from "./flow-cover";
import type { DocumentCatalogRecord } from "./catalog-api";

afterEach(() => vi.useRealTimers());

const fingerprint = "a".repeat(64);
const record = (): DocumentCatalogRecord => ({ id: "flow-1", kind: "flow", name: "Flow", revision: 3, fingerprint, health: "healthy", createdAt: "2026-07-12T10:00:00Z", updatedAt: "2026-07-12T10:01:00Z" });

describe("document cover jobs", () => {
  it("fits every artboard and mixed format into one stable Home cover", () => {
    const document = (width: number, height: number) => ({ format: { width, height } });
    const layout = createArtboardCoverLayout({
      boards: {
        square: { id: "square", document: document(1080, 1080) },
        story: { id: "story", document: document(1080, 1920) },
        wide: { id: "wide", document: document(1920, 1080) },
      },
      placements: { square: { x: 0, y: 0 }, story: { x: 1200, y: 0 }, wide: { x: 2400, y: 980 } },
      activeBoardId: "story",
    } as never);
    expect(layout.boards.map((item) => item.id)).toEqual(["square", "story", "wide"]);
    expect(layout.bounds).toEqual({ x: 0, y: 0, width: 4320, height: 2060 });
    for (const board of layout.boards) {
      const left = layout.offsetX + board.x * layout.scale;
      const top = layout.offsetY + board.y * layout.scale;
      expect(left).toBeGreaterThanOrEqual(18 - 0.001);
      expect(top).toBeGreaterThanOrEqual(18 - 0.001);
      expect(left + board.width * layout.scale).toBeLessThanOrEqual(480 - 18 + 0.001);
      expect(top + board.height * layout.scale).toBeLessThanOrEqual(300 - 18 + 0.001);
    }
  });

  it("renders the fitted Artboard queue sequentially at cover-sized decode dimensions", async () => {
    const document = (width: number, height: number) => ({ format: { width, height } });
    const layout = createArtboardCoverLayout({
      boards: {
        square: { id: "square", document: document(1080, 1080) },
        story: { id: "story", document: document(1080, 1920) },
        wide: { id: "wide", document: document(3840, 2160) },
      },
      placements: { square: { x: 0, y: 0 }, story: { x: 1200, y: 0 }, wide: { x: 2400, y: 980 } },
    } as never);
    const queue = createArtboardCoverRenderQueue(layout);
    expect(queue.every((item) => item.targetWidth <= 480 && item.targetHeight <= 300)).toBe(true);
    let active = 0; let maxActive = 0; const order: string[] = [];
    await consumeArtboardCoverRenderQueue(queue, async (item) => {
      active += 1; maxActive = Math.max(maxActive, active); order.push(`start:${item.id}`);
      await Promise.resolve();
      order.push(`end:${item.id}`); active -= 1;
    });
    expect(maxActive).toBe(1);
    expect(order).toEqual(["start:square", "end:square", "start:story", "end:story", "start:wide", "end:wide"]);
  });

  it("renders a bounded architectural SVG without external resources", () => {
    const svg = renderFlowCoverSvg(createFlowCoverModel({
      nodes: [{ id: "one", x: 0, y: 0, width: 310, height: 220, color: "#38BDF8" }, { id: "two", x: 500, y: 120, width: 310, height: 220, color: "#EC4899" }],
      edges: [{ sourceId: "one", targetId: "two", color: "#64748B" }], groups: [],
    }));
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300"');
    expect(svg).toContain("<path"); expect(svg.replace("http://www.w3.org/2000/svg", "")).not.toMatch(/(?:https?:|data:|file:|<script)/i);
    expect(new TextEncoder().encode(svg).byteLength).toBeLessThan(256 * 1024);
  });

  it("debounces duplicate saves and publishes only an exact committed cover", async () => {
    vi.useFakeTimers();
    const committed = { blobHash: "b".repeat(64), contentFingerprint: fingerprint, width: 480, height: 300, mediaType: "image/svg+xml" as const, generatedAt: "2026-07-12T10:02:00Z" };
    const commit = vi.fn().mockResolvedValue(committed); const onCover = vi.fn();
    const coordinator = new DocumentCoverCoordinator({
      debounceMs: 10, list: async () => [record()], openArtboard: async () => undefined, onCover,
      loadFlowSource: async () => ({ nodes: [], edges: [], groups: [] }), commit,
    });
    coordinator.schedule("flow-1"); coordinator.schedule("flow-1"); coordinator.schedule("flow-1");
    await vi.advanceTimersByTimeAsync(20);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ documentId: "flow-1", expectedRevision: 3, contentFingerprint: fingerprint, mediaType: "image/svg+xml" }));
    expect(onCover).toHaveBeenCalledWith("flow-1", committed, expect.objectContaining({ id: "flow-1", revision: 3, cover: committed }));
    coordinator.dispose();
  });

  it("fails closed when a document disappears before work starts", async () => {
    vi.useFakeTimers(); const commit = vi.fn();
    const coordinator = new DocumentCoverCoordinator({ debounceMs: 1, list: async () => [], openArtboard: async () => undefined, onCover: vi.fn(), commit });
    coordinator.schedule("deleted"); await vi.advanceTimersByTimeAsync(5);
    expect(commit).not.toHaveBeenCalled(); coordinator.dispose();
  });

  it("does not publish a just-committed cover after the catalog head moved", async () => {
    vi.useFakeTimers();
    const committed = { blobHash: "b".repeat(64), contentFingerprint: fingerprint, width: 480, height: 300, mediaType: "image/svg+xml" as const, generatedAt: "2026-07-12T10:02:00Z" };
    const list = vi.fn()
      .mockResolvedValueOnce([record()])
      .mockResolvedValueOnce([{ ...record(), revision: 4, fingerprint: "c".repeat(64) }]);
    const onCover = vi.fn();
    const coordinator = new DocumentCoverCoordinator({ debounceMs: 1, list, openArtboard: async () => undefined, onCover, loadFlowSource: async () => ({ nodes: [], edges: [], groups: [] }), commit: vi.fn().mockResolvedValue(committed) });
    coordinator.schedule("flow-1"); await vi.advanceTimersByTimeAsync(5);
    expect(onCover).not.toHaveBeenCalled(); coordinator.dispose();
  });

  it("replaces a current legacy SVG with a versioned PNG cover", async () => {
    vi.useFakeTimers();
    const coverFingerprint = "d".repeat(64);
    const legacy = { blobHash: "a".repeat(64), contentFingerprint: coverFingerprint, width: 480, height: 300, mediaType: "image/svg+xml" as const, generatedAt: "2026-07-12T10:01:00Z" };
    const current = { ...record(), coverFingerprint, cover: legacy };
    const committed = { ...legacy, blobHash: "b".repeat(64), mediaType: "image/png" as const, generatedAt: "2026-07-12T10:02:00Z" };
    const loadFlowSource = vi.fn().mockResolvedValue({ nodes: [], edges: [], groups: [] });
    const commit = vi.fn().mockResolvedValue(committed); const onCover = vi.fn();
    const coordinator = new DocumentCoverCoordinator({
      debounceMs: 1, list: async () => [current], openArtboard: async () => undefined, onCover,
      loadFlowSource, renderFlow: async () => ({ bytes: new Uint8Array([1, 2, 3]), width: 480, height: 300 }), commit,
    });
    coordinator.schedule("flow-1"); await vi.advanceTimersByTimeAsync(5);
    expect(loadFlowSource).toHaveBeenCalledWith("flow-1", 3, coverFingerprint);
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ contentFingerprint: coverFingerprint, mediaType: "image/png" }));
    expect(onCover).toHaveBeenCalledTimes(1);
    coordinator.dispose();
  });

  it("lets a newer refresh invalidate in-flight rendering and rejects mismatched commit provenance", async () => {
    vi.useFakeTimers();
    let releaseFirst!: (value: { nodes: []; edges: []; groups: [] }) => void;
    const first = new Promise<{ nodes: []; edges: []; groups: [] }>((resolve) => { releaseFirst = resolve; });
    const loadFlowSource = vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValue({ nodes: [], edges: [], groups: [] });
    const valid = { blobHash: "b".repeat(64), contentFingerprint: fingerprint, width: 480, height: 300, mediaType: "image/svg+xml" as const, generatedAt: "2026-07-12T10:02:00Z" };
    const commit = vi.fn().mockResolvedValue(valid); const onCover = vi.fn();
    const coordinator = new DocumentCoverCoordinator({ debounceMs: 1, list: async () => [record()], openArtboard: async () => undefined, onCover, loadFlowSource, commit });
    coordinator.schedule("flow-1"); await vi.advanceTimersByTimeAsync(2);
    coordinator.schedule("flow-1"); await vi.advanceTimersByTimeAsync(2);
    await Promise.resolve();
    releaseFirst({ nodes: [], edges: [], groups: [] }); await Promise.resolve();
    expect(commit).toHaveBeenCalledTimes(1); expect(onCover).toHaveBeenCalledTimes(1);

    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    commit.mockResolvedValueOnce({ ...valid, contentFingerprint: "c".repeat(64) });
    coordinator.schedule("flow-1"); await vi.advanceTimersByTimeAsync(2);
    expect(onCover).toHaveBeenCalledTimes(1);
    warning.mockRestore();
    coordinator.dispose();
  });
});
