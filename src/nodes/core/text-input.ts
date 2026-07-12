import { scalarType } from '../../domain/values';
import { DefaultNodeIcon, DefaultNodeView, defineNodeModule } from '../../engine/node-module';

export const textInputModule = defineNodeModule({
  id: 'core.text-input',
  version: 1,
  label: 'Text-Eingabe',
  category: 'input',
  inputs: [],
  outputs: [{ id: 'text', label: 'Text', valueType: scalarType('text') }],
  defaultConfig: { text: '' },
  View: DefaultNodeView,
  Icon: DefaultNodeIcon,
  validateConfig: (config): config is { text: string } => typeof config.text === 'string',
  async execute(node) {
    return { outputs: { text: { kind: 'scalar', value: { type: 'text', value: node.config.text } } } };
  },
});
