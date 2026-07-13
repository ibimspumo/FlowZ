import { describe, expect, it } from "vitest";
import { ARTBOARD_ZOOM_MAX, ARTBOARD_ZOOM_MIN, artboardZoomShortcut, clampArtboardZoom, fitCanvasRectangles, panByWheel, zoomAtCanvasPoint } from "./canvas-navigation";

describe("artboard canvas navigation", () => {
  it("keeps the world point beneath the cursor stable while zooming", () => {
    const current = { zoom: .5, pan: { x: 100, y: 60 } };
    const point = { x: 420, y: 280 };
    const world = { x: (point.x - current.pan.x) / current.zoom, y: (point.y - current.pan.y) / current.zoom };
    const next = zoomAtCanvasPoint(current, 1.25, point);
    expect(next.zoom).toBe(1.25);
    expect(next.pan.x + world.x * next.zoom).toBeCloseTo(point.x);
    expect(next.pan.y + world.y * next.zoom).toBeCloseTo(point.y);
  });

  it("clamps zoom without losing finite navigation state", () => {
    expect(clampArtboardZoom(0)).toBe(ARTBOARD_ZOOM_MIN);
    expect(clampArtboardZoom(99)).toBe(ARTBOARD_ZOOM_MAX);
    expect(clampArtboardZoom(Number.NaN)).toBe(1);
  });

  it("maps trackpad deltas to pan and Shift+wheel to horizontal pan", () => {
    expect(panByWheel({ x: 100, y: 80 }, { deltaX: 14, deltaY: -22 })).toEqual({ x: 86, y: 102 });
    expect(panByWheel({ x: 100, y: 80 }, { deltaX: 0, deltaY: 24, shiftKey: true })).toEqual({ x: 76, y: 80 });
  });

  it("fits source and candidate rectangles into the unobscured viewport", () => {
    const fit = fitCanvasRectangles([
      { x: 100, y: 100, width: 1080, height: 1080 },
      { x: 1400, y: 100, width: 1080, height: 1920 },
    ], { width: 1600, height: 1000 }, { margin: 48, rightInset: 452 });
    expect(fit).toBeDefined();
    const left = 100 * fit!.zoom + fit!.pan.x;
    const right = (1400 + 1080) * fit!.zoom + fit!.pan.x;
    const top = 100 * fit!.zoom + fit!.pan.y;
    const bottom = (100 + 1920) * fit!.zoom + fit!.pan.y;
    expect(left).toBeGreaterThanOrEqual(48);
    expect(right).toBeLessThanOrEqual(1600 - 452 + 1);
    expect(top).toBeGreaterThanOrEqual(48);
    expect(bottom).toBeLessThanOrEqual(1000 - 48 + 1);
  });

  it("recognizes only app-scoped modifier zoom shortcuts", () => {
    expect(artboardZoomShortcut({ key: "+", metaKey: true, ctrlKey: false })).toBe("in");
    expect(artboardZoomShortcut({ key: "-", metaKey: false, ctrlKey: true })).toBe("out");
    expect(artboardZoomShortcut({ key: "0", metaKey: true, ctrlKey: false })).toBe("fit");
    expect(artboardZoomShortcut({ key: "+", metaKey: false, ctrlKey: false })).toBeUndefined();
  });
});
