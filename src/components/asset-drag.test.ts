import { describe, expect, it } from 'vitest';
import type { LibraryAssetSummary } from '../persistence/assets';
import { assetCanvasNodePosition, assetDataType, assetNodeConfig, assetNodeKind, decodeAssetDrag, encodeAssetDrag, isCompatibleAssetTarget, isCurrentAssetProject, loadAssetForCurrentProject } from './asset-drag';

const image: LibraryAssetSummary = {
  assetId: 'asset-1', versionId: 'version-1', version: 2, name: 'Hero', kind: 'image',
  createdAt: '2026-07-11T08:00:00.000Z', sourceProjectId: 'project-1',
};

describe('asset drag payload', () => {
  it('round-trips the immutable version descriptor', () => {
    expect(decodeAssetDrag(encodeAssetDrag(image))).toEqual(image);
  });

  it('rejects malformed and unsupported payloads', () => {
    expect(decodeAssetDrag('no json')).toBeUndefined();
    expect(decodeAssetDrag(JSON.stringify({ schema: 1, asset: { ...image, version: 0 } }))).toBeUndefined();
    expect(decodeAssetDrag(JSON.stringify({ schema: 2, asset: image }))).toBeUndefined();
  });
});

describe('asset drop compatibility', () => {
  it('accepts only matching input and asset node types', () => {
    expect(isCompatibleAssetTarget('image', 'imageInput')).toBe(true);
    expect(isCompatibleAssetTarget('image', 'assetImage')).toBe(true);
    expect(isCompatibleAssetTarget('image', 'imageAnalysis')).toBe(true);
    expect(isCompatibleAssetTarget('image', 'imageTrimTransparent')).toBe(true);
    expect(isCompatibleAssetTarget('image', 'textInput')).toBe(false);
    expect(isCompatibleAssetTarget('text', 'textInput')).toBe(true);
    expect(isCompatibleAssetTarget('prompt', 'assetText')).toBe(true);
    expect(isCompatibleAssetTarget('prompt', 'imageInput')).toBe(false);
  });

  it('maps kind and config without losing the version binding', () => {
    expect(assetDataType('prompt')).toBe('text');
    expect(assetNodeKind('image')).toBe('assetImage');
    expect(assetNodeConfig(image)).toMatchObject({
      libraryAssetId: 'asset-1', assetVersionId: 'version-1', assetVersion: 2,
      assetKind: 'image', assetSourceProjectId: 'project-1',
    });
  });

  it('places a dropped asset around the exact flow coordinate and rejects a switched project', () => {
    expect(assetCanvasNodePosition({ x: 420, y: 260 })).toEqual({ x: 265, y: 180 });
    expect(isCurrentAssetProject('project-a', 'project-a')).toBe(true);
    expect(isCurrentAssetProject('project-a', 'project-b')).toBe(false);
    expect(isCurrentAssetProject('project-a')).toBe(false);
  });

  it('suppresses a rejected content load after the active project switched', async () => {
    let projectId = 'project-a';
    let rejectLoad!: (reason: Error) => void;
    const loading = loadAssetForCurrentProject('project-a', () => projectId, () => new Promise<string>((_, reject) => { rejectLoad = reject; }));
    projectId = 'project-b';
    rejectLoad(new Error('late backend failure'));
    await expect(loading).resolves.toEqual({ status: 'superseded' });
  });

  it('still reports a rejected content load for the active project', async () => {
    await expect(loadAssetForCurrentProject('project-a', () => 'project-a', async () => { throw new Error('current failure'); }))
      .rejects.toThrow('current failure');
  });
});
