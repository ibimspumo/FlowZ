import { defineNodeRegistry } from '../../engine/registry';
import { transcriptionModule } from './transcription';

export { transcriptionModule };

export const aiNodeRegistry = defineNodeRegistry(transcriptionModule);
