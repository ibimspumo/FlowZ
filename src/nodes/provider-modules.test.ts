import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    runChat: vi.fn(async () => ({
      content: "Nur die Antwort",
      images: [],
      costMicrounits: 1200,
    })),
    runTranscription: vi.fn(async () => ({
      text: "Transkript",
      createdAt: "2026-07-12T00:00:00Z",
      persisted: true,
      targetCurrent: true,
      resultId: "result-1",
      costMicrounits: 800,
    })),
    cancelTranscriptionRun: vi.fn(async () => true),
  };
});

import { canonicalNodeRegistry, MODULE_ID_BY_KIND } from ".";
import { dispatchAppNodeExecution } from "./dispatch";
import type { NodeKind } from "../types";

const node = (kind: Exclude<NodeKind, "unsupported">) => {
  const module = canonicalNodeRegistry.forKind(kind);
  return {
    id: `node-${kind}`,
    moduleId: module.id,
    moduleVersion: module.version,
    position: { x: 0, y: 0 },
    config: structuredClone(module.defaultConfig),
    updatePolicy: "manual" as const,
  };
};

describe("fully extracted provider modules", () => {
  beforeEach(() => vi.clearAllMocks());
  it("uses exact fail-closed config schemas for every product module", () => {
    for (const kind of Object.keys(MODULE_ID_BY_KIND) as Array<
      Exclude<NodeKind, "unsupported">
    >) {
      const module = canonicalNodeRegistry.forKind(kind);
      expect(module.validateConfig(module.defaultConfig), kind).toBe(true);
      expect(
        module.validateConfig({ ...module.defaultConfig, __unknown: true }),
        kind,
      ).toBe(false);
    }
  });
  it("executes structured text and brand work at the concrete module boundary", async () => {
    const text = await dispatchAppNodeExecution(
      canonicalNodeRegistry.forKind("textGeneration"),
      node("textGeneration"),
      {
        signal: new AbortController().signal,
        inputs: {
          prompt: [
            {
              kind: "scalar",
              value: { type: "text", value: "Antworte knapp" },
            },
          ],
        },
      },
    );
    expect(text.outputs.text).toEqual({
      kind: "scalar",
      value: { type: "text", value: "Nur die Antwort" },
    });
    const briefNode = node("brandBrief");
    briefNode.config = {
      ...briefNode.config,
      offer: "Flow-Werkzeug",
      audience: "Solo-Founder",
    };
    const brief = await dispatchAppNodeExecution(
      canonicalNodeRegistry.forKind("brandBrief"),
      briefNode,
      { signal: new AbortController().signal, inputs: {} },
    );
    expect(brief.outputs.brief).toMatchObject({
      kind: "scalar",
      value: { type: "json" },
    });
  });
  it("binds transcription to exact source provenance and exposes the persisted text", async () => {
    const result = await dispatchAppNodeExecution(
      canonicalNodeRegistry.forKind("transcription"),
      node("transcription"),
      {
        signal: new AbortController().signal,
        inputs: {
          audio: [
            {
              kind: "scalar",
              value: { type: "audio", assetId: "a".repeat(64) },
            },
          ],
        },
        services: {
          execution: {
            projectId: "project",
            fingerprint: "fingerprint",
            sourceNodeId: "audio-node",
            sourceResultId: "audio-result",
          },
        },
      },
    );
    expect(result.outputs.text).toEqual({
      kind: "scalar",
      value: { type: "text", value: "Transkript" },
    });
    expect(result.metadata).toMatchObject({
      persisted: true,
      resultId: "result-1",
    });
  });
  it("keeps the Artboard module a compact deterministic reference bridge", async () => {
    const artboard = node("artboard");
    artboard.config = {
      ...artboard.config,
      artboardWorkspaceId: "workspace",
      artboardRevisionId: "revision",
      artboardActiveImageHash: "b".repeat(64),
      artboardSelectedImageHashes: ["b".repeat(64)],
    };
    const result = await dispatchAppNodeExecution(
      canonicalNodeRegistry.forKind("artboard"),
      artboard,
      { signal: new AbortController().signal, inputs: {} },
    );
    expect(result.outputs.image).toMatchObject({
      kind: "scalar",
      value: { type: "image", assetId: "b".repeat(64) },
    });
  });
});
