import manifest from './fal-image-manifest.json';

export type FalImageModel = (typeof manifest.models)[number];
export type FalImageConfig = {
  size: string; aspectRatio: string; outputFormat: string; variants: number;
  seed?: number; quality?: string; background?: string; inputFidelity?: string;
  safetyTolerance?: string; thinkingLevel?: string; webSearch?: boolean;
  steps?: number; guidance?: number; acceleration?: string; safetyChecker?: boolean;
  streamingEnabled?: boolean;
};

export const FAL_IMAGE_MANIFEST = manifest;
export const FAL_IMAGE_MODELS = manifest.models;
export const DEFAULT_FAL_IMAGE_MODEL = manifest.defaultModel;

const values = (items: readonly string[]) => items;

const SIZE_LABELS: Record<string, string> = {
  auto: 'Automatisch', auto_1K: 'Automatisch · bis 1K', auto_2K: 'Automatisch · bis 2K',
  square_hd: 'Quadratisch · HD', square: 'Quadratisch', portrait_4_3: 'Hochformat · 3:4',
  portrait_16_9: 'Hochformat · 9:16', landscape_4_3: 'Querformat · 4:3', landscape_16_9: 'Querformat · 16:9',
};

export function formatImageSizeLabel(value: string): string {
  if (SIZE_LABELS[value]) return SIZE_LABELS[value];
  const pixels = /^(\d+)x(\d+)$/.exec(value);
  if (pixels) {
    const [width, height] = pixels.slice(1).map(Number);
    const orientation = width === height ? 'Quadratisch' : width > height ? 'Querformat' : 'Hochformat';
    return `${width} × ${height} · ${orientation}`;
  }
  return value;
}

export function formatAspectRatioLabel(value: string, automatic = 'Automatisch'): string {
  if (value === 'auto') return automatic;
  const [width, height] = value.split(':').map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return value;
  return `${value} · ${width === height ? 'Quadratisch' : width > height ? 'Querformat' : 'Hochformat'}`;
}

export function falImageModel(id: string): FalImageModel | undefined {
  return FAL_IMAGE_MODELS.find((model) => model.id === id);
}

export function defaultFalImageConfig(model: FalImageModel): FalImageConfig {
  return {
    size: model.sizes[0],
    aspectRatio: values(model.aspectRatios).includes('1:1') ? '1:1' : model.aspectRatios[0] ?? 'auto',
    outputFormat: 'png', variants: 1,
    ...(model.quality.length ? { quality: values(model.quality).includes('high') ? 'high' : model.quality[0] } : {}),
    ...(model.background.length ? { background: 'auto' } : {}),
    ...(model.inputFidelity.length ? { inputFidelity: 'low' } : {}),
    ...(model.safetyTolerance.length ? { safetyTolerance: [...model.safetyTolerance].sort((left, right) => Number(right) - Number(left))[0] } : {}),
    ...(model.steps ? { steps: 4 } : {}), ...(model.guidance ? { guidance: 3.5 } : {}),
    ...('acceleration' in model && model.acceleration ? { acceleration: 'none' } : {}),
    ...('safetyChecker' in model && model.safetyChecker ? { safetyChecker: false } : {}),
    ...(model.streaming ? { streamingEnabled: true } : {}),
  };
}

function endpointConfigsFromValues(value: unknown): Record<string, Partial<FalImageConfig>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, config]) => config && typeof config === 'object' && !Array.isArray(config))) as Record<string, Partial<FalImageConfig>>;
}

/** Keep only values supported by one exact endpoint and repair stale catalog
 * values with that endpoint's audited defaults. */
export function normalizeFalImageConfig(model: FalImageModel, candidate: Partial<FalImageConfig> = {}): FalImageConfig {
  const defaults = defaultFalImageConfig(model);
  const supported = <T extends string>(items: readonly T[], value: unknown, fallback: T): T =>
    typeof value === 'string' && items.includes(value as T) ? value as T : fallback;
  const integer = (value: unknown, min: number, max: number, fallback: number): number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
  return {
    size: supported(model.sizes, candidate.size, defaults.size),
    aspectRatio: model.aspectRatios.length
      ? supported(model.aspectRatios, candidate.aspectRatio, defaults.aspectRatio)
      : defaults.aspectRatio,
    outputFormat: supported(model.formats, candidate.outputFormat, defaults.outputFormat),
    variants: integer(candidate.variants, 1, model.variantMax, defaults.variants),
    ...(model.seed && typeof candidate.seed === 'number' && Number.isSafeInteger(candidate.seed) && candidate.seed >= 0 ? { seed: candidate.seed } : {}),
    ...(model.quality.length ? { quality: supported(model.quality, candidate.quality, defaults.quality!) } : {}),
    ...(model.background.length ? { background: supported(model.background, candidate.background, defaults.background!) } : {}),
    ...(model.inputFidelity.length ? { inputFidelity: supported(model.inputFidelity, candidate.inputFidelity, defaults.inputFidelity!) } : {}),
    ...(model.safetyTolerance.length ? { safetyTolerance: supported(model.safetyTolerance, candidate.safetyTolerance, defaults.safetyTolerance!) } : {}),
    ...(model.thinkingLevels.length && typeof candidate.thinkingLevel === 'string' && values(model.thinkingLevels).includes(candidate.thinkingLevel) ? { thinkingLevel: candidate.thinkingLevel } : {}),
    ...(model.webSearch ? { webSearch: typeof candidate.webSearch === 'boolean' ? candidate.webSearch : false } : {}),
    ...('steps' in model && model.steps ? { steps: integer(candidate.steps, model.steps.min, model.steps.max, defaults.steps!) } : {}),
    ...('guidance' in model && model.guidance && typeof candidate.guidance === 'number' && Number.isFinite(candidate.guidance) && candidate.guidance >= model.guidance.min && candidate.guidance <= model.guidance.max
      ? { guidance: candidate.guidance }
      : 'guidance' in model && model.guidance ? { guidance: defaults.guidance } : {}),
    ...('acceleration' in model && Array.isArray(model.acceleration) ? { acceleration: supported(model.acceleration, candidate.acceleration, defaults.acceleration!) } : {}),
    ...('safetyChecker' in model && model.safetyChecker ? { safetyChecker: typeof candidate.safetyChecker === 'boolean' ? candidate.safetyChecker : defaults.safetyChecker } : {}),
    ...(model.streaming ? { streamingEnabled: typeof candidate.streamingEnabled === 'boolean' ? candidate.streamingEnabled : defaults.streamingEnabled } : {}),
  };
}

export function falImageConfigPatch(config: FalImageConfig): Record<string, string | number | boolean> {
  return {
    resolution: config.size,
    aspectRatio: config.aspectRatio,
    outputFormat: config.outputFormat,
    variants: config.variants,
    ...(config.seed == null ? {} : { seed: config.seed }),
    ...(config.quality == null ? {} : { quality: config.quality }),
    ...(config.background == null ? {} : { background: config.background }),
    ...(config.inputFidelity == null ? {} : { inputFidelity: config.inputFidelity }),
    ...(config.safetyTolerance == null ? {} : { safetyTolerance: config.safetyTolerance }),
    ...(config.thinkingLevel == null ? {} : { thinkingLevel: config.thinkingLevel }),
    ...(config.webSearch == null ? {} : { webSearch: config.webSearch }),
    ...(config.steps == null ? {} : { steps: config.steps }),
    ...(config.guidance == null ? {} : { guidance: config.guidance }),
    ...(config.acceleration == null ? {} : { acceleration: config.acceleration }),
    ...(config.safetyChecker == null ? {} : { safetyChecker: config.safetyChecker }),
    ...(config.streamingEnabled == null ? {} : { streamingEnabled: config.streamingEnabled }),
  };
}

/** Save the current endpoint configuration and activate a valid configuration
 * for the selected model. Returning to a model restores its last valid values. */
export function selectFalImageModel(id: string, current: Record<string, unknown> = {}): Record<string, unknown> | undefined {
  const target = falImageModel(id);
  if (!target) return undefined;
  const endpointConfigs = endpointConfigsFromValues(current.imageEndpointConfigs);
  const currentModel = falImageModel(String(current.model ?? ''));
  if (currentModel) endpointConfigs[currentModel.id] = normalizeFalImageConfig(currentModel, falImageConfigFromValues(current));
  const targetConfig = normalizeFalImageConfig(target, endpointConfigs[target.id]);
  endpointConfigs[target.id] = targetConfig;
  return { model: id, ...falImageConfigPatch(targetConfig), imageEndpointConfigs: endpointConfigs };
}

export function falImageConfigFromValues(config:Record<string,unknown>):FalImageConfig{
  return {size:String(config.resolution),aspectRatio:String(config.aspectRatio),outputFormat:String(config.outputFormat),variants:Number(config.variants),
    ...(config.seed==null?{}:{seed:Number(config.seed)}),...(typeof config.quality==="string"?{quality:config.quality}:{}),...(typeof config.background==="string"?{background:config.background}:{}),
    ...(typeof config.inputFidelity==="string"?{inputFidelity:config.inputFidelity}:{}),...(typeof config.safetyTolerance==="string"?{safetyTolerance:config.safetyTolerance}:{}),
    ...(typeof config.thinkingLevel==="string"?{thinkingLevel:config.thinkingLevel}:{}),...(typeof config.webSearch==="boolean"?{webSearch:config.webSearch}:{}),
    ...(typeof config.steps==="number"?{steps:config.steps}:{}),...(typeof config.guidance==="number"?{guidance:config.guidance}:{}),
    ...(typeof config.acceleration==="string"?{acceleration:config.acceleration}:{}),...(typeof config.safetyChecker==="boolean"?{safetyChecker:config.safetyChecker}:{}),
    ...(typeof config.streamingEnabled==="boolean"?{streamingEnabled:config.streamingEnabled}:{}),
  };
}

export function falImageEndpoint(model: FalImageModel, referenceCount: number, maskCount = 0): string | undefined {
  return referenceCount || maskCount ? model.editEndpoint ?? undefined : model.textEndpoint;
}

export function falImageStreamingMode(model: FalImageModel, endpoint: string | null | undefined): 'status' | undefined {
  if (!endpoint || !model.streaming || model.streamingMode !== 'status') return undefined;
  return model.streamingEndpoints.some((candidate) => candidate === endpoint) ? 'status' : undefined;
}

/** Produces only fields accepted by the exact selected fal endpoint. */
export function falImageRequestConfig(model: FalImageModel, config: FalImageConfig, referenceCount: number): Partial<FalImageConfig> {
  const output = { outputFormat: config.outputFormat, variants: config.variants };
  if (model.id === 'google/nano-banana-2-lite') return { ...output, aspectRatio: config.aspectRatio, seed: config.seed, safetyTolerance: config.safetyTolerance, thinkingLevel: config.thinkingLevel };
  if (model.id === 'fal-ai/nano-banana-pro') return { ...output, size: config.size, aspectRatio: config.aspectRatio, seed: config.seed, safetyTolerance: config.safetyTolerance, webSearch: config.webSearch };
  if (model.id === 'openai/gpt-image-2') return { ...output, size: config.size, quality: config.quality };
  if (model.id === 'fal-ai/gpt-image-1.5') return { ...output, size: config.size, quality: config.quality, background: config.background, ...(referenceCount ? { inputFidelity: config.inputFidelity } : {}) };
  if (model.id === 'fal-ai/flux/schnell') return { ...output, size: config.size, seed: config.seed, steps: config.steps, ...(!referenceCount ? { guidance: config.guidance } : {}), acceleration: config.acceleration, safetyChecker: config.safetyChecker };
  return { ...output, size: config.size, safetyTolerance: config.safetyTolerance };
}

export function validateFalImageConfig(model: FalImageModel | undefined, config: FalImageConfig, referenceCount: number, prompt: string, maskCount = 0): string[] {
  if (!model) return ['Dieses Bildmodell besitzt keinen geprüften fal.ai-Adapter.'];
  const errors: string[] = [];
  if (referenceCount && !model.editEndpoint) errors.push('Dieses Modell unterstützt keine Referenzbilder.');
  if (model.references.max != null && referenceCount > model.references.max) errors.push(`Dieses Modell unterstützt höchstens ${model.references.max} Referenzbilder.`);
  if (maskCount > 1 || (maskCount && !('supportsMask' in model && model.supportsMask))) errors.push('Dieses Modell unterstützt keine Maske.');
  if (maskCount && !referenceCount) errors.push('Eine Maske benötigt mindestens ein Referenzbild.');
  if (referenceCount < model.references.min) errors.push(`Dieses Modell benötigt mindestens ${model.references.min} Referenzbild(er).`);
  if (!prompt.trim() && !(referenceCount && 'reduxNoPrompt' in model && model.reduxNoPrompt)) errors.push('Ein Text-Prompt wird benötigt.');
  if (referenceCount && 'reduxNoPrompt' in model && model.reduxNoPrompt && prompt.trim()) errors.push('FLUX Redux ist eine reine Bildvariation und akzeptiert keinen Text-Prompt.');
  if (!values(model.sizes).includes(config.size)) errors.push('Die Bildgröße wird von diesem Endpoint nicht unterstützt.');
  if (model.aspectRatios.length && !values(model.aspectRatios).includes(config.aspectRatio)) errors.push('Das Seitenverhältnis wird von diesem Endpoint nicht unterstützt.');
  if (!values(model.formats).includes(config.outputFormat)) errors.push('Das Ausgabeformat wird von diesem Endpoint nicht unterstützt.');
  if (!Number.isInteger(config.variants) || config.variants < 1 || config.variants > model.variantMax) errors.push(`Dieser Endpoint unterstützt 1 bis ${model.variantMax} Varianten.`);
  if (model.seed && config.seed != null && (!Number.isSafeInteger(config.seed) || config.seed < 0)) errors.push('Der Seed ist ungültig.');
  if (model.quality.length && config.quality && !values(model.quality).includes(config.quality)) errors.push('Diese Qualitätsstufe wird nicht unterstützt.');
  if (model.background.length && config.background && !values(model.background).includes(config.background)) errors.push('Dieser Hintergrundmodus wird nicht unterstützt.');
  if (referenceCount && model.inputFidelity.length && config.inputFidelity && !values(model.inputFidelity).includes(config.inputFidelity)) errors.push('Input Fidelity wird von diesem Edit-Endpoint nicht unterstützt.');
  if (model.safetyTolerance.length && config.safetyTolerance && !values(model.safetyTolerance).includes(config.safetyTolerance)) errors.push('Diese Safety-Stufe wird nicht unterstützt.');
  if (model.thinkingLevels.length && config.thinkingLevel && !values(model.thinkingLevels).includes(config.thinkingLevel)) errors.push('Dieses Modell unterstützt diesen Thinking-Modus nicht.');
  if (model.background.some((value) => value === 'transparent') && config.background === 'transparent' && config.outputFormat !== 'png') errors.push('Transparenz ist nur mit GPT Image 1.5 als PNG verfügbar.');
  if ('steps' in model && model.steps && (config.steps == null || config.steps < model.steps.min || config.steps > model.steps.max)) errors.push('Die Schrittzahl liegt außerhalb des unterstützten Bereichs.');
  if ('guidance' in model && model.guidance && (config.guidance == null || config.guidance < model.guidance.min || config.guidance > model.guidance.max)) errors.push('Guidance liegt außerhalb des unterstützten Bereichs.');
  if ('acceleration' in model && Array.isArray(model.acceleration) && config.acceleration && !values(model.acceleration).includes(config.acceleration)) errors.push('Diese Beschleunigungsstufe wird nicht unterstützt.');
  return errors;
}

export function buildFalImageInput(model: FalImageModel, config: FalImageConfig, prompt: string, urls: string[]): Record<string, unknown> {
  const edit = urls.length > 0;
  const input: Record<string, unknown> = {};
  if (!(edit && 'reduxNoPrompt' in model && model.reduxNoPrompt)) input.prompt = prompt;
  if (model.id === 'google/nano-banana-2-lite' || model.id === 'fal-ai/nano-banana-pro') {
    input.aspect_ratio = config.aspectRatio; input.output_format = config.outputFormat; input.num_images = config.variants;
    if (model.id === 'fal-ai/nano-banana-pro') input.resolution = config.size;
  } else {
    input.image_size = config.size; input.output_format = config.outputFormat; input.num_images = config.variants;
  }
  if (edit) {
    if ('reduxNoPrompt' in model && model.reduxNoPrompt) input.image_url = urls[0];
    else input.image_urls = urls;
  }
  if (model.seed && config.seed != null) input.seed = config.seed;
  if (model.quality.length && config.quality) input.quality = config.quality;
  if (model.background.length && config.background) input.background = config.background;
  if (edit && model.inputFidelity.length && config.inputFidelity) input.input_fidelity = config.inputFidelity;
  if (model.safetyTolerance.length && config.safetyTolerance) input.safety_tolerance = config.safetyTolerance;
  if (model.thinkingLevels.length && config.thinkingLevel) input.thinking_level = config.thinkingLevel;
  if (config.webSearch != null && model.webSearch) input.enable_web_search = config.webSearch;
  if (config.steps != null && 'steps' in model) input.num_inference_steps = config.steps;
  if (config.guidance != null && 'guidance' in model) input.guidance_scale = config.guidance;
  if (config.acceleration != null && 'acceleration' in model) input.acceleration = config.acceleration;
  if (config.safetyChecker != null && 'safetyChecker' in model) input.enable_safety_checker = config.safetyChecker;
  return input;
}
