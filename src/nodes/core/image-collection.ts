import { listType, listValue } from '../../domain/values';
import { DefaultNodeIcon, DefaultNodeView, defineNodeModule } from '../../engine/node-module';

export type ImageCollectionConfig = { collectionResultIds: string[] };

export const imageCollectionModule = defineNodeModule({
  id: 'core.image-collection', version: 1, label: 'Bildauswahl', category: 'input', inputs: [],
  outputs: [{ id: 'images', label: 'Bildliste', valueType: listType('image') }],
  defaultConfig: { collectionResultIds: [] as string[] }, View: DefaultNodeView, Icon: DefaultNodeIcon,
  validateConfig: (config): config is ImageCollectionConfig => Array.isArray(config.collectionResultIds)
    && config.collectionResultIds.length <= 200
    && config.collectionResultIds.every((id) => typeof id === 'string' && id.length > 0),
  async execute(node, context) {
    if (!context.services?.results) throw new Error('Der Ergebnisdienst ist nicht verfügbar.');
    const images = await Promise.all(node.config.collectionResultIds.map((id) => context.services!.results!.getImage(id)));
    return { outputs: { images: listValue('image', images.map((image) => ({ type: 'image', assetId: image.assetId, mimeType: image.mediaType }))) } };
  },
});
