import { describe, expect, it } from 'vitest';
import { mediaDisplay, mediaUrl } from './media';

describe('local media identities', () => {
  it('builds an opaque hash-only custom protocol URL', () => {
    const hash = 'A'.repeat(64);
    expect(mediaUrl(hash)).toBe(`flowz-media://localhost/${hash.toLowerCase()}`);
    expect(() => mediaUrl('/Users/me/private.mp4')).toThrow('Ungültige Medien-ID');
  });

  it('persists metadata and hashes but no path or data URL', () => {
    const config = mediaDisplay({ hash: 'b'.repeat(64), sizeBytes: 10, mediaType: 'video/mp4', originalName: 'clip.mp4', createdAt: 'now', metadata: { kind: 'video', container: 'mp4', codecs: ['h264'], durationSeconds: 1, width: 1280, height: 720, fps: 25, playable: true }, posterHash: 'c'.repeat(64) });
    expect(config).toMatchObject({ blobHash: 'b'.repeat(64), fileName: 'clip.mp4', posterHash: 'c'.repeat(64) });
    expect(JSON.stringify(config)).not.toContain('Path');
    expect(JSON.stringify(config)).not.toContain('data:');
  });
});
