import { describe, expect, it } from 'vitest';
import { isMediaNodeConfig } from './media-config';
import { decodeProjectDocument } from './migrations';
import type { JsonValue } from './project';

const metadata: Record<string, JsonValue> = { kind: 'video', container: 'mov,mp4', codecs: ['h264'], durationSeconds: 2, width: 1920, height: 1080, fps: 25, playable: true };
const full: Record<string, JsonValue> = { blobHash: 'a'.repeat(64), posterHash: 'b'.repeat(64), mediaType: 'video/mp4', fileName: 'clip.mp4', mediaMetadata: metadata };
const project = (config: Record<string, unknown>) => ({ schemaVersion: 2, id: '00000000-0000-4000-8000-000000000001', name: 'Media', createdAt: '2026-07-11T00:00:00Z', updatedAt: '2026-07-11T00:00:00Z', graph: { nodes: [{ id: 'video', moduleId: 'core.video-input', moduleVersion: 1, position: { x: 0, y: 0 }, config, updatePolicy: 'manual' }], edges: [], groups: [] }, canvas: { viewport: { x: 0, y: 0, zoom: 1 } } });

describe('strict media node config', () => {
  it('accepts an empty result-free node and a complete bounded legacy snapshot', () => {
    expect(isMediaNodeConfig({}, 'video')).toBe(true);
    expect(isMediaNodeConfig(full, 'video')).toBe(true);
    expect(decodeProjectDocument(project(full)).graph.nodes[0].moduleId).toBe('core.video-input');
  });
  it('rejects paths, kind/MIME mismatches, partial metadata and unknown fields during decode', () => {
    expect(isMediaNodeConfig({ ...full, fileName: '../clip.mp4' }, 'video')).toBe(false);
    expect(isMediaNodeConfig({ ...full, mediaType: 'audio/mp4' }, 'video')).toBe(false);
    expect(isMediaNodeConfig({ ...full, mediaMetadata: { ...metadata, codecs: [] } }, 'video')).toBe(false);
    expect(isMediaNodeConfig({ ...full, surprise: true }, 'video')).toBe(false);
    expect(() => decodeProjectDocument(project({ ...full, blobHash: 'not-a-hash' }))).toThrow(/config/);
  });
  it('normalizes pre-playable schema-v2/module-v1 media snapshots', () => {
    const { playable: _removed, ...legacyMetadata } = metadata;
    const decoded = decodeProjectDocument(project({ ...full, mediaMetadata: legacyMetadata }));
    expect(decoded.graph.nodes[0].moduleVersion).toBe(1);
    expect(decoded.graph.nodes[0].config.mediaMetadata).toMatchObject({ playable: true });
    const unsupported = decodeProjectDocument(project({ ...full, mediaMetadata: { ...legacyMetadata, codecs: ['prores'] } }));
    expect(unsupported.graph.nodes[0].config.mediaMetadata).toMatchObject({ playable: false });
  });
});
