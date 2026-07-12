import { describe, expect, it } from 'vitest';
import { createListManifest, fanOutList, reloadListManifest } from './list-persistence';

describe('durable typed lists', () => {
  it('reloads in manifest order and creates stable deliberate fan-out handles', async () => {
    const manifest = createListManifest('text', [
      { resultId: 'r2', type: 'text', contentIdentity: 'h2' }, { resultId: 'r1', type: 'text', contentIdentity: 'h1' },
    ]);
    const values = new Map([['r1', { type: 'text' as const, value: 'one' }], ['r2', { type: 'text' as const, value: 'two' }]]);
    const runtime = await reloadListManifest(manifest, async (id) => values.get(id));
    expect(runtime).toEqual({ kind: 'list', itemType: 'text', items: [{ type: 'text', value: 'two' }, { type: 'text', value: 'one' }] });
    expect(fanOutList(manifest, runtime).map((item) => item.handleId)).toEqual(['item:r2', 'item:r1']);
  });
  it('fails closed for missing, mixed or mismatched values', async () => {
    expect(() => createListManifest('text', [{ resultId: 'r', type: 'image', contentIdentity: 'h' }])).toThrow();
    const manifest = createListManifest('image', [{ resultId: 'r', type: 'image', contentIdentity: 'h' }]);
    await expect(reloadListManifest(manifest, async () => undefined)).rejects.toThrow(/nicht mehr verfügbar/);
    await expect(reloadListManifest(manifest, async () => ({ type: 'text', value: 'wrong' }))).rejects.toThrow(/erwarteten Typ/);
  });
});
