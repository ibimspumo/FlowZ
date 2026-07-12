import { describe, expect, it } from 'vitest';
import { clampAssetPalettePosition, isCurrentAssetSearch } from './asset-palette-state';

describe('asset palette responsive state', () => {
  it('keeps the full and collapsed palette inside a 320px viewport', () => {
    expect(clampAssetPalettePosition({ x: 900, y: 900 }, { width: 320, height: 568 })).toEqual({ x: 8, y: 74 });
    expect(clampAssetPalettePosition({ x: -20, y: -20 }, { width: 320, height: 568 }, true)).toEqual({ x: 8, y: 62 });
  });

  it('rejects late pages after query, filter, or generation changes', () => {
    const request = { generation: 3, query: 'hero', kind: 'image' as const };
    expect(isCurrentAssetSearch(request, { ...request })).toBe(true);
    expect(isCurrentAssetSearch(request, { ...request, generation: 4 })).toBe(false);
    expect(isCurrentAssetSearch(request, { ...request, query: 'logo' })).toBe(false);
    expect(isCurrentAssetSearch(request, { ...request, kind: 'text' })).toBe(false);
  });
});
