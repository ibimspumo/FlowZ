import { describe, expect, it } from 'vitest';
import { buildFalImageInput, DEFAULT_FAL_IMAGE_MODEL, defaultFalImageConfig, falImageConfigFromValues, falImageEndpoint, falImageModel, falImageRequestConfig, falImageStreamingMode, FAL_IMAGE_MODELS, formatAspectRatioLabel, formatImageSizeLabel, normalizeFalImageConfig, selectFalImageModel, validateFalImageConfig } from './capabilities';

describe('curated fal image adapters', () => {
  it('defaults exclusively to the requested fal model', () => {
    expect(DEFAULT_FAL_IMAGE_MODEL).toBe('google/nano-banana-2-lite');
    expect(FAL_IMAGE_MODELS).toHaveLength(6);
    expect(FAL_IMAGE_MODELS.every((model) => !model.textEndpoint.includes('openrouter'))).toBe(true);
  });
  it('keeps Nano Banana Lite text-only', () => {
    const model = falImageModel(DEFAULT_FAL_IMAGE_MODEL)!;
    expect(falImageEndpoint(model, 1)).toBeUndefined();
    expect(validateFalImageConfig(model, defaultFalImageConfig(model), 1, 'Prompt')).toContain('Dieses Modell unterstützt keine Referenzbilder.');
  });
  it('activates valid endpoint defaults and makes hidden parameters from another model inert', () => {
    expect(selectFalImageModel('unknown')).toBeUndefined();
    const previous = {
      model: 'google/nano-banana-2-lite', resolution: '1K', aspectRatio: '1:1',
      outputFormat: 'webp', variants: 1, safetyTolerance: '6', thinkingLevel: 'high', imageEndpointConfigs: {},
    };
    const patch = selectFalImageModel('fal-ai/flux/schnell', previous)!;
    expect(patch).toMatchObject({ model: 'fal-ai/flux/schnell', resolution: 'square_hd', outputFormat: 'png', variants: 1, steps: 4, guidance: 3.5, acceleration: 'none', safetyChecker: false });
    const merged = { ...previous, ...patch };
    const model = falImageModel(String(merged.model))!;
    expect(validateFalImageConfig(model, falImageConfigFromValues(merged), 0, 'Prompt')).toEqual([]);
    expect(buildFalImageInput(model, falImageConfigFromValues(merged), 'Prompt', [])).not.toMatchObject({ safety_tolerance: expect.anything(), thinking_level: expect.anything() });
    expect(patch.imageEndpointConfigs).toMatchObject({
      'google/nano-banana-2-lite': { size: '1K', safetyTolerance: '6', thinkingLevel: 'high' },
      'fal-ai/flux/schnell': { size: 'square_hd', steps: 4, guidance: 3.5 },
    });
  });
  it('restores each model configuration and repairs invalid cached catalog values', () => {
    const flux = {
      model: 'fal-ai/flux/schnell', resolution: 'landscape_16_9', aspectRatio: 'auto', outputFormat: 'jpeg',
      variants: 2, steps: 2, guidance: 7, acceleration: 'high', safetyChecker: true, imageEndpointConfigs: {},
    };
    const nanoPatch = selectFalImageModel('google/nano-banana-2-lite', flux)!;
    const nano = { ...flux, ...nanoPatch, safetyTolerance: '6' };
    const restored = selectFalImageModel('fal-ai/flux/schnell', nano)!;
    expect(restored).toMatchObject({ resolution: 'landscape_16_9', outputFormat: 'jpeg', variants: 2, steps: 2, guidance: 7, acceleration: 'high', safetyChecker: true });
    const model = falImageModel('fal-ai/flux/schnell')!;
    expect(normalizeFalImageConfig(model, { size: '1K', steps: 99, guidance: -1, acceleration: 'turbo', safetyChecker: true })).toMatchObject({
      size: 'square_hd', steps: 4, guidance: 3.5, acceleration: 'none', safetyChecker: true,
    });
  });
  it('switches an editable model to its exact edit endpoint', () => {
    const model = falImageModel('fal-ai/nano-banana-pro')!;
    expect(falImageEndpoint(model, 2)).toBe('fal-ai/nano-banana-pro/edit');
    expect(buildFalImageInput(model, defaultFalImageConfig(model), 'Edit', ['a','b'])).toMatchObject({ image_urls: ['a','b'], prompt: 'Edit' });
  });
  it('sends Nano Banana Pro resolution and exact FLUX acceleration fields', () => {
    const banana = falImageModel('fal-ai/nano-banana-pro')!;
    expect(buildFalImageInput(banana, { ...defaultFalImageConfig(banana), size: '4K' }, 'Poster', [])).toMatchObject({ resolution: '4K' });
    const flux = falImageModel('fal-ai/flux/schnell')!;
    expect(buildFalImageInput(flux, { ...defaultFalImageConfig(flux), acceleration: 'high', safetyChecker: false }, 'Poster', [])).toMatchObject({ acceleration: 'high', enable_safety_checker: false });
  });
  it('only exposes masks on the two audited edit families', () => {
    const gpt = falImageModel('fal-ai/gpt-image-1.5')!;
    expect(validateFalImageConfig(gpt, defaultFalImageConfig(gpt), 1, 'Edit', 1)).toEqual([]);
    const banana = falImageModel('fal-ai/nano-banana-pro')!;
    expect(validateFalImageConfig(banana, defaultFalImageConfig(banana), 1, 'Edit', 1)).toContain('Dieses Modell unterstützt keine Maske.');
  });
  it('blocks fake transparency and requires PNG for GPT Image 1.5', () => {
    const gpt = falImageModel('fal-ai/gpt-image-1.5')!; const config = { ...defaultFalImageConfig(gpt), background: 'transparent', outputFormat: 'jpeg' };
    expect(validateFalImageConfig(gpt, config, 0, 'Logo')).toContain('Transparenz ist nur mit GPT Image 1.5 als PNG verfügbar.');
    const flux = falImageModel('fal-ai/flux/schnell')!;
    expect(buildFalImageInput(flux, { ...defaultFalImageConfig(flux), background: 'transparent' }, 'Logo', [])).not.toHaveProperty('background');
  });
  it('treats Flux Redux as promptless one-image variation', () => {
    const model = falImageModel('fal-ai/flux/schnell')!; const config = defaultFalImageConfig(model);
    expect(validateFalImageConfig(model, config, 1, 'Prompt')).toContain('FLUX Redux ist eine reine Bildvariation und akzeptiert keinen Text-Prompt.');
    expect(buildFalImageInput(model, config, '', ['url'])).not.toHaveProperty('prompt');
    const request = falImageRequestConfig(model, config, 1);
    expect(request).not.toHaveProperty('guidance');
    expect(Object.keys(request).sort()).toEqual(['acceleration','outputFormat','safetyChecker','seed','size','steps','variants'].sort());
  });
  it('uses readable provider option labels and the most permissive supported filter defaults', () => {
    expect(formatImageSizeLabel('landscape_16_9')).toBe('Querformat · 16:9');
    expect(formatImageSizeLabel('1536x1024')).toBe('1536 × 1024 · Querformat');
    expect(formatAspectRatioLabel('9:16')).toBe('9:16 · Hochformat');
    expect(defaultFalImageConfig(falImageModel('google/nano-banana-2-lite')!).safetyTolerance).toBe('6');
    expect(defaultFalImageConfig(falImageModel('fal-ai/flux/schnell')!).safetyChecker).toBe(false);
  });
  it('exposes honest status streaming only for exact audited endpoints', () => {
    const gpt = falImageModel('fal-ai/gpt-image-1.5')!;
    expect(falImageStreamingMode(gpt, gpt.textEndpoint)).toBe('status');
    expect(falImageStreamingMode(gpt, gpt.editEndpoint)).toBe('status');
    expect(defaultFalImageConfig(gpt).streamingEnabled).toBe(true);
    const flux = falImageModel('fal-ai/flux/schnell')!;
    expect(falImageStreamingMode(flux, flux.textEndpoint)).toBeUndefined();
    expect(defaultFalImageConfig(flux)).not.toHaveProperty('streamingEnabled');
  });
});
