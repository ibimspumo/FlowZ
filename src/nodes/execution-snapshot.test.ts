import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => {
  const state: any = {
    revision: 7,
    document: {
      id: "project",
      graph: { nodes: [], edges: [] },
    },
    nodes: [],
    runtimeDisplays: new Map(),
  };
  return { fingerprint: "", state };
});

vi.mock("../store", () => ({
  currentExecutionFingerprint: () => fixture.fingerprint,
  useFlowStore: { getState: () => fixture.state },
}));

import { currentExecutionSnapshot } from "./execution-snapshot";

const edge = (sourceNodeId: string, sourcePortId: string, targetPortId = "input", order = 0) => ({
  id: `${sourceNodeId}-${sourcePortId}-${order}`,
  sourceNodeId,
  sourcePortId,
  targetNodeId: "target",
  targetPortId,
  order,
});

function prepare(sources: any[], edges: any[], values: unknown[]) {
  const target = {
    id: "target",
    moduleId: "ai.image-generation",
    moduleVersion: 1,
    config: { model: "image-model" },
  };
  fixture.state.document.graph = { nodes: [...sources, target], edges };
  fixture.state.nodes = sources.map((source) => ({
    id: source.id,
    data: fixture.state.runtimeDisplays.get(source.id) ?? {},
  }));
  fixture.fingerprint = JSON.stringify({
    moduleId: target.moduleId,
    moduleVersion: target.moduleVersion,
    config: target.config,
    inputs: edges.map((item, index) => ({
      sourceNodeId: item.sourceNodeId,
      sourcePortId: item.sourcePortId,
      targetPortId: item.targetPortId,
      order: item.order,
      value: values[index],
    })),
  });
}

describe("canonical execution snapshot", () => {
  beforeEach(() => {
    fixture.state.revision = 7;
    fixture.state.runtimeDisplays = new Map();
  });

  it("captures request contract and an exact config-owned text identity", async () => {
    const source = { id: "prompt", moduleId: "core.text-input", moduleVersion: 1, config: { text: "Hello" } };
    prepare([source], [edge("prompt", "text", "prompt")], ["Hello"]);
    const snapshot = await currentExecutionSnapshot("target", 7, { endpoint: "image-model" });
    expect(snapshot).toMatchObject({
      moduleId: "ai.image-generation",
      projectRevision: 7,
      requestContract: { endpoint: "image-model" },
      connections: [{ identity: "config", sourceConfig: { text: "Hello" } }],
    });
  });

  it("binds ordered list and variant ports to their exact durable result IDs", async () => {
    const a = "a".repeat(64), b = "b".repeat(64);
    const source = { id: "source", moduleId: "ai.image-generation", moduleVersion: 1, config: { model: "m" } };
    fixture.state.runtimeDisplays.set("source", {
      outputValues: { images: [`flowz-cas:${a}`, `flowz-cas:${b}`], "variant:r2": `flowz-cas:${b}` },
      history: [
        { id: "r1", value: "preview:1", blobHash: a, persisted: true, active: true },
        { id: "r2", value: "preview:2", blobHash: b, persisted: true, active: false },
      ],
    });
    prepare(
      [source],
      [edge("source", "images", "references"), edge("source", "variant:r2", "reference", 1)],
      [[`flowz-cas:${a}`, `flowz-cas:${b}`], `flowz-cas:${b}`],
    );
    const snapshot = await currentExecutionSnapshot("target", 7);
    expect(snapshot.connections).toEqual([
      expect.objectContaining({ identity: "results", resultIds: ["r2"] }),
      expect.objectContaining({ identity: "results", resultIds: ["r1", "r2"], activeResultId: "r1" }),
    ]);
  });

  it("uses the one active durable result for webpage, video and Brand auxiliary ports", async () => {
    const hash = "c".repeat(64), start = "d".repeat(64);
    const webpage = { id: "web", moduleId: "context.webpage", moduleVersion: 1, config: { url: "https://example.com" } };
    const video = { id: "video", moduleId: "ai.video-generation", moduleVersion: 1, config: { model: "video" } };
    const fonts = { id: "fonts", moduleId: "brand.font-pairing", moduleVersion: 1, config: { model: "text" } };
    fixture.state.runtimeDisplays.set("web", { outputValues: { text: "Example", screenshot: `flowz-cas:${hash}` }, history: [{ id: "web-result", value: "Example", blobHash: hash, persisted: true, active: true }] });
    fixture.state.runtimeDisplays.set("video", { outputValues: { startFrame: `flowz-cas:${start}` }, history: [{ id: "video-result", value: "video-preview", blobHash: hash, persisted: true, active: true }] });
    fixture.state.runtimeDisplays.set("fonts", { outputValues: { styleHint: "Editorial serif" }, history: [{ id: "font-result", value: "{\"artifact\":\"flowz.font-pairing\"}", persisted: true, active: true }] });
    prepare(
      [webpage, video, fonts],
      [edge("web", "text", "prompt"), edge("web", "screenshot", "reference", 1), edge("video", "startFrame", "reference", 2), edge("fonts", "styleHint", "prompt", 3)],
      ["Example", `flowz-cas:${hash}`, `flowz-cas:${start}`, "Editorial serif"],
    );
    const snapshot = await currentExecutionSnapshot("target", 7);
    expect(snapshot.connections.map(({ resultIds, activeResultId }) => [resultIds, activeResultId])).toEqual([
      [["web-result"], "web-result"],
      [["font-result"], "font-result"],
      [["web-result"], "web-result"],
      [["video-result"], "video-result"],
    ]);
  });

  it("fails closed for an unknown non-durable runtime source", async () => {
    const source = { id: "unknown", moduleId: "plugin.unknown", moduleVersion: 1, config: { mode: "x" } };
    fixture.state.runtimeDisplays.set("unknown", { value: "temporary", outputValues: { text: "temporary" } });
    prepare([source], [edge("unknown", "text", "prompt")], ["temporary"]);
    await expect(currentExecutionSnapshot("target", 7)).rejects.toThrow(/keine dauerhafte/i);
  });

  it("fails closed when the saved revision changed before capture", async () => {
    const source = { id: "prompt", moduleId: "core.text-input", moduleVersion: 1, config: { text: "Hello" } };
    prepare([source], [edge("prompt", "text", "prompt")], ["Hello"]);
    fixture.state.revision = 8;
    await expect(currentExecutionSnapshot("target", 7)).rejects.toThrow(/revisionssicher/i);
  });
});
