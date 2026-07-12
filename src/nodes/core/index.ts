import { defineNodeRegistry } from '../../engine/registry';
import { textInputModule } from './text-input';
import { audioInputModule, videoInputModule } from './media-input';
import { imageCollectionModule } from './image-collection';
import { videoCollectionModule } from './video-collection';

export { audioInputModule, imageCollectionModule, textInputModule, videoCollectionModule, videoInputModule };

/** Built-in registry; literal ids are retained and checked by TypeScript. */
export const coreNodeRegistry = defineNodeRegistry(textInputModule, videoInputModule, audioInputModule, imageCollectionModule, videoCollectionModule);
