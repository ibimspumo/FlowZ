import { beforeEach, describe, expect, it } from "vitest";
import { useFlowStore } from "../store";
import type { HistoryItem } from "../types";
import { commitFalMedia, type FalRuntimeNode } from "./fal-view";

describe("fal paid-result curation", () => {
  beforeEach(async () => {
    await useFlowStore.getState().initialize();
    useFlowStore.getState().reset();
  });

  it("keeps a stale paid result visible in history without replacing the active output", () => {
    const existing: HistoryItem = {
      id: "active-result",
      runId: "active-run",
      createdAt: "2026-07-13T10:00:00.000Z",
      value: "flowz-media://active",
      assetId: "active-asset",
      blobHash: "a".repeat(64),
      mediaType: "image/png",
      persisted: true,
      active: true,
    };
    const store = useFlowStore.getState();
    const current = store.nodes.find((item) => item.data.kind === "imageGeneration");
    expect(current).toBeDefined();
    store.updateNode(
      current!.id,
      {
        status: "fresh",
        value: existing.value,
        assetId: existing.assetId,
        blobHash: existing.blobHash,
        mediaType: existing.mediaType,
        outputValues: { image: `flowz-cas:${existing.blobHash}` },
        history: [existing],
      },
      true,
    );
    const node = useFlowStore.getState().nodes.find((item) => item.id === current!.id)!;

    commitFalMedia(node as unknown as FalRuntimeNode, {
      runId: "stale-run",
      targetCurrent: false,
      kind: "image",
      items: [
        {
          resultId: "stale-result",
          assetId: "stale-asset",
          blobHash: "b".repeat(64),
          mediaType: "image/png",
        },
      ],
    });

    const updated = useFlowStore.getState().nodes.find((item) => item.id === current!.id)!;
    expect(updated.data.status).toBe("stale");
    expect(updated.data.value).toBe(existing.value);
    expect(updated.data.blobHash).toBe(existing.blobHash);
    expect(updated.data.outputValues?.image).toBe(`flowz-cas:${existing.blobHash}`);
    expect(updated.data.history).toEqual([
      expect.objectContaining({ id: "stale-result", active: false, persisted: true }),
      expect.objectContaining({ id: "active-result", active: true, persisted: true }),
    ]);
    expect(updated.data.error).toContain("gespeichert");
  });
});
