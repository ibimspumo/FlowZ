import { describe, expect, it } from "vitest";
import {
  defaultFalImageConfig,
  falImageModel,
} from "./image/capabilities";
import { falVideoCapability } from "./video/capabilities";
import { estimateFalImageCost, estimateFalVideoCost, falEmpiricalSnapshot, falImageCostContext } from "./fal-pricing";

const model = (id: string) => {
  const value = falImageModel(id);
  if (!value) throw new Error(`Missing image model ${id}`);
  return value;
};

describe("versioned fal.ai pre-run cost estimates", () => {
  it("uses exact Nano Banana Pro output and search prices", () => {
    const selected = model("fal-ai/nano-banana-pro");
    const estimate = estimateFalImageCost({
      model: selected,
      endpoint: selected.textEndpoint,
      config: {
        ...defaultFalImageConfig(selected),
        size: "4K",
        variants: 2,
        webSearch: true,
      },
      referenceCount: 0,
      prompt: "Brand image",
    });
    expect(estimate.state).toBe("available");
    if (estimate.state === "available") {
      expect(estimate.amountMicrounits).toBe(615_000);
      expect(estimate.snapshot.endpoint).toBe(selected.textEndpoint);
      expect(estimate.snapshot.adapterSchemaHash).toBe(selected.schemaHash);
    }
  });

  it("distinguishes Flux text-to-image and Redux pricing", () => {
    const selected = model("fal-ai/flux/schnell");
    const config = { ...defaultFalImageConfig(selected), size: "square_hd" };
    const text = estimateFalImageCost({ model: selected, endpoint: selected.textEndpoint, config, referenceCount: 0, prompt: "Logo" });
    const redux = estimateFalImageCost({ model: selected, endpoint: selected.editEndpoint ?? undefined, config, referenceCount: 1, prompt: "" });
    expect(text.state === "available" && text.amountMicrounits).toBe(6_000);
    expect(redux.state === "available" && redux.amountMicrounits).toBe(50_000);
  });

  it("does not invent token usage for Nano Banana Lite", () => {
    const selected = model("google/nano-banana-2-lite");
    const estimate = estimateFalImageCost({ model: selected, endpoint: selected.textEndpoint, config: defaultFalImageConfig(selected), referenceCount: 0, prompt: "Logo" });
    expect(estimate).toMatchObject({ state: "unavailable", reason: "provider-usage-unknown" });
  });

  it("labels GPT Image 1.5 output pricing as a minimum", () => {
    const selected = model("fal-ai/gpt-image-1.5");
    const estimate = estimateFalImageCost({
      model: selected,
      endpoint: selected.textEndpoint,
      config: { ...defaultFalImageConfig(selected), size: "1024x1024", quality: "high" },
      referenceCount: 0,
      prompt: "Logo",
    });
    expect(estimate.state).toBe("available");
    if (estimate.state === "available") {
      expect(estimate.amountMicrounits).toBe(133_000);
      expect(estimate.snapshot.confidence).toBe("minimum");
    }
  });

  it("fails closed for GPT Image 2 presets and mask inputs not covered by the official table", () => {
    const selected = model("openai/gpt-image-2");
    const base = { ...defaultFalImageConfig(selected), quality: "high" };
    const unsupportedPreset = estimateFalImageCost({ model: selected, endpoint: selected.textEndpoint, config: { ...base, size: "landscape_16_9" }, referenceCount: 0, prompt: "Brand image" });
    expect(unsupportedPreset).toMatchObject({ state: "unavailable", reason: "provider-usage-unknown" });
    const maskedEdit = estimateFalImageCost({ model: selected, endpoint: selected.editEndpoint ?? undefined, config: { ...base, size: "square_hd" }, referenceCount: 1, maskCount: 1, prompt: "Edit logo" });
    expect(maskedEdit).toMatchObject({ state: "unavailable", reason: "provider-usage-unknown" });
  });

  it("includes Seedream edit surcharges for each input after the first and each output", () => {
    const selected = model("bytedance/seedream/v5/pro/text-to-image");
    const estimate = estimateFalImageCost({ model: selected, endpoint: selected.editEndpoint ?? undefined, config: { ...defaultFalImageConfig(selected), size: "square", variants: 2 }, referenceCount: 3, prompt: "Variation" });
    expect(estimate.state === "available" && estimate.amountMicrounits).toBe(153_000);
  });

  it("prices only fixed 720p Seedance duration and keeps audio free", () => {
    const capability = falVideoCapability("bytedance/seedance-2.0/fast/text-to-video")!;
    const fixed = estimateFalVideoCost({ capability, config: { duration: 5, resolution: "720p", aspectRatio: "16:9", generateAudio: true, bitrateMode: "standard" }, occupancy: { startFrame: 0, endFrame: 0, references: 0 } });
    expect(fixed.state === "available" && fixed.amountMicrounits).toBe(1_209_500);
    const automatic = estimateFalVideoCost({ capability, config: { duration: "auto", resolution: "720p", aspectRatio: "16:9", generateAudio: true, bitrateMode: "standard" }, occupancy: { startFrame: 0, endFrame: 0, references: 0 } });
    expect(automatic).toMatchObject({ state: "unavailable", reason: "automatic-duration" });
    const lowResolution = estimateFalVideoCost({ capability, config: { duration: 5, resolution: "480p", aspectRatio: "16:9", generateAudio: false, bitrateMode: "standard" }, occupancy: { startFrame: 0, endFrame: 0, references: 0 } });
    expect(lowResolution).toMatchObject({ state: "unavailable", reason: "unpriced-resolution" });
  });

  it("creates a local-actual snapshot only from a sufficient aggregate", () => {
    const selected = model("google/nano-banana-2-lite");
    const context = falImageCostContext({ model: selected, endpoint: selected.textEndpoint, config: defaultFalImageConfig(selected), referenceCount: 0 });
    expect(falEmpiricalSnapshot(selected.textEndpoint, selected.schemaHash, context, { state: "insufficient", provenance: "local-actual", sampleCount: 2, usedSampleCount: 2, rejectedOutliers: 0, lastObservedAt: "2026-07-12T10:00:00Z", medianMicrounits: null, p25Microunits: null, p75Microunits: null })).toBeUndefined();
    const snapshot = falEmpiricalSnapshot(selected.textEndpoint, selected.schemaHash, context, { state: "available", provenance: "local-actual", sampleCount: 4, usedSampleCount: 3, rejectedOutliers: 1, lastObservedAt: "2026-07-12T10:00:00Z", medianMicrounits: 42_000, p25Microunits: 40_000, p75Microunits: 45_000 });
    expect(snapshot).toMatchObject({ state: "empirical", amountMicrounits: 42_000, snapshot: { provenance: "local-actual", confidence: "empirical", priceAsOf: "2026-07-12T10:00:00Z", empirical: { usedSampleCount: 3, rejectedOutliers: 1 } } });
  });
});
