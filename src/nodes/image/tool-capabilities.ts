import manifest from './fal-image-tools-manifest.json';

export type FalImageTool = (typeof manifest.tools)[number];
export type UpscaleConfig = {
  endpoint: string;
  upscaleMode: 'factor' | 'target';
  factor: number;
  targetResolution: '720p' | '1080p' | '1440p' | '2160p';
  outputFormat: 'png' | 'jpg' | 'jpeg' | 'webp';
  seed?: number;
  noise: number;
  topazModel: string;
  faceEnhancement: boolean;
  subjectDetection: 'All' | 'Foreground' | 'Background';
  faceEnhancementCreativity: number;
  faceEnhancementStrength: number;
  sharpen: number;
  denoise: number;
  fixCompression: number;
  strength: number;
  creativity: number;
  texture: number;
  redefinePrompt: string;
  autoprompt: boolean;
  detail: number;
  enhancementStrength?: 'low' | 'medium' | 'high';
  premiumConfirmed: boolean;
  cropToFill: boolean;
};

export const FAL_IMAGE_TOOLS = manifest.tools;
export const UPSCALE_TOOLS = manifest.tools.filter((tool) => tool.kind === 'upscale');
export const DEFAULT_UPSCALE_TOOL = 'fal-ai/seedvr/upscale/image';
export const BACKGROUND_REMOVAL_TOOL = 'fal-ai/bria/background/remove';

export function falImageTool(id: string): FalImageTool | undefined {
  return FAL_IMAGE_TOOLS.find((tool) => tool.id === id);
}

export function defaultUpscaleConfig(endpoint = DEFAULT_UPSCALE_TOOL): UpscaleConfig {
  return {
    endpoint, upscaleMode: 'factor', factor: endpoint.includes('/topaz/') ? 1 : 2,
    targetResolution: '1080p', outputFormat: 'png', noise: 0.1,
    topazModel: 'Standard V2', faceEnhancement: false, subjectDetection: 'All',
    faceEnhancementCreativity: 0, faceEnhancementStrength: 0.8,
    sharpen: 0, denoise: 0, fixCompression: 0, strength: 0.5,
    creativity: 1, texture: 1, redefinePrompt: '', autoprompt: true, detail: 0.5,
    premiumConfirmed: false, cropToFill: false,
  };
}

export function outputDimensions(width: number, height: number, config: UpscaleConfig): { width: number; height: number; megapixels: number } {
  const ratio = width / height;
  const outputHeight = config.upscaleMode === 'target' ? Number.parseInt(config.targetResolution, 10) : Math.round(height * config.factor);
  const outputWidth = config.upscaleMode === 'target' ? Math.round(outputHeight * ratio) : Math.round(width * config.factor);
  return { width: outputWidth, height: outputHeight, megapixels: outputWidth * outputHeight / 1_000_000 };
}

export function topazEstimateMicrounits(megapixels: number): number | undefined {
  if (!Number.isFinite(megapixels) || megapixels <= 0 || megapixels > 512) return undefined;
  if (megapixels <= 24) return 80_000;
  if (megapixels <= 48) return 160_000;
  if (megapixels <= 96) return 320_000;
  return Math.min(1_360_000, 320_000 + Math.ceil((megapixels - 96) / 32) * 80_000);
}

export function validateUpscaleConfig(config: UpscaleConfig, width?: number, height?: number): string[] {
  const tool = falImageTool(config.endpoint);
  if (!tool || tool.kind !== 'upscale') return ['Dieser Upscale-Adapter ist nicht geprüft.'];
  const errors: string[] = [];
  if (!tool.formats.includes(config.outputFormat as never)) errors.push('Dieses Ausgabeformat wird vom Endpoint nicht unterstützt.');
  if (config.endpoint.includes('/topaz/')) {
    if (!Number.isFinite(config.factor) || config.factor < 1 || config.factor > 4) errors.push('Topaz unterstützt Skalierungsfaktoren von 1 bis 4.');
  } else {
    const factors = 'factors' in tool && Array.isArray(tool.factors) ? tool.factors as readonly number[] : [];
    if (!factors.includes(config.factor)) errors.push('Dieser Skalierungsfaktor wird nicht unterstützt.');
  }
  if (config.endpoint === DEFAULT_UPSCALE_TOOL) {
    const targets = 'targets' in tool && Array.isArray(tool.targets) ? tool.targets as readonly string[] : [];
    if (config.upscaleMode === 'target' && !targets.includes(config.targetResolution)) errors.push('Diese Zielauflösung wird nicht unterstützt.');
    if (!Number.isFinite(config.noise) || config.noise < 0 || config.noise > 1) errors.push('Rauschunterdrückung muss zwischen 0 und 1 liegen.');
    if (config.seed != null && (!Number.isSafeInteger(config.seed) || config.seed < 0)) errors.push('Der Seed ist ungültig.');
  }
  if (config.endpoint.includes('/topaz/')) {
    if (!config.premiumConfirmed) errors.push('Bestätige den Premium-Lauf und die angezeigte Kostenstufe.');
    const models = 'models' in tool && Array.isArray(tool.models) ? tool.models as readonly string[] : [];
    if (!models.includes(config.topazModel)) errors.push('Dieses Topaz-Modell wird nicht unterstützt.');
    if (width && height) {
      const result = outputDimensions(width, height, config);
      if (result.megapixels > 512) errors.push('Topaz-Ausgaben über 512 MP sind gesperrt.');
    }
  }
  return errors;
}

export function buildImageToolInput(config: UpscaleConfig, imageUrl: string): Record<string, unknown> {
  if (config.endpoint === DEFAULT_UPSCALE_TOOL) return {
    image_url: imageUrl,
    upscale_mode: config.upscaleMode,
    ...(config.upscaleMode === 'factor' ? { upscale_factor: config.factor } : { target_resolution: config.targetResolution }),
    output_format: config.outputFormat,
    noise_scale: config.noise,
    ...(config.seed == null ? {} : { seed: config.seed }),
  };
  return {
    image_url: imageUrl, upscale_factor: config.factor, crop_to_fill: config.cropToFill, model: config.topazModel,
    output_format: config.outputFormat,
    ...(['Standard V2', 'Recovery V2'].includes(config.topazModel) ? { subject_detection: config.subjectDetection } : {}),
    ...(['Standard V2', 'Recovery V2'].includes(config.topazModel) ? { face_enhancement: config.faceEnhancement } : {}),
    ...(config.faceEnhancement && ['Standard V2', 'Recovery V2'].includes(config.topazModel) ? { face_enhancement_creativity: config.faceEnhancementCreativity, face_enhancement_strength: config.faceEnhancementStrength } : {}),
    ...(['Standard V2', 'Low Resolution V2', 'CGI', 'High Fidelity V2', 'Text Refine', 'Redefine'].includes(config.topazModel) ? { sharpen: config.sharpen, denoise: config.denoise } : {}),
    ...(['Standard V2', 'Low Resolution V2', 'High Fidelity V2', 'Text Refine'].includes(config.topazModel) ? { fix_compression: config.fixCompression } : {}),
    ...(config.topazModel === 'Text Refine' ? { strength: config.strength } : {}),
    ...(config.topazModel === 'Redefine' ? { creativity: config.creativity, texture: config.texture, prompt: config.redefinePrompt, autoprompt: config.autoprompt } : {}),
    ...(config.topazModel === 'Recovery V2' ? { detail: config.detail } : {}),
    ...(config.topazModel === 'Wonder 3' && config.enhancementStrength ? { enhancement_strength: config.enhancementStrength } : {}),
  };
}
