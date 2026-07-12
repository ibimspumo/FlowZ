import type { AssetKind } from '../persistence/assets';

export type PalettePoint = { x: number; y: number };

export function clampAssetPalettePosition(point: PalettePoint, viewport: { width: number; height: number }, collapsed = false): PalettePoint {
  const width = Math.min(collapsed ? 220 : 354, Math.max(0, viewport.width - 16));
  const height = collapsed ? 48 : Math.min(590, Math.max(0, viewport.height - 82));
  return {
    x: Math.max(8, Math.min(point.x, viewport.width - width - 8)),
    y: Math.max(62, Math.min(point.y, viewport.height - height - 8)),
  };
}

export function isCurrentAssetSearch(
  request: { generation: number; query: string; kind?: AssetKind },
  current: { generation: number; query: string; kind?: AssetKind },
): boolean {
  return request.generation === current.generation && request.query === current.query && request.kind === current.kind;
}
