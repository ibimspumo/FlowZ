import { listType, listValue } from '../../domain/values';
import { DefaultNodeIcon, DefaultNodeView, defineNodeModule } from '../../engine/node-module';

export type VideoCollectionConfig = { collectionResultIds: string[] };

export const videoCollectionModule = defineNodeModule({
  id: 'core.video-collection', version: 1, label: 'Videoauswahl', category: 'input', inputs: [],
  outputs: [{ id: 'videos', label: 'Videoliste', valueType: listType('video') }],
  defaultConfig: { collectionResultIds: [] as string[] }, View: DefaultNodeView, Icon: DefaultNodeIcon,
  validateConfig: (config): config is VideoCollectionConfig => Array.isArray(config.collectionResultIds)
    && config.collectionResultIds.length <= 200
    && config.collectionResultIds.every((id) => typeof id === 'string' && id.length > 0),
  async execute(node, context) {
    if (!context.services?.results) throw new Error('Der Ergebnisdienst ist nicht verfügbar.');
    if (!context.services.results.getVideo) throw new Error('Der Ergebnisdienst unterstützt keine Videos.');
    const videos = await Promise.all(node.config.collectionResultIds.map((id) => context.services!.results!.getVideo!(id)));
    return { outputs: { videos: listValue('video', videos.map((video) => ({ type: 'video', assetId: video.assetId, mimeType: video.mediaType }))) } };
  },
});
