export const ARTBOARD_ZOOM_MIN = .02;
export const ARTBOARD_ZOOM_MAX = 4;

export type CanvasPan = { x: number; y: number };
export type CanvasRectangle = { x: number; y: number; width: number; height: number };

export function clampArtboardZoom(value: number) {
  if (!Number.isFinite(value)) return 1;
  return Math.min(ARTBOARD_ZOOM_MAX, Math.max(ARTBOARD_ZOOM_MIN, value));
}

export function zoomAtCanvasPoint(
  current: { zoom: number; pan: CanvasPan },
  nextZoom: number,
  point: { x: number; y: number },
): { zoom: number; pan: CanvasPan } {
  const zoom = clampArtboardZoom(nextZoom);
  const worldX = (point.x - current.pan.x) / current.zoom;
  const worldY = (point.y - current.pan.y) / current.zoom;
  return { zoom, pan: { x: point.x - worldX * zoom, y: point.y - worldY * zoom } };
}

export function panByWheel(pan: CanvasPan, input: { deltaX: number; deltaY: number; shiftKey?: boolean }): CanvasPan {
  const xDelta = input.shiftKey && Math.abs(input.deltaX) < Math.abs(input.deltaY) ? input.deltaY : input.deltaX;
  const yDelta = input.shiftKey && Math.abs(input.deltaX) < Math.abs(input.deltaY) ? 0 : input.deltaY;
  return { x: pan.x - xDelta, y: pan.y - yDelta };
}

export function fitCanvasRectangles(
  rectangles: readonly CanvasRectangle[],
  viewport: { width: number; height: number },
  options: { margin?: number; rightInset?: number; maxZoom?: number } = {},
): { zoom: number; pan: CanvasPan } | undefined {
  if (!rectangles.length || viewport.width <= 0 || viewport.height <= 0) return undefined;
  const margin = options.margin ?? 48;
  const rightInset = options.rightInset ?? margin;
  const minX = Math.min(...rectangles.map((item) => item.x));
  const minY = Math.min(...rectangles.map((item) => item.y));
  const maxX = Math.max(...rectangles.map((item) => item.x + item.width));
  const maxY = Math.max(...rectangles.map((item) => item.y + item.height));
  const availableWidth = Math.max(1, viewport.width - margin - rightInset);
  const availableHeight = Math.max(1, viewport.height - margin * 2);
  const zoom = clampArtboardZoom(Math.min(
    options.maxZoom ?? 1,
    availableWidth / Math.max(1, maxX - minX),
    availableHeight / Math.max(1, maxY - minY),
  ));
  const contentWidth = (maxX - minX) * zoom;
  const contentHeight = (maxY - minY) * zoom;
  return {
    zoom,
    pan: {
      x: margin + Math.max(0, (availableWidth - contentWidth) / 2) - minX * zoom,
      y: margin + Math.max(0, (availableHeight - contentHeight) / 2) - minY * zoom,
    },
  };
}

export function artboardZoomShortcut(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey">): "in" | "out" | "fit" | undefined {
  if (!event.metaKey && !event.ctrlKey) return undefined;
  if (event.key === "+" || event.key === "=") return "in";
  if (event.key === "-" || event.key === "_") return "out";
  if (event.key === "0") return "fit";
  return undefined;
}

export function isFormEditingTarget(target: EventTarget | null) {
  return typeof HTMLElement !== "undefined" && target instanceof HTMLElement && Boolean(target.closest("input,textarea,select,[contenteditable=true],[role=textbox]"));
}
