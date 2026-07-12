import { describe, expect, it } from 'vitest';
import { buildImageToolInput, defaultUpscaleConfig, outputDimensions, topazEstimateMicrounits, validateUpscaleConfig } from './tool-capabilities';

describe('fal image tool capabilities', () => {
  it('builds exact SeedVR target fields', () => {
    const config = { ...defaultUpscaleConfig(), upscaleMode: 'target' as const, targetResolution: '2160p' as const, seed: 42, noise: 0.25 };
    expect(buildImageToolInput(config, 'https://example.test/a.png')).toEqual({ image_url: 'https://example.test/a.png', upscale_mode: 'target', target_resolution: '2160p', output_format: 'png', noise_scale: 0.25, seed: 42 });
  });
  it('preflights dimensions and premium price tiers', () => {
    expect(outputDimensions(4000, 3000, { ...defaultUpscaleConfig('fal-ai/topaz/upscale/image'), factor: 2 }).megapixels).toBe(48);
    expect(topazEstimateMicrounits(24)).toBe(80_000);
    expect(topazEstimateMicrounits(48)).toBe(160_000);
    expect(topazEstimateMicrounits(96)).toBe(320_000);
    expect(topazEstimateMicrounits(512)).toBe(1_360_000);
    expect(topazEstimateMicrounits(513)).toBeUndefined();
  });
  it('requires an explicit Topaz confirmation', () => {
    expect(validateUpscaleConfig(defaultUpscaleConfig('fal-ai/topaz/upscale/image'), 1024, 1024)).toContain('Bestätige den Premium-Lauf und die angezeigte Kostenstufe.');
  });
  it('accepts fractional Topaz factors only within the exact 1..4 schema', () => {
    const config = { ...defaultUpscaleConfig('fal-ai/topaz/upscale/image'), factor: 1.5, premiumConfirmed: true, cropToFill: true };
    expect(validateUpscaleConfig(config, 100, 100)).toEqual([]);
    expect(buildImageToolInput(config, 'https://example.test/a.png')).toMatchObject({ upscale_factor: 1.5, crop_to_fill: true });
    expect(validateUpscaleConfig({ ...config, factor: 4.1 }, 100, 100)).toContain('Topaz unterstützt Skalierungsfaktoren von 1 bis 4.');
  });
});
