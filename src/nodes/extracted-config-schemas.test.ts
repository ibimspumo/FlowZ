import { describe, expect, it } from "vitest";
import { canonicalNodeRegistry } from ".";
import type { NodeKind } from "../types";

const kinds = ["textInput", "assetText", "assetImage", "imageCollection", "videoCollection", "imageInput", "videoInput", "audioInput", "webpage", "research", "videoFrame", "imageTransform", "imageTrimTransparent"] as const satisfies readonly NodeKind[];
const hash = "a".repeat(64);
const media = (kind: "video" | "audio") => kind === "video" ? {
  blobHash: hash, posterHash: "b".repeat(64), mediaType: "video/mp4", fileName: "clip.mp4",
  mediaMetadata: { kind, container: "mp4", codecs: ["h264"], durationSeconds: 4, width: 1920, height: 1080, fps: 30, playable: true },
} : {
  blobHash: hash, mediaType: "audio/wav", fileName: "voice.wav",
  mediaMetadata: { kind, container: "wav", codecs: ["pcm_s16le"], durationSeconds: 4, sampleRate: 48_000, channels: 2, playable: true },
};

const complete: Partial<Record<(typeof kinds)[number], Record<string, unknown>>> = {
  textInput: { text: "Eigener Text" }, imageInput: { assetId: "asset-1", fileName: "bild.png" },
  videoInput: media("video"), audioInput: media("audio"),
  imageCollection: { collectionResultIds: ["result-1"] }, videoCollection: { collectionResultIds: ["result-1"] },
  webpage: { url: "https://example.com", includeScreenshot: true, exportFolderGrant: "grant", exportFolderLabel: "Exports", exportNameTemplate: "{node}", exportOverwrite: "rename", exportedFiles: ["a.md"] },
  research: { query: "Markt", resultCount: 20, freshness: "year", exportFolderGrant: "grant", exportFolderLabel: "Exports", exportNameTemplate: "{node}", exportOverwrite: "replace", exportedFiles: ["a.md"] },
  videoFrame: { frameMode: "percent", frameValue: 100, exportFolderGrant: "grant", exportFolderLabel: "Exports", exportNameTemplate: "{node}", exportOverwrite: "error", exportedFiles: ["a.png"] },
  imageTransform: { transformMode: "free", transformAspect: "custom", targetWidth: 4096, targetHeight: 4096, dimensionLock: false, noUpscale: false, outputFormat: "jpeg", transformQuality: 80, transformBackground: "#ffffff", cropX: .1, cropY: .1, cropWidth: .8, cropHeight: .8, listProcessingMode: "map", exportFolderGrant: "grant", exportFolderLabel: "Exports", exportNameTemplate: "{node}", exportOverwrite: "rename", exportedFiles: ["a.jpg"] },
  imageTrimTransparent: { trimPadding: 64, trimThreshold: 254, listProcessingMode: "map", exportFolderGrant: "grant", exportFolderLabel: "Exports", exportNameTemplate: "{node}", exportOverwrite: "rename", exportedFiles: ["a.png"] },
};

describe("extracted node config schemas", () => {
  for (const kind of kinds) it(`${kind} accepts defaults and complete documented config through JSON roundtrip`, () => {
    const module = canonicalNodeRegistry.forKind(kind);
    expect(module.validateConfig(module.defaultConfig)).toBe(true);
    expect(module.validateConfig(JSON.parse(JSON.stringify(module.defaultConfig)))).toBe(true);
    const candidate = complete[kind]; if (candidate) expect(module.validateConfig(JSON.parse(JSON.stringify(candidate)))).toBe(true);
  });

  for (const kind of kinds) it(`${kind} rejects unknown keys and wrong primitives`, () => {
    const module = canonicalNodeRegistry.forKind(kind);
    expect(module.validateConfig({ ...module.defaultConfig, __unknown: true })).toBe(false);
    const first = Object.keys(module.defaultConfig)[0];
    if (first) expect(module.validateConfig({ ...module.defaultConfig, [first]: { wrong: true } })).toBe(false);
  });

  for (const kind of kinds) it(`${kind} rejects a wrong primitive for every documented field`, () => {
    const module = canonicalNodeRegistry.forKind(kind);
    const candidate = complete[kind] ?? module.defaultConfig;
    for (const key of Object.keys(candidate)) {
      const current = candidate[key];
      const wrong = typeof current === "string" ? { wrong: true }
        : typeof current === "number" ? "wrong"
          : typeof current === "boolean" ? "wrong"
            : Array.isArray(current) ? { wrong: true }
              : "wrong";
      expect(module.validateConfig({ ...candidate, [key]: wrong } as never), `${kind}.${key}`).toBe(false);
    }
  });

  it("accepts documented optional fields only when omitted as complete units", () => {
    for (const kind of ["imageCollection", "videoCollection"] as const) {
      expect(canonicalNodeRegistry.forKind(kind).validateConfig({})).toBe(true);
    }
    expect(canonicalNodeRegistry.forKind("imageInput").validateConfig({})).toBe(true);
    expect(canonicalNodeRegistry.forKind("imageInput").validateConfig({ assetId: "asset" })).toBe(false);
    expect(canonicalNodeRegistry.forKind("imageInput").validateConfig({ fileName: "image.png" })).toBe(false);
    for (const kind of ["webpage", "research", "videoFrame", "imageTransform", "imageTrimTransparent"] as const) {
      const candidate = { ...complete[kind] };
      for (const key of ["exportFolderGrant", "exportFolderLabel", "exportNameTemplate", "exportOverwrite", "exportedFiles"]) delete candidate[key];
      expect(canonicalNodeRegistry.forKind(kind).validateConfig(candidate as never), kind).toBe(true);
    }
  });

  it("rejects semantic enum and bound violations", () => {
    expect(canonicalNodeRegistry.forKind("research").validateConfig({ query: "x", resultCount: 0, freshness: "never" })).toBe(false);
    expect(canonicalNodeRegistry.forKind("videoFrame").validateConfig({ frameMode: "percent", frameValue: 101 })).toBe(false);
    expect(canonicalNodeRegistry.forKind("imageTransform").validateConfig({ ...canonicalNodeRegistry.forKind("imageTransform").defaultConfig, targetWidth: 64_000_000, targetHeight: 2 })).toBe(false);
    expect(canonicalNodeRegistry.forKind("imageTrimTransparent").validateConfig({ trimPadding: 65, trimThreshold: 255, listProcessingMode: "map" })).toBe(false);
  });
});
