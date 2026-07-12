import { mediaUrl } from "../persistence/media";
import type { OpenArtboardDocument } from "../artboard-workspace/repository";
import { commitDocumentCover, flowCoverSource, type DocumentCatalogRecord } from "./catalog-api";
import { createFlowCoverModel, LatestCoverJob, type FlowCoverModel } from "./flow-cover";
import type { DocumentCover, DocumentKind, DocumentRecord } from "./types";

const COVER_WIDTH = 480;
const COVER_HEIGHT = 300;
const DEBOUNCE_MS = 900;
const escapeXml = (value: string) => value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&apos;", '"': "&quot;" })[character]!);
const finite = (value: number) => Number.isFinite(value) ? value : 0;

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

async function rasterizeArtboard(opened: OpenArtboardDocument): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const board = opened.revision.workspace.boards[opened.revision.workspace.activeBoardId];
  if (!board) throw new Error("Das aktive Artboard fehlt.");
  const { renderArtboardSvg } = await import("../nodes/brand/artboard-renderer");
  const svg = renderArtboardSvg(board.document, mediaUrl);
  const ratio = Math.min(COVER_WIDTH / board.document.format.width, COVER_HEIGHT / board.document.format.height);
  const width = Math.max(1, Math.round(board.document.format.width * ratio));
  const height = Math.max(1, Math.round(board.document.format.height * ratio));
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d"); if (!context) throw new Error("Artboard-Cover können in dieser WebView nicht gerendert werden.");
  let binary = ""; for (const byte of new TextEncoder().encode(svg)) binary += String.fromCharCode(byte);
  const encoded = btoa(binary);
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const candidate = new Image(); candidate.onload = () => resolve(candidate); candidate.onerror = () => reject(new Error("Das Artboard-Cover konnte nicht geladen werden.")); candidate.src = `data:image/svg+xml;base64,${encoded}`;
  });
  context.drawImage(image, 0, 0, width, height);
  return { bytes: dataUrlBytes(canvas.toDataURL("image/png")), width, height };
}

export type DocumentCoverCoordinatorDependencies = {
  list: () => Promise<DocumentCatalogRecord[]>;
  openArtboard: (id: string) => Promise<OpenArtboardDocument | undefined>;
  onCover: (documentId: string, cover: DocumentCover) => void;
  debounceMs?: number;
  loadFlowSource?: typeof flowCoverSource;
  commit?: typeof commitDocumentCover;
  renderArtboard?: typeof rasterizeArtboard;
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
    for (const item of documents) if (item.health.state === "healthy" && item.cover?.contentFingerprint !== item.contentFingerprint) this.schedule(item.id);
  }

  private async refresh(documentId: string) {
    const job = this.jobs.get(documentId) ?? new LatestCoverJob(); this.jobs.set(documentId, job);
    const ticket = job.begin();
    try {
      const record = (await this.dependencies.list()).find((item) => item.id === documentId);
      if (!record || record.health !== "healthy" || !record.revision || !record.fingerprint || record.cover?.contentFingerprint === record.fingerprint || !ticket.isCurrent()) return;
      let mediaType: "image/svg+xml" | "image/png"; let bytes: Uint8Array; let width: number; let height: number;
      if (record.kind === "flow") {
        const source = await (this.dependencies.loadFlowSource ?? flowCoverSource)(record.id, record.revision, record.fingerprint);
        const svg = renderFlowCoverSvg(createFlowCoverModel(source));
        bytes = new TextEncoder().encode(svg); width = COVER_WIDTH; height = COVER_HEIGHT; mediaType = "image/svg+xml";
      } else {
        const opened = await this.dependencies.openArtboard(record.id);
        if (!opened || opened.revision.revisionNumber !== record.revision) return;
        ({ bytes, width, height } = await (this.dependencies.renderArtboard ?? rasterizeArtboard)(opened)); mediaType = "image/png";
      }
      if (!ticket.isCurrent()) return;
      const cover = await (this.dependencies.commit ?? commitDocumentCover)({ documentId: record.id, kind: record.kind as DocumentKind, expectedRevision: record.revision, contentFingerprint: record.fingerprint, width, height, mediaType, bytes: [...bytes] });
      if (!/^[a-f0-9]{64}$/.test(cover.blobHash)
        || cover.contentFingerprint !== record.fingerprint
        || cover.width !== width || cover.height !== height || cover.mediaType !== mediaType
        || !Number.isFinite(Date.parse(cover.generatedAt))) throw new Error("Cover-Commit lieferte eine unpassende Provenienz.");
      if (ticket.isCurrent()) this.dependencies.onCover(documentId, cover);
    } catch (error) {
      if (!/COVER_(?:SOURCE|COMMIT)_STALE|nicht gefunden|removed/i.test(error instanceof Error ? error.message : String(error))) console.warn("Dokument-Cover konnte nicht aktualisiert werden.", error);
    }
  }

  cancel(documentId: string) { const timer = this.timers.get(documentId); if (timer) clearTimeout(timer); this.timers.delete(documentId); this.jobs.get(documentId)?.cancel(); }
  dispose() { this.disposed = true; for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); for (const job of this.jobs.values()) job.cancel(); this.jobs.clear(); }
}
