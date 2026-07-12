import { lazyModuleBody } from "../concrete-app-module";
import type { JsonValue } from "../../domain/project";
import { defineConcreteAppNodeModule } from "../concrete-app-module";
import { exactConfig, field, optionalExportSchema } from "../config-schema";
import type { RuntimeValue, ScalarValue } from "../../domain/values";
import { nodeSpecifications as spec } from "../module-specifications";
import {
  falImageEndpoint,
  falImageConfigFromValues,
  falImageModel,
  falImageRequestConfig,
  falImageStreamingMode,
  validateFalImageConfig,
  type FalImageConfig,
} from "./capabilities";
import {
  BACKGROUND_REMOVAL_TOOL,
  falImageTool,
  topazEstimateMicrounits,
  validateUpscaleConfig,
  type UpscaleConfig,
} from "./tool-capabilities";
import { directImageInputs, imageResult, textInputs } from "../fal-runtime";
import { estimateFalImageCost, falImageCostContext, resolveFalCostEstimate } from "../fal-pricing";
import { directMediaBindingFromConfig, directMediaConfigField, resolveDirectMediaInputs } from "../direct-media";
const FalImageGenerationBody = lazyModuleBody(() =>
  import("./views").then((m) => ({ default: m.FalImageGenerationBody })),
);
const FalImageUpscaleBody = lazyModuleBody(() =>
  import("./views").then((m) => ({ default: m.FalImageUpscaleBody })),
);
const FalBackgroundRemovalBody = lazyModuleBody(() =>
  import("./views").then((m) => ({ default: m.FalBackgroundRemovalBody })),
);
const ImageTransformBody = lazyModuleBody(() =>
  import("../extracted-node-views").then((m) => ({
    default: m.ImageTransformBody,
  })),
);
const ImageTrimTransparentBody = lazyModuleBody(() =>
  import("../extracted-node-views").then((m) => ({
    default: m.ImageTrimTransparentBody,
  })),
);

const jsonObject = (value: JsonValue) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
type ImageGenerationConfig = typeof spec.imageGeneration.defaults &
  Record<string, JsonValue>;
const imageGenerationSchema = exactConfig({
  model: { validate: field.nonEmptyString(200) },
  prompt: { validate: field.string(20_000) },
  aspectRatio: { validate: field.nonEmptyString(32) },
  resolution: { validate: field.nonEmptyString(64) },
  outputFormat: { validate: field.enum(["png", "jpeg", "webp"]) },
  variants: { validate: field.integer(1, 6) },
  safetyTolerance: { validate: field.enum(["1", "2", "3", "4", "5", "6"]) },
  imageEndpointConfigs: { validate: jsonObject },
  seed: { validate: field.integer(0, Number.MAX_SAFE_INTEGER), optional: true },
  quality: { validate: field.string(32), optional: true },
  background: { validate: field.string(32), optional: true },
  inputFidelity: { validate: field.string(32), optional: true },
  thinkingLevel: { validate: field.string(32), optional: true },
  webSearch: { validate: field.boolean(), optional: true },
  steps: { validate: field.integer(1, 100), optional: true },
  guidance: { validate: field.number(0, 100), optional: true },
  acceleration: { validate: field.string(32), optional: true },
  safetyChecker: { validate: field.boolean(), optional: true },
  streamingEnabled: { validate: field.boolean(), optional: true },
  listProcessingMode: {
    validate: field.enum(["map", "aggregate"]),
    optional: true,
  },
  directMedia: { validate: directMediaConfigField, optional: true },
  ...optionalExportSchema,
});
function imageConfig(config: Record<string, JsonValue>): FalImageConfig {
  return falImageConfigFromValues(config);
}
export const imageGenerationAppModule = defineConcreteAppNodeModule(
  "imageGeneration",
  spec.imageGeneration,
  {
    validateConfig: (config): config is ImageGenerationConfig =>
      imageGenerationSchema(config) &&
      Boolean(falImageModel(String(config.model))),
    Body: FalImageGenerationBody,
    execute: async (node, context) => {
      const service = context.services?.fal;
      if (!service)
        throw new Error("Der fal.ai-Bilddienst ist nicht verfügbar.");
      const model = falImageModel(String(node.config.model));
      if (!model)
        throw new Error(
          "Dieses Bildmodell besitzt keinen geprüften fal.ai-Adapter.",
        );
      const references = directImageInputs(
          context,
          node.config,
          "reference",
          "referenceLists",
        ).values,
        masks = directImageInputs(context, {}, "mask").values;
      const prompt = [
        ...textInputs(context, "prompt"),
        String(node.config.prompt),
      ]
        .filter(Boolean)
        .join("\n\n");
      const config = imageConfig(node.config),
        errors = validateFalImageConfig(
          model,
          config,
          references.length,
          prompt,
          masks.length,
        );
      if (errors.length) throw new Error(errors.join(" "));
      const endpoint = falImageEndpoint(model, references.length, masks.length);
      if (!endpoint)
        throw new Error(
          "Für diese Eingänge existiert kein geprüfter fal.ai-Endpoint.",
        );
      const officialCostEstimate=estimateFalImageCost({model,endpoint,config,referenceCount:references.length,maskCount:masks.length,prompt});
      const costContext=falImageCostContext({model,endpoint,config,referenceCount:references.length,maskCount:masks.length});
      const costEstimate=await resolveFalCostEstimate(officialCostEstimate,endpoint,model.schemaHash,costContext);
      const result = await service.image({
        runId: crypto.randomUUID(),
        nodeId: node.id,
        modelId: model.id,
        endpoint,
        schemaHash: model.schemaHash,
        prompt,
        references,
        mask: masks[0],
        config: falImageRequestConfig(
          model,
          config,
          references.length,
        ) as Record<string, unknown>,
        costEstimate:costEstimate.state!=="unavailable"?costEstimate.snapshot:undefined,
        costContext,
        streaming: Boolean(
          config.streamingEnabled && falImageStreamingMode(model, endpoint),
        ),
        signal: context.signal,
      });
      if (result.contractError) throw new Error(result.contractError);
      return imageResult(result.images, {
        runId: result.runId,
        costMicrounits: result.costMicrounits ?? 0,
        costProvenance: result.costProvenance,
        targetCurrent: result.targetCurrent,
        results: result.images as unknown as JsonValue,
      });
    },
  },
);

type UpscaleNodeConfig = typeof spec.imageUpscale.defaults &
  Record<string, JsonValue>;
const upscaleSchema = exactConfig({
  model: { validate: field.nonEmptyString(200) },
  upscaleMode: { validate: field.enum(["factor", "target"]) },
  factor: { validate: field.number(1, 4) },
  targetResolution: {
    validate: field.enum(["720p", "1080p", "1440p", "2160p"]),
  },
  outputFormat: { validate: field.enum(["png", "jpg", "jpeg", "webp"]) },
  noise: { validate: field.number(0, 1) },
  topazModel: { validate: field.nonEmptyString(100) },
  faceEnhancement: { validate: field.boolean() },
  subjectDetection: {
    validate: field.enum(["All", "Foreground", "Background"]),
  },
  faceEnhancementCreativity: { validate: field.number(0, 1) },
  faceEnhancementStrength: { validate: field.number(0, 1) },
  sharpen: { validate: field.number(0, 1) },
  denoise: { validate: field.number(0, 1) },
  fixCompression: { validate: field.number(0, 1) },
  strength: { validate: field.number(0, 1) },
  creativity: { validate: field.number(0, 10) },
  texture: { validate: field.number(0, 10) },
  redefinePrompt: { validate: field.string(10_000) },
  autoprompt: { validate: field.boolean() },
  detail: { validate: field.number(0, 1) },
  premiumConfirmed: { validate: field.boolean() },
  cropToFill: { validate: field.boolean() },
  seed: { validate: field.integer(0, Number.MAX_SAFE_INTEGER), optional: true },
  enhancementStrength: {
    validate: field.enum(["low", "medium", "high"]),
    optional: true,
  },
  directMedia: { validate: directMediaConfigField, optional: true },
  ...optionalExportSchema,
});
function upscaleConfig(config: Record<string, JsonValue>): UpscaleConfig {
  return {
    ...(config as unknown as UpscaleConfig),
    endpoint: String(config.model),
  };
}
export const imageUpscaleAppModule = defineConcreteAppNodeModule(
  "imageUpscale",
  spec.imageUpscale,
  {
    validateConfig: (config): config is UpscaleNodeConfig =>
      upscaleSchema(config) && Boolean(falImageTool(String(config.model))),
    Body: FalImageUpscaleBody,
    execute: async (node, context) => {
      const service = context.services?.fal;
      if (!service)
        throw new Error("Der fal.ai-Bilddienst ist nicht verfügbar.");
      const sources = directImageInputs(context, node.config, "image").values;
      if (sources.length !== 1) throw new Error("Verbinde genau ein Bild.");
      const config = upscaleConfig(node.config),
        errors = validateUpscaleConfig(config);
      if (errors.length) throw new Error(errors.join(" "));
      const tool = falImageTool(config.endpoint);
      if (!tool || tool.kind !== "upscale")
        throw new Error("Dieser Upscale-Adapter ist nicht geprüft.");
      const estimate = config.endpoint.includes("/topaz/")
        ? topazEstimateMicrounits(24)
        : config.endpoint.includes("seedvr")
          ? 50_000
          : undefined;
      const result = await service.imageTool({
        runId: crypto.randomUUID(),
        nodeId: node.id,
        endpoint: config.endpoint,
        schemaHash: tool.schemaHash,
        source: sources[0],
        config: config as unknown as Record<string, unknown>,
        estimatedCostMicrounits: estimate,
        signal: context.signal,
      });
      if (result.contractError) throw new Error(result.contractError);
      return imageResult([result], {
        runId: result.runId,
        resultId: result.resultId,
        blobHash: result.blobHash,
        costMicrounits: result.costMicrounits ?? 0,
        costProvenance: result.costProvenance,
        targetCurrent: result.targetCurrent,
      });
    },
  },
);
type TransformConfig = typeof spec.imageTransform.defaults &
  Record<string, JsonValue>;
const transformSchema = exactConfig({
  transformMode: { validate: field.enum(["fit", "fill", "free"]) },
  transformAspect: {
    validate: field.enum([
      "original",
      "1:1",
      "16:9",
      "9:16",
      "4:3",
      "3:4",
      "custom",
    ]),
  },
  targetWidth: { validate: field.integer(1, 64_000_000) },
  targetHeight: { validate: field.integer(1, 64_000_000) },
  dimensionLock: { validate: field.boolean() },
  noUpscale: { validate: field.boolean() },
  outputFormat: { validate: field.enum(["png", "jpeg", "webp"]) },
  transformQuality: { validate: field.integer(1, 100) },
  transformBackground: {
    validate: (value) =>
      typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value),
  },
  cropX: { validate: field.number(0, 1) },
  cropY: { validate: field.number(0, 1) },
  cropWidth: { validate: field.number(Number.EPSILON, 1) },
  cropHeight: { validate: field.number(Number.EPSILON, 1) },
  listProcessingMode: { validate: field.enum(["map"]) },
  directMedia: { validate: directMediaConfigField, optional: true },
  ...optionalExportSchema,
});
function sourceValues(
  inputs: Readonly<Record<string, readonly RuntimeValue[]>>,
  config: Record<string, JsonValue>,
) {
  const scalar = inputs.image ?? [];
  const lists = inputs.imageLists ?? [];
  const binding = directMediaBindingFromConfig(config);
  if (scalar.length && lists.length && binding?.priority !== "override")
    throw new Error(
      "Verbinde entweder ein einzelnes Bild oder eine Bildliste, nicht beides gleichzeitig.",
    );
  const value = lists[0] ?? scalar[0];
  const connected = !value ? [] : value.kind === "scalar" ? [value.value] : value.items;
  const resolution = resolveDirectMediaInputs(connected.map((item) => {
    if (item.type !== "image") throw new Error("Bildquelle hat den falschen Typ.");
    return item.assetId.startsWith("flowz-cas:") ? item.assetId : `flowz-cas:${item.assetId}`;
  }), binding);
  if (!resolution.values.length)
    throw new Error(
      "Verbinde ein vollständig lokal gespeichertes Bild oder hinterlege eine direkte Bildreferenz.",
    );
  return resolution.values.map((item) => ({ type: "image" as const, assetId: item.replace(/^flowz-cas:/, "") }));
}
async function mapImages(
  context: import("../../engine/node-module").NodeExecutionContext,
  config: Record<string, JsonValue>,
  execute: (source: ScalarValue, signal: AbortSignal) => Promise<ScalarValue>,
) {
  context.signal.throwIfAborted();
  const sources = sourceValues(context.inputs, config);
  const service = context.services?.listMap;
  if (!service)
    throw new Error("Der Listen-Mapping-Dienst ist nicht verfügbar.");
  const mapped = await service.execute({
    mode: "map",
    inputs: { items: [{ kind: "list", itemType: "image", items: sources }] },
    outputTypes: { image: "image" },
    signal: context.signal,
    concurrency: 2,
    execute: async (inputs, item) => {
      const source = inputs.items?.[0];
      if (!source || source.kind !== "scalar")
        throw new Error("Bildquelle fehlt.");
      return { outputs: { image: await execute(source.value, item.signal) } };
    },
  });
  context.signal.throwIfAborted();
  const images = mapped.outputs.image;
  if (!images || images.kind !== "list" || !images.items.length)
    throw new Error("Kein Bild wurde verarbeitet.");
  return {
    outputs: {
      image: { kind: "scalar" as const, value: images.items[0] },
      images,
    },
    metadata: {
      state: mapped.state,
      processed: images.items.length,
      failed: mapped.failures.length,
    },
  };
}
export const imageTransformAppModule = defineConcreteAppNodeModule("imageTransform",
  spec.imageTransform,
  {
    validateConfig: (config): config is TransformConfig =>
      transformSchema(config) &&
      Number(config.targetWidth) * Number(config.targetHeight) <= 64_000_000 &&
      Number(config.cropX) + Number(config.cropWidth) <= 1.000001 &&
      Number(config.cropY) + Number(config.cropHeight) <= 1.000001,
    Body: ImageTransformBody,
    execute: async (node, context) => {
      const service = context.services?.imageOperations;
      if (!service)
        throw new Error("Der lokale Bilddienst ist nicht verfügbar.");
      const recipe = {
        mode: node.config.transformMode,
        targetWidth: node.config.targetWidth,
        targetHeight: node.config.targetHeight,
        noUpscale: node.config.noUpscale,
        outputFormat: node.config.outputFormat,
        quality: node.config.transformQuality,
        background: node.config.transformBackground,
        cropX: node.config.cropX,
        cropY: node.config.cropY,
        cropWidth: node.config.cropWidth,
        cropHeight: node.config.cropHeight,
      } as Record<string, JsonValue>;
      return mapImages(context, node.config, async (source, signal) => {
        if (source.type !== "image")
          throw new Error("Bildquelle hat den falschen Typ.");
        signal.throwIfAborted();
        const result = await service.transform({
          nodeId: node.id,
          sourceAssetId: source.assetId,
          recipe,
          signal,
        });
        signal.throwIfAborted();
        return {
          type: "image",
          assetId: result.assetId,
          mimeType: result.mediaType,
        };
      });
    },
  },
);

type TrimConfig = typeof spec.imageTrimTransparent.defaults &
  Record<string, JsonValue>;
const trimSchema = exactConfig({
  trimPadding: { validate: field.integer(0, 64) },
  trimThreshold: { validate: field.integer(0, 254) },
  listProcessingMode: { validate: field.enum(["map"]) },
  directMedia: { validate: directMediaConfigField, optional: true },
  ...optionalExportSchema,
});
export const imageTrimTransparentAppModule = defineConcreteAppNodeModule("imageTrimTransparent",
  spec.imageTrimTransparent,
  {
    validateConfig: (config): config is TrimConfig => trimSchema(config),
    Body: ImageTrimTransparentBody,
    execute: async (node, context) => {
      const service = context.services?.imageOperations;
      if (!service)
        throw new Error("Der lokale Bilddienst ist nicht verfügbar.");
      return mapImages(context, node.config, async (source, signal) => {
        if (source.type !== "image")
          throw new Error("Bildquelle hat den falschen Typ.");
        signal.throwIfAborted();
        const result = await service.trimTransparent({
          nodeId: node.id,
          sourceAssetId: source.assetId,
          padding: Number(node.config.trimPadding),
          threshold: Number(node.config.trimThreshold),
          signal,
        });
        signal.throwIfAborted();
        return {
          type: "image",
          assetId: result.assetId,
          mimeType: result.mediaType,
        };
      });
    },
  },
);
type BackgroundConfig = typeof spec.backgroundRemoval.defaults &
  Record<string, JsonValue>;
const backgroundSchema = exactConfig({
  model: { validate: (value) => value === BACKGROUND_REMOVAL_TOOL },
  directMedia: { validate: directMediaConfigField, optional: true },
  ...optionalExportSchema,
});
export const backgroundRemovalAppModule = defineConcreteAppNodeModule(
  "backgroundRemoval",
  spec.backgroundRemoval,
  {
    validateConfig: (config): config is BackgroundConfig =>
      backgroundSchema(config),
    Body: FalBackgroundRemovalBody,
    execute: async (node, context) => {
      const service = context.services?.fal;
      if (!service)
        throw new Error("Der fal.ai-Bilddienst ist nicht verfügbar.");
      const sources = directImageInputs(context, node.config, "image").values;
      if (sources.length !== 1) throw new Error("Verbinde genau ein Bild.");
      const tool = falImageTool(BACKGROUND_REMOVAL_TOOL);
      if (!tool || tool.kind !== "background-removal")
        throw new Error("Der Bria-Adapter ist nicht verfügbar.");
      const result = await service.imageTool({
        runId: crypto.randomUUID(),
        nodeId: node.id,
        endpoint: tool.id,
        schemaHash: tool.schemaHash,
        source: sources[0],
        config: {},
        estimatedCostMicrounits: 18_000,
        signal: context.signal,
      });
      if (result.contractError) throw new Error(result.contractError);
      return imageResult([result], {
        runId: result.runId,
        resultId: result.resultId,
        blobHash: result.blobHash,
        costMicrounits: result.costMicrounits ?? 0,
        costProvenance: result.costProvenance,
        targetCurrent: result.targetCurrent,
      });
    },
  },
);

export const imageAppNodeModules = [
  imageGenerationAppModule,
  imageUpscaleAppModule,
  imageTransformAppModule,
  imageTrimTransparentAppModule,
  backgroundRemovalAppModule,
] as const;
