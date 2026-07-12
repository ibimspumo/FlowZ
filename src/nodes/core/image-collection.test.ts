import { describe, expect, it } from 'vitest';
import { imageCollectionModule } from './image-collection';

describe('image collection module', () => {
  it('resolves immutable result ids into a typed image list', async () => {
    const output = await imageCollectionModule.execute({ id: 'collection', moduleId: imageCollectionModule.id, moduleVersion: 1, position: { x: 0, y: 0 }, config: { collectionResultIds: ['one', 'two'] }, updatePolicy: 'frozen' }, {
      signal: new AbortController().signal, inputs: {}, services: { results: { getImage: async (id) => ({ assetId: `asset:${id}`, mediaType: 'image/png' }) } },
    });
    expect(output.outputs.images).toEqual({ kind: 'list', itemType: 'image', items: [
      { type: 'image', assetId: 'asset:one', mimeType: 'image/png' },
      { type: 'image', assetId: 'asset:two', mimeType: 'image/png' },
    ] });
  });
});
