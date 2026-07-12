import { scalarType } from '../../domain/values';
import { DefaultNodeIcon, DefaultNodeView, defineNodeModule } from '../../engine/node-module';

type AssetReferenceConfig = { libraryAssetId: string; assetVersionId: string; assetVersion: number; assetName: string; assetKind: 'prompt' | 'text' | 'image' };
const defaults: AssetReferenceConfig = { libraryAssetId: '', assetVersionId: '', assetVersion: 1, assetName: 'Asset', assetKind: 'text' };
const valid = (config: Record<string, import('../../domain/project').JsonValue>): config is AssetReferenceConfig =>
  typeof config.libraryAssetId === 'string' && typeof config.assetVersionId === 'string' && typeof config.assetName === 'string' && typeof config.assetVersion === 'number' && typeof config.assetKind === 'string' && ['prompt', 'text', 'image'].includes(config.assetKind);

export const assetTextModule = defineNodeModule({
  id: 'library.asset-text', version: 1, label: 'Text-Asset', category: 'input', inputs: [],
  outputs: [{ id: 'text', label: 'Text', valueType: scalarType('text') }], defaultConfig: defaults,
  View: DefaultNodeView, Icon: DefaultNodeIcon,
  validateConfig: valid,
  async execute(node, context) {
    const payload = await context.services?.assets?.get(node.config.assetVersionId);
    if (!payload?.text) throw new Error('Die gebundene Asset-Version enthält keinen Text.');
    return { outputs: { text: { kind: 'scalar', value: { type: 'text', value: payload.text } } } };
  },
});

export const assetImageModule = defineNodeModule({
  id: 'library.asset-image', version: 1, label: 'Bild-Asset', category: 'input', inputs: [],
  outputs: [{ id: 'image', label: 'Bild', valueType: scalarType('image') }], defaultConfig: { ...defaults, assetKind: 'image' as const },
  View: DefaultNodeView, Icon: DefaultNodeIcon,
  validateConfig: valid,
  async execute(node, context) {
    const payload = await context.services?.assets?.get(node.config.assetVersionId);
    if (!payload?.dataUrl) throw new Error('Die gebundene Asset-Version enthält kein Bild.');
    return { outputs: { image: { kind: 'scalar', value: { type: 'image', assetId: node.config.libraryAssetId, mimeType: payload.mediaType } } }, metadata: { dataUrl: payload.dataUrl } };
  },
});
