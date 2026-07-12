import { beforeEach, describe, expect, it } from "vitest";
import { currentExecutionFingerprint, useFlowStore } from "./store";
import type { DirectMediaBinding } from "./nodes/direct-media";

const first: DirectMediaBinding = {
  schemaVersion: 1, kind: "image", blobHash: "a".repeat(64), mediaType: "image/png", priority: "fallback",
  source: { kind: "asset-version", assetId: "asset", versionId: "version-1", version: 1 },
};
const second: DirectMediaBinding = {
  schemaVersion: 1, kind: "image", blobHash: "b".repeat(64), mediaType: "image/webp", priority: "override",
  source: { kind: "asset-version", assetId: "asset-2", versionId: "version-2", version: 2 },
};

describe("direct media store binding", () => {
  beforeEach(async () => { await useFlowStore.getState().initialize(); useFlowStore.getState().reset(); });

  it("persists replacement in config, changes fingerprint, marks stale and supports undo/redo", () => {
    const id = useFlowStore.getState().addNode("imageAnalysis", { x: 10, y: 10 });
    useFlowStore.getState().updateNode(id, { status: "fresh", value: "old", persisted: true });
    const before = currentExecutionFingerprint(id);
    expect(useFlowStore.getState().bindDirectMediaToNode(id, first)).toBe(true);
    expect(useFlowStore.getState().document?.graph.nodes.find((node) => node.id === id)?.config.directMedia).toEqual(first);
    expect(useFlowStore.getState().nodes.find((node) => node.id === id)?.data.status).toBe("stale");
    expect(currentExecutionFingerprint(id)).not.toBe(before);

    expect(useFlowStore.getState().bindDirectMediaToNode(id, second)).toBe(true);
    expect(useFlowStore.getState().document?.graph.nodes.find((node) => node.id === id)?.config.directMedia).toEqual(second);
    useFlowStore.getState().undo();
    expect(useFlowStore.getState().document?.graph.nodes.find((node) => node.id === id)?.config.directMedia).toEqual(first);
    useFlowStore.getState().redo();
    expect(useFlowStore.getState().document?.graph.nodes.find((node) => node.id === id)?.config.directMedia).toEqual(second);
  });

  it("clears without tombstones and rejects unsupported targets or unsafe contracts", () => {
    const supported = useFlowStore.getState().addNode("imageTransform");
    const unsupported = useFlowStore.getState().addNode("textInput");
    expect(useFlowStore.getState().bindDirectMediaToNode(unsupported, first)).toBe(false);
    expect(useFlowStore.getState().bindDirectMediaToNode(supported, { ...first, blobHash: "/tmp/a" } as DirectMediaBinding)).toBe(false);
    expect(useFlowStore.getState().bindDirectMediaToNode(supported, first)).toBe(true);
    expect(useFlowStore.getState().clearDirectMediaFromNode(supported)).toBe(true);
    expect("directMedia" in (useFlowStore.getState().document?.graph.nodes.find((node) => node.id === supported)?.config ?? {})).toBe(false);
    useFlowStore.getState().undo();
    expect(useFlowStore.getState().document?.graph.nodes.find((node) => node.id === supported)?.config.directMedia).toEqual(first);
  });

  it("accepts project results only for the active project revision", () => {
    const id = useFlowStore.getState().addNode("backgroundRemoval");
    const state = useFlowStore.getState();
    const local = { ...first, source: { kind: "project-result" as const, projectId: state.document!.id, projectRevision: state.revision!, resultId: "result" } };
    expect(state.bindDirectMediaToNode(id, { ...local, source: { ...local.source, projectId: "foreign" } })).toBe(false);
    expect(state.bindDirectMediaToNode(id, { ...local, source: { ...local.source, projectRevision: state.revision! + 1 } })).toBe(false);
    expect(state.bindDirectMediaToNode(id, local)).toBe(true);
  });
});
