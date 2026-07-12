import { describe, expect, it } from 'vitest';
import { videoCollectionModule } from './video-collection';

describe('video collection module', () => {
  it('resolves immutable result ids into a typed video list', async () => {
    const output = await videoCollectionModule.execute({ id: 'collection', moduleId: videoCollectionModule.id, moduleVersion: 1, position: { x: 0, y: 0 }, config: { collectionResultIds: ['one', 'two'] }, updatePolicy: 'frozen' }, {
      signal: new AbortController().signal, inputs: {}, services: { results: { getImage: async () => { throw new Error('not used'); }, getVideo: async (id) => ({ assetId: `asset:${id}`, mediaType: 'video/mp4' }) } },
    });
    expect(output.outputs.videos).toEqual({ kind: 'list', itemType: 'video', items: [
      { type: 'video', assetId: 'asset:one', mimeType: 'video/mp4' },
      { type: 'video', assetId: 'asset:two', mimeType: 'video/mp4' },
    ] });
  });
});
