export type FalVideoMode = 'text-to-video' | 'image-to-video' | 'reference-to-video';

export type FalVideoCapabilities = {
  endpoint: string;
  family: string;
  familyLabel: string;
  label: string;
  mode: FalVideoMode;
  durations: readonly (number | 'auto')[];
  resolutions: readonly string[];
  aspectRatios: readonly string[];
  audio: boolean;
  seed: boolean;
  bitrateModes: readonly ('standard' | 'high')[];
  startFrame: 'none' | 'required' | 'optional';
  endFrame: boolean;
  references: { max: number; semantics: 'flat' | 'none' };
  schemaHash: string;
};

/**
 * Audited, fail-closed endpoint adapters. The fal category catalog is deliberately
 * not exposed directly: many entries require structured inputs that FlowZ cannot
 * truthfully represent with its stable ports.
 */
export const FAL_VIDEO_ENDPOINTS = [
  {
    endpoint: 'bytedance/seedance-2.0/fast/text-to-video',
    family: 'bytedance/seedance-2.0/fast', familyLabel: 'Seedance 2.0 Fast',
    label: 'Seedance 2.0 Fast · Text zu Video', mode: 'text-to-video',
    durations: ['auto', 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const, resolutions: ['480p', '720p'] as const,
    aspectRatios: ['auto', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] as const,
    audio: true, seed: false, bitrateModes: ['standard', 'high'] as const, startFrame: 'none', endFrame: false,
    references: { max: 0, semantics: 'none' }, schemaHash: 'seedance-2-fast-t2v-2026-07',
  },
  {
    endpoint: 'bytedance/seedance-2.0/fast/image-to-video',
    family: 'bytedance/seedance-2.0/fast', familyLabel: 'Seedance 2.0 Fast',
    label: 'Seedance 2.0 Fast · Bild zu Video', mode: 'image-to-video',
    durations: ['auto', 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const, resolutions: ['480p', '720p'] as const,
    aspectRatios: ['auto', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] as const,
    audio: true, seed: false, bitrateModes: ['standard', 'high'] as const, startFrame: 'required', endFrame: true,
    references: { max: 0, semantics: 'none' }, schemaHash: 'seedance-2-fast-i2v-2026-07',
  },
  {
    endpoint: 'bytedance/seedance-2.0/fast/reference-to-video',
    family: 'bytedance/seedance-2.0/fast', familyLabel: 'Seedance 2.0 Fast',
    label: 'Seedance 2.0 Fast · Referenzen zu Video', mode: 'reference-to-video',
    durations: ['auto', 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const, resolutions: ['480p', '720p'] as const,
    aspectRatios: ['auto', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] as const,
    audio: true, seed: false, bitrateModes: ['standard', 'high'] as const, startFrame: 'none', endFrame: false,
    references: { max: 9, semantics: 'flat' }, schemaHash: 'seedance-2-fast-r2v-2026-07',
  },
] satisfies readonly FalVideoCapabilities[];

export const FAL_VIDEO_FAMILIES = Array.from(new Map(FAL_VIDEO_ENDPOINTS.map((item) => [item.family, { id: item.family, label: item.familyLabel }])).values());

export type FalVideoEndpoint = typeof FAL_VIDEO_ENDPOINTS[number]['endpoint'];

export type FalVideoEndpointConfig = {
  duration: number | 'auto'; resolution: string; aspectRatio: string;
  generateAudio: boolean; bitrateMode: 'standard' | 'high'; seed?: number;
};

export function falVideoCapability(endpoint: string): FalVideoCapabilities | undefined {
  return FAL_VIDEO_ENDPOINTS.find((item) => item.endpoint === endpoint);
}

export function falVideoFamily(endpointOrFamily: string): string | undefined {
  return FAL_VIDEO_ENDPOINTS.find((item) => item.endpoint === endpointOrFamily || item.family === endpointOrFamily)?.family;
}

/** Selects the exact audited endpoint from semantic, already-connected ports. */
export function inferFalVideoEndpoint(family: string, occupied: FalVideoPortOccupancy): { endpoint?: FalVideoCapabilities; error?: string } {
  const candidates = FAL_VIDEO_ENDPOINTS.filter((item) => item.family === family);
  if (!candidates.length) return { error: 'Diese Videomodell-Familie besitzt keinen geprüften FlowZ-Adapter.' };
  if (occupied.references > 0 && (occupied.startFrame > 0 || occupied.endFrame > 0)) {
    return { error: 'Diese Modellfamilie kann Referenzbilder nicht gleichzeitig mit Start- oder Endbild verwenden.' };
  }
  const mode: FalVideoMode = occupied.references > 0 ? 'reference-to-video' : occupied.startFrame > 0 || occupied.endFrame > 0 ? 'image-to-video' : 'text-to-video';
  const endpoint = candidates.find((item) => item.mode === mode);
  return endpoint ? { endpoint } : { error: `Diese Modellfamilie unterstützt ${mode === 'text-to-video' ? 'Text zu Video' : mode === 'image-to-video' ? 'Start-/Endbild zu Video' : 'Referenzbilder zu Video'} nicht.` };
}

export function defaultFalVideoConfig(capability: FalVideoCapabilities): FalVideoEndpointConfig {
  return {
    duration: capability.durations[0], resolution: capability.resolutions[0],
    aspectRatio: capability.aspectRatios.includes('16:9') ? '16:9' : capability.aspectRatios[0],
    generateAudio: capability.audio, bitrateMode: capability.bitrateModes[0],
  };
}

export type FalVideoPortOccupancy = { startFrame: number; endFrame: number; references: number };

export function validateFalVideoConfig(capability: FalVideoCapabilities | undefined, config: FalVideoEndpointConfig, occupied: FalVideoPortOccupancy): string[] {
  if (!capability) return ['Dieser fal.ai-Endpoint besitzt keinen geprüften FlowZ-Adapter.'];
  const errors: string[] = [];
  if (!capability.durations.includes(config.duration)) errors.push('Die Dauer wird von diesem Endpoint nicht unterstützt.');
  if (!capability.resolutions.includes(config.resolution)) errors.push('Die Auflösung wird von diesem Endpoint nicht unterstützt.');
  if (!capability.aspectRatios.includes(config.aspectRatio)) errors.push('Das Seitenverhältnis wird von diesem Endpoint nicht unterstützt.');
  if (config.generateAudio && !capability.audio) errors.push('Dieser Endpoint erzeugt keinen Ton.');
  if (!capability.bitrateModes.includes(config.bitrateMode)) errors.push('Dieser Bitratenmodus wird nicht unterstützt.');
  if (config.seed != null && (!capability.seed || !Number.isSafeInteger(config.seed) || config.seed < 0)) errors.push('Der Seed ist für diesen Endpoint ungültig.');
  if (capability.startFrame === 'required' && occupied.startFrame !== 1) errors.push('Dieser Endpoint benötigt genau ein Startbild.');
  if (capability.startFrame === 'none' && occupied.startFrame) errors.push('Der gewählte Endpoint unterstützt kein Startbild.');
  if (!capability.endFrame && occupied.endFrame) errors.push('Der gewählte Endpoint unterstützt kein Endbild.');
  if (occupied.references > capability.references.max) errors.push(`Dieser Endpoint unterstützt höchstens ${capability.references.max} Referenzbilder.`);
  return errors;
}

export function buildFalVideoInput(capability: FalVideoCapabilities, prompt: string, config: FalVideoEndpointConfig, urls: { startFrame?: string; endFrame?: string; references: string[] }) {
  const input: Record<string, unknown> = {
    prompt, duration: config.duration, resolution: config.resolution,
    aspect_ratio: config.aspectRatio, generate_audio: config.generateAudio,
    bitrate_mode: config.bitrateMode,
  };
  if (config.seed != null) input.seed = config.seed;
  if (capability.startFrame !== 'none' && urls.startFrame) input.image_url = urls.startFrame;
  if (capability.endFrame && urls.endFrame) input.end_image_url = urls.endFrame;
  if (capability.references.max && urls.references.length) input.image_urls = urls.references;
  return input;
}
