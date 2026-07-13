import type { AssetKind, LibraryAssetPayload, LibraryAssetSummary } from '../persistence/assets';
import type { NodeKind } from '../types';
import { DIRECT_MEDIA_TARGETS } from '../nodes/direct-media';

export const FLOWZ_ASSET_MIME = 'application/x-flowz-asset-version';

type AssetDragEnvelope = {
  schema: 1;
  asset: LibraryAssetSummary;
};

const kinds = new Set<AssetKind>(['prompt', 'text', 'image']);

export function encodeAssetDrag(asset: LibraryAssetSummary): string {
  return JSON.stringify({ schema: 1, asset } satisfies AssetDragEnvelope);
}

export function decodeAssetDrag(raw: string): LibraryAssetSummary | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<AssetDragEnvelope>;
    const asset = parsed.asset as Partial<LibraryAssetSummary> | undefined;
    if (parsed.schema !== 1 || !asset || typeof asset.assetId !== 'string' || typeof asset.versionId !== 'string'
      || typeof asset.version !== 'number' || !Number.isSafeInteger(asset.version) || asset.version < 1
      || typeof asset.name !== 'string' || typeof asset.kind !== 'string' || !kinds.has(asset.kind as AssetKind)
      || typeof asset.createdAt !== 'string') return;
    return asset as LibraryAssetSummary;
  } catch {
    return;
  }
}

export function assetDataType(kind: AssetKind): 'text' | 'image' {
  return kind === 'image' ? 'image' : 'text';
}

export function isCompatibleAssetTarget(kind: AssetKind, nodeKind: NodeKind): boolean {
  return kind === 'image'
    ? nodeKind === 'imageInput' || nodeKind === 'assetImage' || DIRECT_MEDIA_TARGETS.has(nodeKind)
    : nodeKind === 'textInput' || nodeKind === 'assetText';
}

export function assetNodeKind(kind: AssetKind): 'assetText' | 'assetImage' {
  return kind === 'image' ? 'assetImage' : 'assetText';
}

export function assetNodeConfig(item: LibraryAssetSummary) {
  return {
    libraryAssetId: item.assetId,
    assetVersionId: item.versionId,
    assetVersion: item.version,
    assetName: item.name,
    assetKind: item.kind,
  };
}

export function assetValue(item: LibraryAssetPayload): string | undefined {
  return item.kind === 'image' ? item.dataUrl : item.text;
}

export function isCurrentAssetProject(expectedProjectId: string, currentProjectId?: string): boolean {
  return Boolean(currentProjectId) && expectedProjectId === currentProjectId;
}

export async function loadAssetForCurrentProject<T>(
  expectedProjectId: string,
  currentProjectId: () => string | undefined,
  load: () => Promise<T>,
): Promise<{ status: 'ready'; value: T } | { status: 'superseded' }> {
  try {
    const value = await load();
    return isCurrentAssetProject(expectedProjectId, currentProjectId()) ? { status: 'ready', value } : { status: 'superseded' };
  } catch (error) {
    // A rejected request from a project that is no longer active is stale too; it
    // must not leak an error toast into the newly opened project.
    if (!isCurrentAssetProject(expectedProjectId, currentProjectId())) return { status: 'superseded' };
    throw error;
  }
}

export function assetCanvasNodePosition(drop: { x: number; y: number }, nodeWidth = 310): { x: number; y: number } {
  return { x: drop.x - nodeWidth / 2, y: drop.y - 80 };
}
