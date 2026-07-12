import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentCoverCoordinator, renderFlowCoverSvg } from "./document-covers";
import { createFlowCoverModel } from "./flow-cover";
import type { DocumentCatalogRecord } from "./catalog-api";

afterEach(() => vi.useRealTimers());

const fingerprint = "a".repeat(64);
const record = (): DocumentCatalogRecord => ({ id: "flow-1", kind: "flow", name: "Flow", revision: 3, fingerprint, health: "healthy", createdAt: "2026-07-12T10:00:00Z", updatedAt: "2026-07-12T10:01:00Z" });

describe("document cover jobs", () => {
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
    expect(onCover).toHaveBeenCalledWith("flow-1", committed);
    coordinator.dispose();
  });

  it("fails closed when a document disappears before work starts", async () => {
    vi.useFakeTimers(); const commit = vi.fn();
    const coordinator = new DocumentCoverCoordinator({ debounceMs: 1, list: async () => [], openArtboard: async () => undefined, onCover: vi.fn(), commit });
    coordinator.schedule("deleted"); await vi.advanceTimersByTimeAsync(5);
    expect(commit).not.toHaveBeenCalled(); coordinator.dispose();
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
