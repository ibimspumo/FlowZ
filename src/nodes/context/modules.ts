import type { JsonValue } from "../../domain/project";
import { defineConcreteAppNodeModule, lazyModuleBody } from "../concrete-app-module";
import { exactConfig, field, optionalExportSchema } from "../config-schema";
import { nodeSpecifications as spec } from "../module-specifications";
import { assetImageModule, assetTextModule } from "./asset-reference";
import { webpageModule } from "./webpage";
import { researchModule } from "./research";
const AssetTextBody=lazyModuleBody(()=>import("../extracted-node-views").then((m)=>({default:m.AssetTextBody})));
const AssetImageBody=lazyModuleBody(()=>import("../extracted-node-views").then((m)=>({default:m.AssetImageBody})));
const WebpageBody=lazyModuleBody(()=>import("../extracted-node-views").then((m)=>({default:m.WebpageBody})));
const ResearchBody=lazyModuleBody(()=>import("../extracted-node-views").then((m)=>({default:m.ResearchBody})));
const VideoFrameBody=lazyModuleBody(()=>import("../extracted-node-views").then((m)=>({default:m.VideoFrameBody})));

type AssetConfig = typeof assetTextModule.defaultConfig;
const assetSchema = exactConfig({
  libraryAssetId: { validate: field.string(256) }, assetVersionId: { validate: field.string(256) }, assetVersion: { validate: field.integer(1, Number.MAX_SAFE_INTEGER) },
  assetName: { validate: field.string(255) }, assetKind: { validate: field.enum(["prompt", "text", "image"]) },
});
export const assetTextAppModule = defineConcreteAppNodeModule("assetText", spec.assetText, { validateConfig: (config): config is AssetConfig => assetSchema(config) && config.assetKind !== "image", execute: assetTextModule.execute, Body: AssetTextBody });
export const assetImageAppModule = defineConcreteAppNodeModule("assetImage", spec.assetImage, { validateConfig: (config): config is AssetConfig => assetSchema(config) && config.assetKind === "image", execute: assetImageModule.execute, Body: AssetImageBody });

type WebpageConfig = typeof webpageModule.defaultConfig & Record<string, JsonValue>;
const webpageSchema = exactConfig({ url: { validate: field.string(8_000) }, includeScreenshot: { validate: field.boolean() }, ...optionalExportSchema });
export const webpageAppModule = defineConcreteAppNodeModule("webpage", spec.webpage, { validateConfig: (config): config is WebpageConfig => webpageSchema(config), execute: webpageModule.execute, Body: WebpageBody });

type ResearchConfig = typeof researchModule.defaultConfig & Record<string, JsonValue>;
const researchSchema = exactConfig({ query: { validate: field.string(8_000) }, resultCount: { validate: field.integer(1, 20) }, freshness: { validate: field.enum(["all", "day", "week", "month", "year"]) }, ...optionalExportSchema });
export const researchAppModule = defineConcreteAppNodeModule("research", spec.research, { validateConfig: (config): config is ResearchConfig => researchSchema(config), execute: researchModule.execute, Body: ResearchBody });

type VideoFrameConfig = { frameMode: "first" | "last" | "seconds" | "percent"; frameValue: number } & Record<string, JsonValue>;
const videoFrameSchema = exactConfig({ frameMode: { validate: field.enum(["first", "last", "seconds", "percent"]) }, frameValue: { validate: field.number(0, 604_800) }, ...optionalExportSchema });
export const videoFrameAppModule = defineConcreteAppNodeModule("videoFrame", spec.videoFrame, {
  validateConfig: (config): config is VideoFrameConfig => videoFrameSchema(config) && (config.frameMode !== "percent" || Number(config.frameValue) <= 100),
  Body: VideoFrameBody,
  execute: async (node, context) => {
    const service = context.services?.videoFrame; if (!service) throw new Error("Der lokale Frame-Dienst ist nicht verfügbar.");
    const input = context.inputs.video?.find((value) => value.kind === "scalar" && value.value.type === "video");
    if (!input || input.kind !== "scalar" || input.value.type !== "video") throw new Error("Verbinde ein vollständig gespeichertes Video.");
    const result = await service.extract({ nodeId: node.id, videoAssetId: input.value.assetId, mode: node.config.frameMode, value: Number(node.config.frameValue), signal: context.signal });
    return { outputs: { image: { kind: "scalar", value: { type: "image", assetId: result.assetId, mimeType: result.mediaType } } }, metadata: { width: result.width ?? 0, height: result.height ?? 0, frameMode: node.config.frameMode, frameValue: node.config.frameValue } };
  },
});

export const contextAppNodeModules = [assetTextAppModule, assetImageAppModule, webpageAppModule, researchAppModule, videoFrameAppModule] as const;
