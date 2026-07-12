import type { JsonValue } from "../../domain/project";
import { defineConcreteAppNodeModule, lazyModuleBody } from "../concrete-app-module";
import { exactConfig, field } from "../config-schema";
import { nodeSpecifications as spec } from "../module-specifications";
import { audioInputModule, videoInputModule } from "./media-input";
import { imageCollectionModule } from "./image-collection";
import { videoCollectionModule } from "./video-collection";
const TextInputBody=lazyModuleBody(()=>import("../extracted-node-views").then((m)=>({default:m.TextInputBody})));
const ImageInputBody=lazyModuleBody(()=>import("../extracted-node-views").then((m)=>({default:m.ImageInputBody})));
const VideoInputBody=lazyModuleBody(()=>import("../extracted-node-views").then((m)=>({default:m.VideoInputBody})));
const AudioInputBody=lazyModuleBody(()=>import("../extracted-node-views").then((m)=>({default:m.AudioInputBody})));
const ImageCollectionBody=lazyModuleBody(()=>import("../extracted-node-views").then((m)=>({default:m.ImageCollectionBody})));
const VideoCollectionBody=lazyModuleBody(()=>import("../extracted-node-views").then((m)=>({default:m.VideoCollectionBody})));

type TextConfig = { value: string } | { text: string };
const validText = (config: Record<string, JsonValue>): config is TextConfig => exactConfig({ value: { validate: field.string() } })(config) || exactConfig({ text: { validate: field.string() } })(config);
export const textInputAppModule = defineConcreteAppNodeModule("textInput", spec.textInput, {
  validateConfig: validText,
  Body: TextInputBody,
  execute: async (node) => ({ outputs: { text: { kind: "scalar", value: { type: "text", value: String("text" in node.config ? node.config.text : node.config.value) } } } }),
});

type ImageInputConfig = { assetId?: string; fileName?: string };
const validImageInput = exactConfig({ assetId: { validate: field.nonEmptyString(256), optional: true }, fileName: { validate: field.nonEmptyString(255), optional: true } });
export const imageInputAppModule = defineConcreteAppNodeModule("imageInput", spec.imageInput, {
  validateConfig: (config): config is ImageInputConfig => validImageInput(config) && (config.assetId === undefined) === (config.fileName === undefined),
  Body: ImageInputBody,
  execute: async (node, context) => {
    const media = node.config.assetId ? { assetId: node.config.assetId } : await context.services?.mediaInputs?.get(node.id, "image", context.signal);
    if (!media?.assetId) throw new Error("Noch kein Bild importiert.");
    const payload = node.config.assetId ? await context.services?.assets?.get(node.config.assetId) : undefined;
    return { outputs: { image: { kind: "scalar", value: { type: "image", assetId: media.assetId, mimeType: media.mediaType ?? payload?.mediaType } } }, ...(payload?.dataUrl ? { metadata: { dataUrl: payload.dataUrl } } : {}) };
  },
});

export const videoInputAppModule = defineConcreteAppNodeModule("videoInput", spec.videoInput, {
  validateConfig: (config): config is typeof videoInputModule.defaultConfig => Boolean(videoInputModule.validateConfig?.(config)),
  Body: VideoInputBody,
  execute: async (node, context) => {
    if (Object.keys(node.config).length) return videoInputModule.execute(node, context);
    const media=await context.services?.mediaInputs?.get(node.id,"video",context.signal);if(!media)throw new Error("Noch kein Video importiert.");
    return {outputs:{video:{kind:"scalar",value:{type:"video",assetId:media.assetId,mimeType:media.mediaType}},...(media.startFrameAssetId?{startFrame:{kind:"scalar" as const,value:{type:"image" as const,assetId:media.startFrameAssetId}}}:{}),...(media.endFrameAssetId?{endFrame:{kind:"scalar" as const,value:{type:"image" as const,assetId:media.endFrameAssetId}}}:{})}};
  },
});
export const audioInputAppModule = defineConcreteAppNodeModule("audioInput", spec.audioInput, {
  validateConfig: (config): config is typeof audioInputModule.defaultConfig => Boolean(audioInputModule.validateConfig?.(config)),
  Body: AudioInputBody,
  execute: async (node, context) => {
    if (Object.keys(node.config).length) return audioInputModule.execute(node, context);
    const media=await context.services?.mediaInputs?.get(node.id,"audio",context.signal);if(!media)throw new Error("Noch kein Audio importiert.");
    return {outputs:{audio:{kind:"scalar",value:{type:"audio",assetId:media.assetId,mimeType:media.mediaType}}}};
  },
});

type CollectionConfig = { collectionResultIds?: string[] };
const validCollection = exactConfig({ collectionResultIds: { validate: field.strings(200), optional: true } });
export const imageCollectionAppModule = defineConcreteAppNodeModule("imageCollection", spec.imageCollection, {
  validateConfig: (config): config is CollectionConfig => validCollection(config),
  Body: ImageCollectionBody,
  execute: async (node, context) => imageCollectionModule.execute({ ...node, config: { collectionResultIds: node.config.collectionResultIds ?? [] } }, context),
});
export const videoCollectionAppModule = defineConcreteAppNodeModule("videoCollection", spec.videoCollection, {
  validateConfig: (config): config is CollectionConfig => validCollection(config),
  Body: VideoCollectionBody,
  execute: async (node, context) => videoCollectionModule.execute({ ...node, config: { collectionResultIds: node.config.collectionResultIds ?? [] } }, context),
});

export const coreAppNodeModules = [textInputAppModule, imageInputAppModule, videoInputAppModule, audioInputAppModule, imageCollectionAppModule, videoCollectionAppModule] as const;
