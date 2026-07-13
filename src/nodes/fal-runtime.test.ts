import { describe, expect, it, vi } from "vitest";
import { canonicalNodeRegistry } from ".";
import { dispatchAppNodeExecution } from "./dispatch";

const graph = (
  kind:
    | "imageGeneration"
    | "imageUpscale"
    | "backgroundRemoval"
    | "videoGeneration"
    | "logoDesign",
) => {
  const module = canonicalNodeRegistry.forKind(kind);
  return {
    module,
    node: {
      id: `${kind}-1`,
      moduleId: module.id,
      moduleVersion: module.version,
      position: { x: 0, y: 0 },
      config: module.defaultConfig,
      updatePolicy: "manual" as const,
    },
  };
};
const signal = new AbortController().signal;

describe("module-owned fal runtime", () => {
  it("rejects unknown config keys at every extracted provider boundary", () => {
    for (const kind of [
      "imageGeneration",
      "imageUpscale",
      "backgroundRemoval",
      "videoGeneration",
      "logoDesign",
    ] as const) {
      const module = canonicalNodeRegistry.forKind(kind);
      expect(
        module.validateConfig({ ...module.defaultConfig, unsafe: true }),
        kind,
      ).toBe(false);
    }
  });

  it("builds an audited image request and returns typed variants", async () => {
    const { module, node } = graph("imageGeneration"),
      image = vi.fn(async (request) => ({
        runId: request.runId,
        targetCurrent: true,
        costProvenance: "actual" as const,
        images: [
          {
            resultId: "r",
            assetId: "a",
            blobHash: "b",
            mediaType: "image/png",
            width: 1024,
            height: 1024,
            hasAlpha: false,
          },
        ],
      }));
    const result = await dispatchAppNodeExecution(module, node, {
      signal,
      inputs: {
        prompt: [{ kind: "scalar", value: { type: "text", value: "Kamera" } }],
      },
      services: { fal: { image, imageTool: vi.fn(), video: vi.fn() } },
    });
    expect(image).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "google/nano-banana-2-lite",
        endpoint: "google/nano-banana-2-lite",
        prompt: expect.stringContaining("Kamera"),
        signal,
      }),
    );
    expect(result.outputs.images).toMatchObject({
      kind: "list",
      items: [{ type: "image", assetId: "a" }],
    });
  });

  it("uses the shared paid tool service for upscale and removal", async () => {
    const imageTool = vi.fn(async (request) => ({
      runId: request.runId,
      resultId: "r",
      assetId: "a",
      blobHash: "b",
      mediaType: "image/png",
      width: 20,
      height: 20,
      hasAlpha: true,
      targetCurrent: true,
      costProvenance: "estimated" as const,
    }));
    for (const kind of ["imageUpscale", "backgroundRemoval"] as const) {
      const { module, node } = graph(kind);
      await dispatchAppNodeExecution(module, node, {
        signal,
        inputs: {
          image: [
            { kind: "scalar", value: { type: "image", assetId: "source" } },
          ],
        },
        services: { fal: { image: vi.fn(), imageTool, video: vi.fn() } },
      });
    }
    expect(imageTool).toHaveBeenCalledTimes(2);
    expect(imageTool.mock.calls.map(([request]) => request.endpoint)).toEqual([
      "fal-ai/seedvr/upscale/image",
      "fal-ai/bria/background/remove",
    ]);
  });

  it("infers image-to-video from connected frames and forwards both endpoints", async () => {
    const { module, node } = graph("videoGeneration"),
      video = vi.fn(async (request) => ({
        runId: request.runId,
        resultId: "r",
        videoHash: "v",
        startFrameHash: "s",
        endFrameHash: "e",
        mediaType: "video/mp4",
        mediaMetadata: {
          kind: "video",
          container: "mp4",
          codecs: ["h264"],
          durationSeconds: 4,
          playable: true,
        },
        targetCurrent: true,
        costProvenance: "actual" as const,
      }));
    const config = {
      ...node.config,
      model: "bytedance/seedance-2.0/fast/image-to-video",
      aspectRatio: "auto",
    };
    const result = await dispatchAppNodeExecution(
      module,
      { ...node, config },
      {
        signal,
        inputs: {
          prompt: [
            {
              kind: "scalar",
              value: { type: "text", value: "Eine ruhige Kamerafahrt" },
            },
          ],
          startFrame: [
            { kind: "scalar", value: { type: "image", assetId: "start" } },
          ],
          endFrame: [
            { kind: "scalar", value: { type: "image", assetId: "end" } },
          ],
        },
        services: { fal: { image: vi.fn(), imageTool: vi.fn(), video } },
      },
    );
    expect(video).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "bytedance/seedance-2.0/fast/image-to-video",
        startFrame: "flowz-cas:start",
        endFrame: "flowz-cas:end",
        signal,
      }),
    );
    expect(result.outputs.startFrame).toMatchObject({
      value: { type: "image", assetId: "s", mimeType: "image/jpeg" },
    });
    expect(result.outputs.endFrame).toMatchObject({
      value: { type: "image", assetId: "e", mimeType: "image/jpeg" },
    });
  });

  it("blocks a connected empty video source before any paid request", async () => {
    const { module, node } = graph("videoGeneration");
    const video = vi.fn();
    await expect(
      dispatchAppNodeExecution(module, node, {
        signal,
        inputs: {
          prompt: [
            { kind: "scalar", value: { type: "text", value: "Kamerafahrt" } },
          ],
        },
        connectedInputPorts: new Set(["startFrame"]),
        services: { fal: { image: vi.fn(), imageTool: vi.fn(), video } },
      }),
    ).rejects.toThrow(/Startbild besitzt noch kein Ergebnis/);
    expect(video).not.toHaveBeenCalled();
  });
});
