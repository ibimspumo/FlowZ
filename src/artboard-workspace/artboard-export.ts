import { renderArtboardPngFromDocument, type ArtboardAssetResolver, type PngRenderBackend } from "../nodes/brand/artboard-renderer";
import type { ArtboardBoard } from "../nodes/brand/artboard-domain";

const PNG_PREFIX = "data:image/png;base64,";
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
const MAX_PNG_BYTES = 32 * 1024 * 1024;

export function pngDataUrlBase64(value: string): string {
  if (!value.startsWith(PNG_PREFIX)) throw new Error("Der Artboard-Renderer hat kein PNG geliefert.");
  const encoded = value.slice(PNG_PREFIX.length);
  const decodedSize = encoded.length ? Math.floor((encoded.length * 3) / 4) - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0) : 0;
  if (!encoded || decodedSize > MAX_PNG_BYTES) throw new Error("Das gerenderte Artboard-PNG überschreitet das sichere IPC-Limit.");
  let header: string;
  try { header = atob(encoded.slice(0, 12)); } catch { throw new Error("Das gerenderte Artboard-PNG ist beschädigt."); }
  if (PNG_SIGNATURE.some((byte, index) => header.charCodeAt(index) !== byte)) throw new Error("Das gerenderte Artboard-PNG ist beschädigt.");
  return encoded;
}

export function pngDataUrlBytes(value: string): Uint8Array {
  const encoded = pngDataUrlBase64(value);
  let binary: string;
  try { binary = atob(encoded); } catch { throw new Error("Das gerenderte Artboard-PNG ist beschädigt."); }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function renderBoardExport(board: ArtboardBoard, resolveAsset: ArtboardAssetResolver, backend?: PngRenderBackend) {
  const png = await renderArtboardPngFromDocument(board.document, resolveAsset, backend);
  return {
    boardId: board.id,
    boardRevisionId: board.activeRevisionId,
    name: board.name,
    pngBase64: pngDataUrlBase64(png),
  };
}

export async function resolveArtboardExportFolder<T>(current: T | undefined, choose: () => Promise<T | undefined>): Promise<T | undefined> {
  return current ?? choose();
}
