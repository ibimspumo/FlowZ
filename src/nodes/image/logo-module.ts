import type { JsonValue } from "../../domain/project";
import {
  defineConcreteAppNodeModule,
  lazyModuleBody,
} from "../concrete-app-module";
import { exactConfig, field, optionalExportSchema } from "../config-schema";
import { imageResult, jsonContext } from "../fal-runtime";
import { nodeSpecifications as spec } from "../module-specifications";
import {
  falImageEndpoint,
  falImageModel,
  falImageRequestConfig,
  falImageStreamingMode,
  validateFalImageConfig,
  type FalImageConfig,
} from "./capabilities";
import { estimateFalImageCost, falImageCostContext, resolveFalCostEstimate } from "../fal-pricing";
import { directMediaConfigField } from "../direct-media";
import { directImageInputs } from "../fal-runtime";

const FalLogoDesignBody = lazyModuleBody(() =>
  import("./views").then((module) => ({ default: module.FalLogoDesignBody })),
);
const jsonObject = (value: JsonValue) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
export function resolveLogoBrief(
  connected: readonly string[],
  inlineValue: string,
  override: boolean,
): { values: string[]; source: "connected" | "local" | "override" | "missing" } {
  const inline = inlineValue.trim();
  if (override && inline) return { values: [inline], source: "override" };
  if (connected.length) return { values: [...connected], source: "connected" };
  if (inline) return { values: [inline], source: "local" };
  return { values: [], source: "missing" };
}
type LogoConfig = typeof spec.logoDesign.defaults & Record<string, JsonValue>;
const schema = exactConfig({
  model: { validate: field.nonEmptyString(200) },
  prompt: { validate: field.string(20_000) },
  inlineBrief: { validate: field.string(8_000) },
  briefOverride: { validate: field.boolean() },
  resolution: { validate: field.nonEmptyString(64) },
  aspectRatio: { validate: field.nonEmptyString(32) },
  outputFormat: { validate: field.enum(["png", "jpeg", "webp"]) },
  variants: { validate: field.integer(1, 4) },
  quality: { validate: field.enum(["low", "medium", "high"]) },
  background: { validate: field.enum(["auto", "transparent", "opaque"]) },
  inputFidelity: { validate: field.enum(["low", "high"]) },
  imageEndpointConfigs: { validate: jsonObject },
  streamingEnabled: { validate: field.boolean(), optional: true },
  directMedia: { validate: directMediaConfigField, optional: true },
  fanOutResultIds: { validate: field.strings(100), optional: true },
  ...optionalExportSchema,
});

export const logoDesignFalAppModule = defineConcreteAppNodeModule(
  "logoDesign",
  spec.logoDesign,
  {
    validateConfig: (config): config is LogoConfig =>
      schema(config) && String(config.model) === "fal-ai/gpt-image-1.5",
    Body: FalLogoDesignBody,
    execute: async (node, context) => {
      const service = context.services?.fal;
      if (!service)
        throw new Error("Der fal.ai-Bilddienst ist nicht verfügbar.");
      const model = falImageModel(String(node.config.model));
      if (!model)
        throw new Error("Das Logo-Modell besitzt keinen geprüften Adapter.");
      const references = directImageInputs(
        context,
        node.config,
        "references",
        "referenceLists",
      ).values;
      const connectedBrief = jsonContext(context, "brief");
      const supportingContext = jsonContext(context, "audience", "palette");
      const brief = resolveLogoBrief(
        connectedBrief,
        String(node.config.inlineBrief ?? ""),
        Boolean(node.config.briefOverride),
      ).values;
      if (!brief.length)
        throw new Error("Verbinde ein Markenbriefing oder trage ein lokales Briefing ein.");
      const prompt = [
        "Erzeuge ein eigenständiges, professionelles Logo mit transparentem Hintergrund.",
        String(node.config.prompt),
        ...brief,
        ...supportingContext,
      ].join("\n\n");
      const config: FalImageConfig = {
        size: String(node.config.resolution),
        aspectRatio: String(node.config.aspectRatio),
        outputFormat: String(node.config.outputFormat),
        variants: Number(node.config.variants),
        quality: String(node.config.quality),
        background: String(node.config.background),
        inputFidelity: String(node.config.inputFidelity),
        streamingEnabled: node.config.streamingEnabled !== false,
      };
      const errors = validateFalImageConfig(
        model,
        config,
        references.length,
        prompt,
      );
      if (errors.length) throw new Error(errors.join(" "));
      const endpoint = falImageEndpoint(model, references.length);
      if (!endpoint)
        throw new Error(
          "Für diese Logo-Eingänge existiert kein geprüfter Endpoint.",
        );
      const officialCostEstimate = estimateFalImageCost({
        model,
        endpoint,
        config,
        referenceCount: references.length,
        prompt,
      });
      const costContext = falImageCostContext({
        model,
        endpoint,
        config,
        referenceCount: references.length,
      });
      const costEstimate = await resolveFalCostEstimate(officialCostEstimate, endpoint, model.schemaHash, costContext);
      const result = await service.image({
        runId: crypto.randomUUID(),
        nodeId: node.id,
        modelId: model.id,
        endpoint,
        schemaHash: model.schemaHash,
        prompt,
        references,
        config: falImageRequestConfig(
          model,
          config,
          references.length,
        ) as Record<string, unknown>,
        costEstimate:
          costEstimate.state !== "unavailable"
            ? costEstimate.snapshot
            : undefined,
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
