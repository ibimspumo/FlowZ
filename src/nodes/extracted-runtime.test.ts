import { describe, expect, it, vi } from "vitest";
import { canonicalNodeRegistry } from ".";
import { dispatchAppNodeExecution } from "./dispatch";
import { executeListProcessing } from "../engine/list-execution";

const node = (kind: Parameters<typeof canonicalNodeRegistry.forKind>[0], config?: Record<string, any>) => {
  const module = canonicalNodeRegistry.forKind(kind);
  return { module, graph: { id: `${kind}-1`, moduleId: module.id, moduleVersion: module.version, position: { x: 0, y: 0 }, config: config ?? module.defaultConfig, updatePolicy: "manual" as const } };
};
const signal = new AbortController().signal;

describe("extracted native node runtime", () => {
  it("executes passive sources without UI back-delegation", async () => {
    const text = node("textInput", { text: "Hallo" });
    expect((await dispatchAppNodeExecution(text.module, text.graph, { signal, inputs: {} })).outputs.text).toMatchObject({ value: { value: "Hallo" } });
    const asset = node("assetText", { libraryAssetId: "a", assetVersionId: "v", assetVersion: 1, assetName: "Prompt", assetKind: "text" });
    expect((await dispatchAppNodeExecution(asset.module, asset.graph, { signal, inputs: {}, services: { assets: { get: async () => ({ text: "Asset" }) } } })).outputs.text).toMatchObject({ value: { value: "Asset" } });
  });

  it("uses native webpage and research executors with bounded services", async () => {
    const webpage = node("webpage"); const fetch = vi.fn(async () => ({ finalUrl: "https://example.com/", title: "Example", text: "Body", truncated: false }));
    const page = await dispatchAppNodeExecution(webpage.module, { ...webpage.graph, config: { url: "https://example.com", includeScreenshot: false } }, { signal, inputs: {}, services: { webpage: { fetch } } });
    expect(fetch).toHaveBeenCalledOnce(); expect(page.outputs.text).toMatchObject({ value: { type: "text" } });
    const research = node("research"); const search = vi.fn(async ({ query }) => ({ provider: "Test", markdown: query, resultCount: 1 }));
    const found = await dispatchAppNodeExecution(research.module, research.graph, { signal, inputs: { query: [{ kind: "scalar", value: { type: "text", value: "Connected" } }] }, services: { research: { search } } });
    expect(found.outputs.text).toMatchObject({ value: { value: "Connected" } });
  });

  it("forwards abort signals to video-frame and image-operation controllers", async () => {
    const frame = node("videoFrame"); const extract = vi.fn(async ({ signal: passed }) => { expect(passed).toBe(signal); return { assetId: "frame", mediaType: "image/png" }; });
    await dispatchAppNodeExecution(frame.module, frame.graph, { signal, inputs: { video: [{ kind: "scalar", value: { type: "video", assetId: "video" } }] }, services: { videoFrame: { extract } } });
    const transform = node("imageTransform"); const transformCall = vi.fn(async ({ signal: passed }) => { expect(passed).toBe(signal); return { assetId: "out", mediaType: "image/png", width: 100, height: 100 }; });
    const output = await dispatchAppNodeExecution(transform.module, transform.graph, { signal, inputs: { image: [{ kind: "scalar", value: { type: "image", assetId: "in" } }] }, services: { imageOperations: { transform: transformCall, trimTransparent: vi.fn() }, listMap: { execute: executeListProcessing } } });
    expect(transformCall).toHaveBeenCalledOnce(); expect(output.outputs.images).toMatchObject({ kind: "list", items: [{ assetId: "out" }] });
  });

  it("maps transparent trimming over an image list through the shared list service", async () => {
    const trim = node("imageTrimTransparent"); const calls: string[] = [];
    const output = await dispatchAppNodeExecution(trim.module, trim.graph, { signal, inputs: { imageLists: [{ kind: "list", itemType: "image", items: [{ type: "image", assetId: "a" }, { type: "image", assetId: "b" }] }] }, services: { imageOperations: { transform: vi.fn(), trimTransparent: async ({ sourceAssetId }) => { calls.push(sourceAssetId); return { assetId: `${sourceAssetId}-trim`, mediaType: "image/png", width: 1, height: 1, outcome: "trimmed" }; } }, listMap: { execute: executeListProcessing } } });
    expect(calls.sort()).toEqual(["a", "b"]); expect(output.outputs.images).toMatchObject({ kind: "list", items: [{ assetId: "a-trim" }, { assetId: "b-trim" }] });
  });

  it("fails closed for missing services and incompatible input values", async () => {
    await expect(dispatchAppNodeExecution(node("research").module, node("research").graph, { signal, inputs: {} })).rejects.toThrow(/Recherche-Dienst/);
    const frame = node("videoFrame");
    await expect(dispatchAppNodeExecution(frame.module, frame.graph, { signal, inputs: { video: [{ kind: "scalar", value: { type: "text", value: "wrong" } }] }, services: { videoFrame: { extract: vi.fn() } } })).rejects.toThrow(/Video/);
    const transform = node("imageTransform");
    await expect(dispatchAppNodeExecution(transform.module, transform.graph, { signal, inputs: { image: [{ kind: "scalar", value: { type: "text", value: "wrong" } }] }, services: { imageOperations: { transform: vi.fn(), trimTransparent: vi.fn() }, listMap: { execute: executeListProcessing } } })).rejects.toThrow(/Bildquelle/);
  });

  it("discards asynchronous provider and image results after cancellation", async () => {
    let resolveSearch!: (value: { provider: string; markdown: string; resultCount: number }) => void;
    const searchResult = new Promise<{ provider: string; markdown: string; resultCount: number }>((resolve) => { resolveSearch = resolve; });
    const research = node("research", { query: "Test", resultCount: 5, freshness: "all" });
    const researchController = new AbortController();
    const runningResearch = dispatchAppNodeExecution(research.module, research.graph, { signal: researchController.signal, inputs: {}, services: { research: { search: () => searchResult } } });
    researchController.abort(); resolveSearch({ provider: "Test", markdown: "late", resultCount: 1 });
    await expect(runningResearch).rejects.toMatchObject({ name: "AbortError" });

    let resolveTransform!: (value: { assetId: string; mediaType: string; width: number; height: number }) => void;
    const transformed = new Promise<{ assetId: string; mediaType: string; width: number; height: number }>((resolve) => { resolveTransform = resolve; });
    const transform = node("imageTransform"); const transformController = new AbortController();
    const runningTransform = dispatchAppNodeExecution(transform.module, transform.graph, { signal: transformController.signal, inputs: { image: [{ kind: "scalar", value: { type: "image", assetId: "in" } }] }, services: { imageOperations: { transform: () => transformed, trimTransparent: vi.fn() }, listMap: { execute: executeListProcessing } } });
    transformController.abort(); resolveTransform({ assetId: "late", mediaType: "image/png", width: 1, height: 1 });
    await expect(runningTransform).rejects.toMatchObject({ name: "AbortError" });
  });
});
