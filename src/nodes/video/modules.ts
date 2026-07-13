import type { JsonValue } from "../../domain/project";
import {
  defineConcreteAppNodeModule,
  lazyModuleBody,
} from "../concrete-app-module";
import { exactConfig, field, optionalExportSchema } from "../config-schema";
import { imageResult, mediaInputs, textInputs } from "../fal-runtime";
import { nodeSpecifications as spec } from "../module-specifications";
import {
  type FalVideoEndpointConfig,
  falVideoFamily,
  inferFalVideoEndpoint,
  validateFalVideoConfig,
} from "./capabilities";
import { estimateFalVideoCost, falVideoCostContext, resolveFalCostEstimate } from "../fal-pricing";

const FalVideoGenerationBody = lazyModuleBody(() =>
  import("./views").then((module) => ({
    default: module.FalVideoGenerationBody,
  })),
);
const jsonObject = (value: JsonValue) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
type VideoConfig = typeof spec.videoGeneration.defaults &
  Record<string, JsonValue>;
const videoSchema = exactConfig({
  model: { validate: field.nonEmptyString(200) },
  prompt: { validate: field.string(20_000) },
  duration: {
    validate: (value) =>
      value === "auto" ||
      (typeof value === "number" &&
        Number.isInteger(value) &&
        value >= 1 &&
        value <= 120),
  },
  resolution: { validate: field.nonEmptyString(32) },
  aspectRatio: { validate: field.nonEmptyString(32) },
  generateAudio: { validate: field.boolean() },
  bitrateMode: { validate: field.enum(["standard", "high"]) },
  variantCount: { validate: field.integer(1, 4) },
  listProcessingMode: { validate: field.enum(["map", "aggregate"]) },
  endpointConfigs: { validate: jsonObject },
  seed: { validate: field.integer(0, Number.MAX_SAFE_INTEGER), optional: true },
  fanOutResultIds: { validate: field.strings(100), optional: true },
  ...optionalExportSchema,
});

export const videoGenerationAppModule = defineConcreteAppNodeModule(
  "videoGeneration",
  spec.videoGeneration,
  {
    validateConfig: (config): config is VideoConfig =>
      videoSchema(config) && Boolean(falVideoFamily(String(config.model))),
    Body: FalVideoGenerationBody,
    execute: async (node, context) => {
      const service = context.services?.fal;
      if (!service)
        throw new Error("Der fal.ai-Videodienst ist nicht verfügbar.");
      const start = mediaInputs(context, "image", "startFrame"),
        end = mediaInputs(context, "image", "endFrame"),
        references = mediaInputs(
          context,
          "image",
          "references",
          "referenceLists",
        );
      const family = falVideoFamily(String(node.config.model));
      if (!family)
        throw new Error(
          "Diese Videomodell-Familie besitzt keinen geprüften Adapter.",
        );
      const inferred = inferFalVideoEndpoint(family, {
        startFrame: start.length,
        endFrame: end.length,
        references: references.length,
      });
      if (!inferred.endpoint)
        throw new Error(inferred.error ?? "Kein passender Video-Endpoint.");
      const config: FalVideoEndpointConfig = {
        duration: node.config.duration ?? "auto",
        resolution: String(node.config.resolution),
        aspectRatio: String(node.config.aspectRatio),
        generateAudio: Boolean(node.config.generateAudio),
        bitrateMode: node.config.bitrateMode ?? "standard",
        ...(node.config.seed == null ? {} : { seed: Number(node.config.seed) }),
      };
      const errors = validateFalVideoConfig(inferred.endpoint, config, {
        startFrame: start.length,
        endFrame: end.length,
        references: references.length,
      });
      if (errors.length) throw new Error(errors.join(" "));
      const prompt = [
        ...textInputs(context, "prompt"),
        String(node.config.prompt),
      ]
        .filter(Boolean)
        .join("\n\n");
      if (!prompt.trim()) throw new Error("Ein Text-Prompt wird benötigt.");
      const officialCostEstimate = estimateFalVideoCost({
        capability: inferred.endpoint,
        config,
        occupancy: {
          startFrame: start.length,
          endFrame: end.length,
          references: references.length,
        },
      });
      const costContext = falVideoCostContext({ capability: inferred.endpoint, config });
      const costEstimate = await resolveFalCostEstimate(officialCostEstimate, inferred.endpoint.endpoint, inferred.endpoint.schemaHash, costContext);
      const result = await service.video({
        runId: crypto.randomUUID(),
        nodeId: node.id,
        endpoint: inferred.endpoint.endpoint,
        schemaHash: inferred.endpoint.schemaHash,
        prompt,
        ...config,
        startFrame: start[0],
        endFrame: end[0],
        references,
        estimatedCostMicrounits:
          costEstimate.state !== "unavailable"
            ? costEstimate.amountMicrounits
            : undefined,
        costEstimate:
          costEstimate.state !== "unavailable"
            ? costEstimate.snapshot
            : undefined,
        costContext,
        signal: context.signal,
      });
      if (result.contractError) throw new Error(result.contractError);
      const video = {
        kind: "scalar" as const,
        value: {
          type: "video" as const,
          assetId: result.videoHash,
          mimeType: result.mediaType,
        },
      };
      const startFrame = { kind: "scalar" as const, value: { type: "image" as const, assetId: result.startFrameHash, mimeType: "image/png" } };
      const endFrame = { kind: "scalar" as const, value: { type: "image" as const, assetId: result.endFrameHash, mimeType: "image/png" } };
      return {
        outputs: {
          video,
          videos: {
            kind: "list" as const,
            itemType: "video" as const,
            items: [video.value],
          },
          startFrame,
          endFrame,
        },
        metadata: {
          runId: result.runId,
          resultId: result.resultId,
          videoHash: result.videoHash,
          startFrameHash: result.startFrameHash,
          endFrameHash: result.endFrameHash,
          posterHash: result.posterHash ?? "",
          mediaMetadata: result.mediaMetadata,
          costMicrounits: result.costMicrounits ?? 0,
          costProvenance: result.costProvenance,
          targetCurrent: result.targetCurrent,
        },
      };
    },
  },
);
export const videoAppNodeModules = [videoGenerationAppModule] as const;
