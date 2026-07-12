import { describe, expect, it, vi } from "vitest";
import { ARTBOARD_FORMATS, type ArtboardDocument, type TextLayer } from "./artboard-domain";
import { createArtboardRenderPlan, layoutText, renderArtboardPngFromDocument, renderArtboardPreviewHtml, renderArtboardSvg } from "./artboard-renderer";

const document: ArtboardDocument = { schemaVersion: 1, id: "document-1", name: "Test", format: { preset: "youtube-thumbnail", width: ARTBOARD_FORMATS["youtube-thumbnail"].width, height: ARTBOARD_FORMATS["youtube-thumbnail"].height }, paint: { kind: "solid", color: "#111111" }, rootLayerIds: ["shape-1", "text-1"], layers: { "shape-1": { id: "shape-1", type: "shape", name: "Fläche", locked: false, visible: true, version: 1, geometry: { x: 0, y: 0, width: 1280, height: 720, rotation: 0 }, shape: "rectangle", fill: { kind: "solid", color: "#FF0088" } }, "text-1": { id: "text-1", type: "text", name: "Titel", locked: false, visible: true, version: 1, geometry: { x: 80, y: 80, width: 420, height: 220, rotation: 12 }, text: "Klar & sicher\nÜberall", color: "#FFFFFF", fontSize: 64, align: "center" } }, bindings: {}, tokenRefs: {} };

describe("canonical artboard rendering", () => {
  it("uses exactly the same deterministic SVG for preview and PNG rasterization", async () => {
    const expectedSvg = renderArtboardSvg(document, () => ""); const expectedPlan = createArtboardRenderPlan(document);
    const backend = vi.fn(async (svg, plan) => { expect(svg).toBe(expectedSvg); expect(plan).toEqual(expectedPlan); return "data:image/png;base64,cG5n"; });
    expect(renderArtboardPreviewHtml(document, () => "")).toContain(expectedSvg);
    expect(await renderArtboardPngFromDocument(document, () => "", backend)).toBe("data:image/png;base64,cG5n");
  });

  it("lays out wrapping, explicit newlines, clipping and ellipsis before either backend", () => {
    const layer = structuredClone(document.layers["text-1"]) as TextLayer; layer.geometry.width = 160; layer.geometry.height = 154; layer.fontSize = 50; layer.text = "Eine sehr lange Zeile\nZweite Zeile";
    const layout = layoutText(layer); expect(layout?.lines).toHaveLength(2); expect(layout?.lines[1].text.endsWith("…")).toBe(true);
    const svg = renderArtboardSvg({ ...document, layers: { ...document.layers, "text-1": layer } }, () => "");
    expect(svg).toContain("clip-path"); expect(svg).toContain("rotate(12"); expect(svg).toContain("font-family=\"Arial\"");
  });

  it("uses canonical SVG aspect-ratio modes for image fit", () => {
    const withImage = structuredClone(document); withImage.rootLayerIds.push("image-1"); withImage.layers["image-1"] = { id: "image-1", type: "image", name: "Foto", locked: false, visible: true, version: 1, geometry: { x: 0, y: 0, width: 100, height: 100, rotation: 0 }, casHash: "a".repeat(64), fit: "cover" };
    expect(renderArtboardSvg(withImage, (hash) => `flowz-media://localhost/${hash}`)).toContain('preserveAspectRatio="xMidYMid slice"');
    expect(() => renderArtboardSvg(withImage, () => "https://example.test/remote.png")).toThrow(/lokalen Medienspeicher/);
  });

  it("escapes text and never accepts JSON or text as PNG", async () => {
    expect(renderArtboardSvg(document, () => "")).toContain("Klar &amp;");
    await expect(renderArtboardPngFromDocument(document, () => "", async () => JSON.stringify(document))).rejects.toThrow(/kein PNG/);
  });

  it("validates before both output paths", async () => {
    const invalid = { ...document, html: "legacy" } as unknown as ArtboardDocument;
    expect(() => renderArtboardPreviewHtml(invalid, () => "")).toThrow(/unbekannte Felder/);
    await expect(renderArtboardPngFromDocument(invalid, () => "", async () => "data:image/png;base64,eA==")).rejects.toThrow(/unbekannte Felder/);
  });
});
