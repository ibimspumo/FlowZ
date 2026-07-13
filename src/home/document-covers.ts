import { mediaUrl } from "../persistence/media";
import type { OpenArtboardDocument } from "../artboard-workspace/repository";
import type { ArtboardWorkspace } from "../nodes/brand/artboard-domain";
import { commitDocumentCover, flowCoverSource, type DocumentCatalogRecord } from "./catalog-api";
import { createFlowCoverModel, LatestCoverJob, type FlowCoverModel } from "./flow-cover";
import type { DocumentKind, DocumentRecord } from "./types";

const COVER_WIDTH = 480;
const COVER_HEIGHT = 300;
const DEBOUNCE_MS = 900;
const escapeXml = (value: string) => value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&apos;", '"': "&quot;" })[character]!);
const finite = (value: number) => Number.isFinite(value) ? value : 0;

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath(); context.moveTo(x + r, y); context.lineTo(x + width - r, y);
  context.quadraticCurveTo(x + width, y, x + width, y + r); context.lineTo(x + width, y + height - r);
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height); context.lineTo(x + r, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - r); context.lineTo(x, y + r);
  context.quadraticCurveTo(x, y, x + r, y); context.closePath();
}

function coverText(value: string, limit: number) {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, Math.max(0, limit - 1))}…` : compact;
}

async function loadCoverImage(hash: string): Promise<HTMLImageElement | undefined> {
  return new Promise((resolve) => {
    const candidate = new Image(); const timer = window.setTimeout(() => resolve(undefined), 1_200);
    candidate.onload = () => { window.clearTimeout(timer); resolve(candidate); };
    candidate.onerror = () => { window.clearTimeout(timer); resolve(undefined); };
    candidate.src = mediaUrl(hash);
  });
}

function drawCoverImage(context: CanvasRenderingContext2D, image: HTMLImageElement, x: number, y: number, width: number, height: number) {
  const ratio = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const sourceWidth = width / ratio; const sourceHeight = height / ratio;
  const sourceX = (image.naturalWidth - sourceWidth) / 2; const sourceY = (image.naturalHeight - sourceHeight) / 2;
  context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, x, y, width, height);
}

/** Renders the persisted graph, not a second React Flow instance. This keeps Home cheap even for large documents. */
export async function rasterizeFlowCover(model: FlowCoverModel): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  if (typeof document === "undefined" || typeof Image === "undefined") throw new Error("Canvas-Renderer ist nicht verfügbar.");
  const requestedPreviews = model.nodes.filter((node) => node.previewBlobHash).slice(0, 12);
  const previewEntries = await Promise.all(requestedPreviews.map(async (node) => [node.id, await loadCoverImage(node.previewBlobHash!)] as const));
  const previews = new Map(previewEntries.filter((entry): entry is readonly [string, HTMLImageElement] => Boolean(entry[1])));
  const render = (withImages: boolean) => {
    const canvas = document.createElement("canvas"); canvas.width = COVER_WIDTH; canvas.height = COVER_HEIGHT;
    const context = canvas.getContext("2d"); if (!context) throw new Error("Canvas-Renderer ist nicht verfügbar.");
    context.fillStyle = "#100d10"; context.fillRect(0, 0, COVER_WIDTH, COVER_HEIGHT);
    context.fillStyle = "#2b252b";
    for (let y = 14; y < COVER_HEIGHT; y += 22) for (let x = 14; x < COVER_WIDTH; x += 22) context.fillRect(x, y, 1, 1);
    if (!model.nodes.length && !model.groups.length) return canvas;
    const padding = 22; const { x, y, width, height } = model.viewBox;
    const scale = Math.min((COVER_WIDTH - padding * 2) / width, (COVER_HEIGHT - padding * 2) / height);
    const offsetX = (COVER_WIDTH - width * scale) / 2 - x * scale;
    const offsetY = (COVER_HEIGHT - height * scale) / 2 - y * scale;
    context.save(); context.translate(offsetX, offsetY); context.scale(scale, scale);
    for (const group of model.groups) {
      roundedRect(context, group.x, group.y, group.width, group.height, 22);
      context.fillStyle = `${group.color}16`; context.fill(); context.strokeStyle = `${group.color}70`; context.lineWidth = 3 / scale; context.stroke();
    }
    const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
    for (const edge of model.edges) {
      const source = nodeById.get(edge.sourceId); const target = nodeById.get(edge.targetId); if (!source || !target) continue;
      const x1 = source.x + source.width; const y1 = source.y + 40; const x2 = target.x; const y2 = target.y + 40;
      const bend = Math.max(42, Math.abs(x2 - x1) * .48);
      context.beginPath(); context.moveTo(x1, y1); context.bezierCurveTo(x1 + bend, y1, x2 - bend, y2, x2, y2);
      context.strokeStyle = edge.color; context.globalAlpha = .78; context.lineWidth = 3 / scale; context.lineCap = "round"; context.stroke(); context.globalAlpha = 1;
    }
    for (const node of model.nodes) {
      roundedRect(context, node.x, node.y, node.width, node.height, 14); context.fillStyle = "#171317"; context.fill();
      context.strokeStyle = "#403640"; context.lineWidth = 2 / scale; context.stroke();
      context.save(); roundedRect(context, node.x + 1, node.y + 1, node.width - 2, node.height - 2, 13); context.clip();
      context.fillStyle = "#211b21"; context.fillRect(node.x, node.y, node.width, 58);
      context.fillStyle = node.color; roundedRect(context, node.x + 16, node.y + 15, 28, 28, 7); context.fill();
      context.fillStyle = "#f4edf4"; context.font = "600 18px Inter, system-ui, sans-serif";
      context.fillText(coverText(node.label || node.moduleId || "Node", 26), node.x + 56, node.y + 34, node.width - 72);
      context.fillStyle = "#9d8f9d"; context.font = "12px Inter, system-ui, sans-serif";
      context.fillText(coverText((node.moduleId || "").split(".").at(-1) || "", 30), node.x + 56, node.y + 50, node.width - 72);
      const bodyX = node.x + 16; const bodyY = node.y + 74; const bodyWidth = node.width - 32; const bodyHeight = node.height - 92;
      const preview = withImages ? previews.get(node.id) : undefined;
      if (preview) { roundedRect(context, bodyX, bodyY, bodyWidth, bodyHeight, 8); context.clip(); drawCoverImage(context, preview, bodyX, bodyY, bodyWidth, bodyHeight); }
      else if (node.previewText) {
        roundedRect(context, bodyX, bodyY, bodyWidth, bodyHeight, 8); context.fillStyle = "#0c0a0c"; context.fill();
        context.fillStyle = "#d2c8d2"; context.font = "14px Inter, system-ui, sans-serif";
        const words = coverText(node.previewText, 120).split(" "); let line = ""; let lineY = bodyY + 24;
        for (const word of words) { const next = `${line}${line ? " " : ""}${word}`; if (context.measureText(next).width > bodyWidth - 20 && line) { context.fillText(line, bodyX + 10, lineY, bodyWidth - 20); line = word; lineY += 21; if (lineY > bodyY + bodyHeight - 10) break; } else line = next; }
        if (lineY <= bodyY + bodyHeight - 10) context.fillText(line, bodyX + 10, lineY, bodyWidth - 20);
      } else {
        context.fillStyle = "#2a232a"; roundedRect(context, bodyX, bodyY, bodyWidth * .72, 14, 7); context.fill();
        context.fillStyle = "#241f24"; roundedRect(context, bodyX, bodyY + 28, bodyWidth * .48, 10, 5); context.fill();
      }
      context.restore();
      context.fillStyle = node.color; context.beginPath(); context.arc(node.x, node.y + 40, 7, 0, Math.PI * 2); context.fill();
      context.beginPath(); context.arc(node.x + node.width, node.y + 40, 7, 0, Math.PI * 2); context.fill();
    }
    context.restore(); return canvas;
  };
  let canvas = render(true); let dataUrl: string;
  try { dataUrl = canvas.toDataURL("image/png"); }
  catch { canvas = render(false); dataUrl = canvas.toDataURL("image/png"); }
  return { bytes: dataUrlBytes(dataUrl), width: COVER_WIDTH, height: COVER_HEIGHT };
}

export function renderFlowCoverSvg(model: FlowCoverModel): string {
  const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
  const edges = model.edges.map((edge) => {
    const source = nodeById.get(edge.sourceId); const target = nodeById.get(edge.targetId);
    if (!source || !target) return "";
    const x1 = finite(source.x + source.width); const y1 = finite(source.y + source.height / 2);
    const x2 = finite(target.x); const y2 = finite(target.y + target.height / 2);
    const bend = Math.max(36, Math.abs(x2 - x1) * 0.48);
    return `<path d="M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}" fill="none" stroke="${escapeXml(edge.color)}" stroke-width="5" stroke-linecap="round" opacity=".72"/>`;
  }).join("");
  const groups = model.groups.map((group) => `<rect x="${finite(group.x)}" y="${finite(group.y)}" width="${finite(group.width)}" height="${finite(group.height)}" rx="22" fill="${escapeXml(group.color)}" fill-opacity=".07" stroke="${escapeXml(group.color)}" stroke-opacity=".35" stroke-width="3"/>`).join("");
  const nodes = model.nodes.map((node) => `<g><rect x="${finite(node.x)}" y="${finite(node.y)}" width="${finite(node.width)}" height="${finite(node.height)}" rx="18" fill="#171317" stroke="#403640" stroke-width="3"/><rect x="${finite(node.x)}" y="${finite(node.y)}" width="12" height="${finite(node.height)}" rx="6" fill="${escapeXml(node.color)}"/><rect x="${finite(node.x + 34)}" y="${finite(node.y + 34)}" width="${finite(Math.max(24, node.width * .58))}" height="18" rx="9" fill="#F4EDF4" opacity=".82"/><rect x="${finite(node.x + 34)}" y="${finite(node.y + 76)}" width="${finite(Math.max(18, node.width * .38))}" height="12" rx="6" fill="#9D8F9D" opacity=".52"/><circle cx="${finite(node.x + node.width)}" cy="${finite(node.y + node.height / 2)}" r="9" fill="${escapeXml(node.color)}"/></g>`).join("");
  const { x, y, width, height } = model.viewBox;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${COVER_WIDTH}" height="${COVER_HEIGHT}" viewBox="${finite(x)} ${finite(y)} ${finite(width)} ${finite(height)}" preserveAspectRatio="xMidYMid meet"><rect x="${finite(x)}" y="${finite(y)}" width="${finite(width)}" height="${finite(height)}" fill="#100D10"/><g opacity=".18" stroke="#786A78" stroke-width="1"><path d="M${finite(x)} ${finite(y + height * .25)}H${finite(x + width)}M${finite(x)} ${finite(y + height * .5)}H${finite(x + width)}M${finite(x)} ${finite(y + height * .75)}H${finite(x + width)}"/></g>${groups}${edges}${nodes}</svg>`;
}

function dataUrlBytes(dataUrl: string): Uint8Array {
  const encoded = dataUrl.split(",", 2)[1];
  if (!encoded) throw new Error("Cover-Renderer lieferte keine Bilddaten.");
  const binary = atob(encoded); const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export type ArtboardCoverLayout = {
  bounds: { x: number; y: number; width: number; height: number };
  scale: number;
  offsetX: number;
  offsetY: number;
  boards: Array<{ id: string; x: number; y: number; width: number; height: number }>;
};

/** Fits the complete pasteboard, so Home represents one board and large variant sets faithfully. */
export function createArtboardCoverLayout(workspace: ArtboardWorkspace, width = COVER_WIDTH, height = COVER_HEIGHT, padding = 18): ArtboardCoverLayout {
  const boards = Object.values(workspace.boards).map((board) => {
    const placement = workspace.placements[board.id] ?? { x: 0, y: 0 };
    return { id: board.id, x: finite(placement.x), y: finite(placement.y), width: Math.max(1, finite(board.document.format.width)), height: Math.max(1, finite(board.document.format.height)) };
  });
  if (!boards.length) throw new Error("Das Artboard-Dokument enthält keine Arbeitsfläche.");
  const minX = Math.min(...boards.map((board) => board.x));
  const minY = Math.min(...boards.map((board) => board.y));
  const maxX = Math.max(...boards.map((board) => board.x + board.width));
  const maxY = Math.max(...boards.map((board) => board.y + board.height));
  const bounds = { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
  const scale = Math.min((width - padding * 2) / bounds.width, (height - padding * 2) / bounds.height);
  return {
    bounds,
    scale,
    offsetX: (width - bounds.width * scale) / 2 - bounds.x * scale,
    offsetY: (height - bounds.height * scale) / 2 - bounds.y * scale,
    boards,
  };
}

function scaledSvg(svg: string, width: number, height: number): string {
  return svg.replace(/^(<svg\b[^>]*\bwidth=")[^"]+("[^>]*\bheight=")[^"]+(")/, `$1${width}$2${height}$3`);
}

function svgImage(svg: string, width: number, height: number): Promise<HTMLImageElement> {
  let binary = ""; for (const byte of new TextEncoder().encode(scaledSvg(svg, width, height))) binary += String.fromCharCode(byte);
  const encoded = btoa(binary);
  return new Promise((resolve, reject) => {
    const candidate = new Image();
    const timer = window.setTimeout(() => reject(new Error("Das Artboard-Cover hat beim Laden das Zeitlimit überschritten.")), 4_000);
    candidate.onload = () => { window.clearTimeout(timer); resolve(candidate); };
    candidate.onerror = () => { window.clearTimeout(timer); reject(new Error("Das Artboard-Cover konnte nicht geladen werden.")); };
    candidate.src = `data:image/svg+xml;base64,${encoded}`;
  });
}

export type ArtboardCoverRenderItem = ArtboardCoverLayout["boards"][number] & { targetWidth: number; targetHeight: number };

export function createArtboardCoverRenderQueue(layout: ArtboardCoverLayout): ArtboardCoverRenderItem[] {
  return layout.boards.map((board) => ({
    ...board,
    targetWidth: Math.max(1, Math.ceil(board.width * layout.scale)),
    targetHeight: Math.max(1, Math.ceil(board.height * layout.scale)),
  }));
}

/** Keeps decoded board pixels bounded: the next board starts only after the previous one was consumed. */
export async function consumeArtboardCoverRenderQueue(
  queue: readonly ArtboardCoverRenderItem[],
  consume: (item: ArtboardCoverRenderItem) => Promise<void>,
): Promise<void> {
  for (const item of queue) await consume(item);
}

export async function rasterizeArtboard(opened: OpenArtboardDocument): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const workspace = opened.revision.workspace;
  const layout = createArtboardCoverLayout(workspace);
  const { renderArtboardSvg } = await import("../nodes/brand/artboard-renderer");
  const canvas = document.createElement("canvas"); canvas.width = COVER_WIDTH; canvas.height = COVER_HEIGHT;
  const context = canvas.getContext("2d"); if (!context) throw new Error("Artboard-Cover können in dieser WebView nicht gerendert werden.");
  context.fillStyle = "#100d10"; context.fillRect(0, 0, COVER_WIDTH, COVER_HEIGHT);
  context.fillStyle = "#2b252b";
  for (let y = 14; y < COVER_HEIGHT; y += 22) for (let x = 14; x < COVER_WIDTH; x += 22) context.fillRect(x, y, 1, 1);
  await consumeArtboardCoverRenderQueue(createArtboardCoverRenderQueue(layout), async (board) => {
    const document = workspace.boards[board.id]?.document;
    if (!document) return;
    const image = await svgImage(renderArtboardSvg(document, mediaUrl), board.targetWidth, board.targetHeight);
    const x = layout.offsetX + board.x * layout.scale;
    const y = layout.offsetY + board.y * layout.scale;
    const width = board.width * layout.scale;
    const height = board.height * layout.scale;
    context.save();
    context.shadowColor = "rgba(0,0,0,.48)"; context.shadowBlur = Math.min(7, Math.max(1, 4 * layout.scale)); context.shadowOffsetY = Math.min(4, Math.max(1, 2 * layout.scale));
    context.drawImage(image, x, y, width, height);
    context.restore();
    context.strokeStyle = workspace.activeBoardId === board.id ? "#c084fc" : "#625762";
    context.lineWidth = workspace.activeBoardId === board.id ? 2 : 1;
    context.strokeRect(x, y, width, height);
    image.src = "";
  });
  return { bytes: dataUrlBytes(canvas.toDataURL("image/png")), width: COVER_WIDTH, height: COVER_HEIGHT };
}

export type DocumentCoverCoordinatorDependencies = {
  list: () => Promise<DocumentCatalogRecord[]>;
  openArtboard: (id: string) => Promise<OpenArtboardDocument | undefined>;
  onCover: (documentId: string, cover: NonNullable<DocumentCatalogRecord["cover"]>, source: DocumentCatalogRecord) => void;
  debounceMs?: number;
  loadFlowSource?: typeof flowCoverSource;
  commit?: typeof commitDocumentCover;
  renderArtboard?: typeof rasterizeArtboard;
  renderFlow?: typeof rasterizeFlowCover;
};

/** Latest-wins, non-blocking cover worker. Every native commit rechecks exact document provenance. */
export class DocumentCoverCoordinator {
  private readonly jobs = new Map<string, LatestCoverJob>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;
  constructor(private readonly dependencies: DocumentCoverCoordinatorDependencies) {}

  schedule(documentId: string) {
    if (this.disposed) return;
    const previous = this.timers.get(documentId); if (previous) clearTimeout(previous);
    const timer = setTimeout(() => { this.timers.delete(documentId); void this.refresh(documentId); }, this.dependencies.debounceMs ?? DEBOUNCE_MS);
    this.timers.set(documentId, timer);
  }

  scheduleMissing(documents: readonly DocumentRecord[]) {
    for (const item of documents) if (item.health.state === "healthy"
      && (item.cover?.contentFingerprint !== item.contentFingerprint || item.cover?.mediaType !== "image/png")) this.schedule(item.id);
  }

  private async refresh(documentId: string) {
    const job = this.jobs.get(documentId) ?? new LatestCoverJob(); this.jobs.set(documentId, job);
    const ticket = job.begin();
    try {
      const record = (await this.dependencies.list()).find((item) => item.id === documentId);
      const contentFingerprint = record?.coverFingerprint ?? record?.fingerprint;
      if (!record || record.health !== "healthy" || !record.revision || !contentFingerprint
        || (record.cover?.contentFingerprint === contentFingerprint && record.cover.mediaType === "image/png")
        || !ticket.isCurrent()) return;
      let mediaType: "image/svg+xml" | "image/png"; let bytes: Uint8Array; let width: number; let height: number;
      if (record.kind === "flow") {
        const source = await (this.dependencies.loadFlowSource ?? flowCoverSource)(record.id, record.revision, contentFingerprint);
        const model = createFlowCoverModel(source);
        if (this.dependencies.renderFlow || (typeof document !== "undefined" && typeof Image !== "undefined" && typeof CanvasRenderingContext2D !== "undefined")) {
          ({ bytes, width, height } = await (this.dependencies.renderFlow ?? rasterizeFlowCover)(model)); mediaType = "image/png";
        } else {
          const svg = renderFlowCoverSvg(model); bytes = new TextEncoder().encode(svg); width = COVER_WIDTH; height = COVER_HEIGHT; mediaType = "image/svg+xml";
        }
      } else {
        const opened = await this.dependencies.openArtboard(record.id);
        if (!opened || opened.revision.revisionNumber !== record.revision) return;
        ({ bytes, width, height } = await (this.dependencies.renderArtboard ?? rasterizeArtboard)(opened)); mediaType = "image/png";
      }
      if (!ticket.isCurrent()) return;
      const cover = await (this.dependencies.commit ?? commitDocumentCover)({ documentId: record.id, kind: record.kind as DocumentKind, expectedRevision: record.revision, contentFingerprint, width, height, mediaType, bytes: [...bytes] });
      if (!/^[a-f0-9]{64}$/.test(cover.blobHash)
        || cover.contentFingerprint !== contentFingerprint
        || cover.width !== width || cover.height !== height || cover.mediaType !== mediaType
        || !Number.isFinite(Date.parse(cover.generatedAt))) throw new Error("Cover-Commit lieferte eine unpassende Provenienz.");
      const verified = (await this.dependencies.list()).find((item) => item.id === documentId);
      const verifiedFingerprint = verified?.coverFingerprint ?? verified?.fingerprint;
      if (!ticket.isCurrent() || verified?.revision !== record.revision || verifiedFingerprint !== contentFingerprint) return;
      this.dependencies.onCover(documentId, cover, { ...verified, cover });
    } catch (error) {
      if (!/COVER_(?:SOURCE|COMMIT)_STALE|nicht gefunden|removed/i.test(error instanceof Error ? error.message : String(error))) console.warn("Dokument-Cover konnte nicht aktualisiert werden.", error);
    }
  }

  cancel(documentId: string) { const timer = this.timers.get(documentId); if (timer) clearTimeout(timer); this.timers.delete(documentId); this.jobs.get(documentId)?.cancel(); }
  dispose() { this.disposed = true; for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); for (const job of this.jobs.values()) job.cancel(); this.jobs.clear(); }
}
