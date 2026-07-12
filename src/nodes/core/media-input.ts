import { scalarType } from '../../domain/values';
import { DefaultNodeIcon, DefaultNodeView, defineNodeModule } from '../../engine/node-module';
import type { JsonValue } from '../../domain';
import { isMediaNodeConfig } from '../../domain/media-config';

type MediaConfig = Record<string, JsonValue> & { blobHash?: string; mediaType?: string };
const validFor = (kind: 'video' | 'audio') => (config: Record<string, JsonValue>): config is MediaConfig => isMediaNodeConfig(config, kind);

function requireMedia(config: MediaConfig, kind: 'video' | 'audio') {
  if (!config.blobHash || !config.mediaType?.startsWith(`${kind}/`)) throw new Error(`Noch kein ${kind === 'video' ? 'Video' : 'Audio'} importiert.`);
  return { assetId: config.blobHash, mimeType: config.mediaType };
}

export const videoInputModule = defineNodeModule({
  id: 'core.video-input', version: 1, label: 'Video-Import', category: 'input', inputs: [],
  outputs: [{ id: 'video', label: 'Video', valueType: scalarType('video') }], defaultConfig: {},
  View: DefaultNodeView, Icon: DefaultNodeIcon, validateConfig: validFor('video'),
  async execute(node) { return { outputs: { video: { kind: 'scalar', value: { type: 'video', ...requireMedia(node.config, 'video') } } } }; },
});

export const audioInputModule = defineNodeModule({
  id: 'core.audio-input', version: 1, label: 'Audio-Import', category: 'input', inputs: [],
  outputs: [{ id: 'audio', label: 'Audio', valueType: scalarType('audio') }], defaultConfig: {},
  View: DefaultNodeView, Icon: DefaultNodeIcon, validateConfig: validFor('audio'),
  async execute(node) { return { outputs: { audio: { kind: 'scalar', value: { type: 'audio', ...requireMedia(node.config, 'audio') } } } }; },
});
