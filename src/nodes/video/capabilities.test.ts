import { describe, expect, it } from 'vitest';
import { buildFalVideoInput, connectedFalVideoOccupancy, defaultFalVideoConfig, emptyConnectedFalVideoInputs, FAL_VIDEO_ENDPOINTS, falVideoFamily, inferFalVideoEndpoint, selectFalVideoFamily, validateFalVideoConfig } from './capabilities';

describe('fal video capabilities', () => {
  it('fails closed and blocks occupied incompatible ports', () => {
    const config = { duration: 5, resolution: '480p', aspectRatio: '16:9', generateAudio: true, bitrateMode: 'standard' as const };
    expect(validateFalVideoConfig(undefined, config, { startFrame: 0, endFrame: 0, references: 0 })).toHaveLength(1);
    expect(validateFalVideoConfig(FAL_VIDEO_ENDPOINTS[0], config, { startFrame: 1, endFrame: 1, references: 1 })).toHaveLength(3);
  });

  it('pins exact queue endpoint ids and reference JSON fields', () => {
    expect(FAL_VIDEO_ENDPOINTS[0].endpoint).toBe('bytedance/seedance-2.0/fast/text-to-video');
    const capability = FAL_VIDEO_ENDPOINTS[2];
    const input = buildFalVideoInput(capability, 'Brand film', defaultFalVideoConfig(capability), { references: ['https://v3.fal.media/a.png'] });
    expect(input).toMatchObject({ image_urls: ['https://v3.fal.media/a.png'], bitrate_mode: 'standard' });
    expect(input).not.toHaveProperty('reference_image_urls');
  });

  it('serializes only fields supported by the audited endpoint adapter', () => {
    const capability = FAL_VIDEO_ENDPOINTS[1];
    const input = buildFalVideoInput(capability, 'Kamerafahrt', defaultFalVideoConfig(capability), { startFrame: 'fal://start', endFrame: 'fal://end', references: ['ignored'] });
    expect(input).toMatchObject({ prompt: 'Kamerafahrt', image_url: 'fal://start', end_image_url: 'fal://end' });
    expect(input).not.toHaveProperty('reference_image_urls');
  });

  it('infers exact endpoint mode from connected semantic image ports', () => {
    const family = 'bytedance/seedance-2.0/fast';
    expect(inferFalVideoEndpoint(family, { startFrame: 0, endFrame: 0, references: 0 }).endpoint?.mode).toBe('text-to-video');
    expect(inferFalVideoEndpoint(family, { startFrame: 1, endFrame: 1, references: 0 }).endpoint?.mode).toBe('image-to-video');
    expect(inferFalVideoEndpoint(family, { startFrame: 0, endFrame: 0, references: 2 }).endpoint?.mode).toBe('reference-to-video');
    expect(inferFalVideoEndpoint(family, { startFrame: 1, endFrame: 0, references: 1 }).error).toContain('nicht gleichzeitig');
  });
  it('changes only family identity instead of coercing user-owned parameters', () => {
    expect(selectFalVideoFamily('bytedance/seedance-2.0/fast')).toEqual({ model: 'bytedance/seedance-2.0/fast' });
    expect(selectFalVideoFamily('unknown')).toBeUndefined();
  });

  it('normalizes both the default endpoint and dropdown family before switching modes', () => {
    const family = 'bytedance/seedance-2.0/fast';
    expect(falVideoFamily(FAL_VIDEO_ENDPOINTS[0].endpoint)).toBe(family);
    expect(falVideoFamily(selectFalVideoFamily(family)!.model)).toBe(family);
    expect(inferFalVideoEndpoint(family, { startFrame: 0, endFrame: 0, references: 0 }).endpoint?.endpoint).toBe(FAL_VIDEO_ENDPOINTS[0].endpoint);
    expect(inferFalVideoEndpoint(family, { startFrame: 1, endFrame: 0, references: 0 }).endpoint?.endpoint).toBe(FAL_VIDEO_ENDPOINTS[1].endpoint);
    expect(inferFalVideoEndpoint(family, { startFrame: 0, endFrame: 0, references: 1 }).endpoint?.endpoint).toBe(FAL_VIDEO_ENDPOINTS[2].endpoint);
  });

  it('selects the connected mode but blocks a connected source without a result', () => {
    const materialized = { startFrame: 0, endFrame: 0, references: 0 };
    const connected = new Set(['startFrame']);
    const occupied = connectedFalVideoOccupancy(materialized, connected);
    expect(occupied).toEqual({ startFrame: 1, endFrame: 0, references: 0 });
    expect(inferFalVideoEndpoint('bytedance/seedance-2.0/fast', occupied).endpoint?.mode).toBe('image-to-video');
    expect(emptyConnectedFalVideoInputs(materialized, connected)).toEqual([
      'Das verbundene Startbild besitzt noch kein Ergebnis.',
    ]);
  });
});
