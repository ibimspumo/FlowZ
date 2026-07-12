import { scalarType } from '../../domain/values';
import { DefaultNodeIcon, DefaultNodeView, defineNodeModule } from '../../engine/node-module';
import type { JsonValue } from '../../domain';

type TranscriptionConfig = Record<string, JsonValue> & {
  model: string;
  language: string;
  timestamps: boolean;
};

function validateConfig(config: Record<string, JsonValue>): config is TranscriptionConfig {
  return typeof config.model === 'string' && config.model.length > 0 && config.model.length <= 200
    && typeof config.language === 'string'
    && (config.language === 'auto' || /^[a-z]{2}$/.test(config.language))
    && typeof config.timestamps === 'boolean';
}

export const transcriptionModule = defineNodeModule({
  id: 'ai.transcription',
  version: 1,
  label: 'Transkription',
  category: 'model',
  inputs: [{ id: 'audio', label: 'Audio', valueType: scalarType('audio') }],
  outputs: [{ id: 'text', label: 'Text', valueType: scalarType('text') }],
  defaultConfig: { model: 'openai/whisper-1', language: 'auto', timestamps: false },
  View: DefaultNodeView,
  Icon: DefaultNodeIcon,
  validateConfig,
  async execute() {
    throw new Error('Transkription wird über den sicheren Desktop-Adapter ausgeführt.');
  },
});
