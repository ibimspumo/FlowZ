import type { JsonValue } from './project';

const HASH = /^[a-f0-9]{64}$/;
const MIME = {
  video: new Set(['video/mp4', 'video/webm', 'video/quicktime']),
  audio: new Set(['audio/mp4', 'audio/webm', 'audio/wav', 'audio/flac', 'audio/mpeg', 'audio/ogg']),
} as const;
const CONFIG_KEYS = new Set(['blobHash', 'posterHash', 'mediaType', 'mediaMetadata', 'fileName']);
const META_KEYS = new Set(['kind', 'container', 'codecs', 'durationSeconds', 'width', 'height', 'fps', 'sampleRate', 'channels', 'playable', 'playbackWarning']);

function positive(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= max;
}

const PREVIEW_CODECS = new Set(['h264', 'hevc', 'vp8', 'vp9', 'av1', 'aac', 'opus', 'vorbis', 'mp3', 'flac', 'alac', 'pcm_u8', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le']);

export function inferMediaPlayable(container: string, codecs: readonly string[]): boolean {
  if (!codecs.length || codecs.some((codec) => !PREVIEW_CODECS.has(codec))) return false;
  return !container.includes('webm') || codecs.every((codec) => ['vp8', 'vp9', 'av1', 'opus', 'vorbis'].includes(codec));
}

/** Compatibility normalization for schema-v2/module-v1 media snapshots written
 * before preview capability became explicit. This is derived display metadata,
 * so workflow semantics and the module contract remain version 1. */
export function normalizeMediaNodeConfig(config: Record<string, JsonValue>, kind: 'video' | 'audio'): Record<string, JsonValue> {
  if (!Object.keys(config).length) return config;
  const raw = config.mediaMetadata;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.playable === 'boolean') return config;
  const metadata = raw as Record<string, JsonValue>;
  const container = typeof metadata.container === 'string' ? metadata.container : '';
  const codecs = Array.isArray(metadata.codecs) ? metadata.codecs.filter((codec): codec is string => typeof codec === 'string') : [];
  const playable = inferMediaPlayable(container, codecs);
  return {
    ...config,
    mediaMetadata: {
      ...metadata,
      playable,
      ...(!playable && metadata.playbackWarning === undefined
        ? { playbackWarning: `Älterer ${kind}-Import: Vorschau-Kompatibilität konnte nicht sicher bestätigt werden; das Original bleibt erhalten.` }
        : {}),
    },
  };
}

export function isMediaNodeConfig(config: Record<string, JsonValue>, kind: 'video' | 'audio'): boolean {
  const keys = Object.keys(config);
  if (!keys.length) return true;
  if (keys.some((key) => !CONFIG_KEYS.has(key))) return false;
  if (typeof config.blobHash !== 'string' || !HASH.test(config.blobHash)) return false;
  if (typeof config.mediaType !== 'string' || !MIME[kind].has(config.mediaType)) return false;
  if (typeof config.fileName !== 'string' || !config.fileName || config.fileName.length > 255 || /[/\\\r\n]/.test(config.fileName)) return false;
  if (kind === 'audio' && config.posterHash !== undefined) return false;
  if (config.posterHash !== undefined && (typeof config.posterHash !== 'string' || !HASH.test(config.posterHash))) return false;
  const metadata = config.mediaMetadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const item = metadata as Record<string, JsonValue>;
  if (Object.keys(item).some((key) => !META_KEYS.has(key)) || item.kind !== kind) return false;
  if (typeof item.container !== 'string' || !item.container || item.container.length > 120) return false;
  if (!Array.isArray(item.codecs) || !item.codecs.length || item.codecs.length > 16 || item.codecs.some((codec) => typeof codec !== 'string' || !codec || codec.length > 64)) return false;
  if (!positive(item.durationSeconds, 7 * 24 * 60 * 60) || typeof item.playable !== 'boolean') return false;
  if (item.playbackWarning !== undefined && (typeof item.playbackWarning !== 'string' || !item.playbackWarning || item.playbackWarning.length > 300)) return false;
  if (item.playable && item.playbackWarning !== undefined) return false;
  if (kind === 'video') {
    return positive(item.width, 32_768) && positive(item.height, 32_768) && item.width * item.height <= 134_217_728 && positive(item.fps, 1_000)
      && item.sampleRate === undefined && item.channels === undefined;
  }
  return positive(item.sampleRate, 768_000) && positive(item.channels, 64)
    && item.width === undefined && item.height === undefined && item.fps === undefined;
}

export function assertMediaNodeConfig(config: Record<string, JsonValue>, kind: 'video' | 'audio', path: string): void {
  if (!isMediaNodeConfig(config, kind)) throw new Error(`${path}: invalid ${kind} media-node config`);
}
