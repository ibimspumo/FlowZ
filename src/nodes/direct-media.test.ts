import { describe, expect, it } from "vitest";
import { directMediaBindingFromConfig, isDirectMediaBinding, resolveDirectMediaInputs, type DirectMediaBinding } from "./direct-media";

const binding = (priority: "fallback" | "override" = "fallback"): DirectMediaBinding => ({
  schemaVersion: 1,
  kind: "image",
  blobHash: "a".repeat(64),
  mediaType: "image/png",
  priority,
  source: { kind: "asset-version", assetId: "asset", versionId: "version-2", version: 2 },
});

describe("direct media contract", () => {
  it("uses cable before fallback and exposes intentional override shadowing", () => {
    expect(resolveDirectMediaInputs(["flowz-cas:cable"], binding())).toEqual({
      values: ["flowz-cas:cable"], source: "cable", shadowedCableCount: 0,
    });
    expect(resolveDirectMediaInputs([], binding())).toEqual({
      values: [`flowz-cas:${"a".repeat(64)}`], source: "local-fallback", shadowedCableCount: 0,
    });
    expect(resolveDirectMediaInputs(["flowz-cas:cable"], binding("override"))).toEqual({
      values: [`flowz-cas:${"a".repeat(64)}`], source: "local-override", shadowedCableCount: 1,
    });
  });

  it("rejects paths, URLs, Data URLs, uppercase hashes and unknown fields", () => {
    expect(isDirectMediaBinding(binding())).toBe(true);
    for (const blobHash of ["/tmp/image.png", "file:///tmp/image.png", "data:image/png;base64,AA", "A".repeat(64)]) {
      expect(isDirectMediaBinding({ ...binding(), blobHash })).toBe(false);
    }
    expect(isDirectMediaBinding({ ...binding(), path: "/tmp/image.png" })).toBe(false);
    expect(() => directMediaBindingFromConfig({ directMedia: { ...binding(), url: "https://example.test/a.png" } })).toThrow(/ungültig/);
  });

  it("accepts immutable project-result provenance", () => {
    expect(isDirectMediaBinding({ ...binding(), source: { kind: "project-result", projectId: "project", projectRevision: 3, resultId: "result" } })).toBe(true);
  });
});
