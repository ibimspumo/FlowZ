import { defineNodeRegistry } from '../../engine/registry';
import { researchModule } from './research';
import { webpageModule } from './webpage';
import { assetImageModule, assetTextModule } from './asset-reference';

export { assetImageModule, assetTextModule, researchModule, webpageModule };

export const contextNodeRegistry = defineNodeRegistry(webpageModule, researchModule, assetTextModule, assetImageModule);
