import type { JsonValue } from "../../domain/project";
import type { RuntimeValue, ScalarValue } from "../../domain/values";
import { cancelTranscriptionRun, runChat, runTranscription } from "../../api";
import {
  defineConcreteAppNodeModule,
  lazyModuleBody,
} from "../concrete-app-module";
import { exactConfig, field, optionalExportSchema } from "../config-schema";
import { nodeSpecifications as spec } from "../module-specifications";
import { directMediaBindingFromConfig, directMediaConfigField, resolveDirectMediaInputs } from "../direct-media";

const TextGenerationBody = lazyModuleBody(() =>
  import("../extracted-provider-views").then((m) => ({
    default: m.TextGenerationBody,
  })),
);
const ImageAnalysisBody = lazyModuleBody(() =>
  import("../extracted-provider-views").then((m) => ({
    default: m.ImageAnalysisBody,
  })),
);
const TranscriptionBody = lazyModuleBody(() =>
  import("../extracted-provider-views").then((m) => ({
    default: m.TranscriptionBody,
  })),
);
const exportAndFanout = {
  ...optionalExportSchema,
  fanOutResultIds: { validate: field.strings(100), optional: true },
};

type TextConfig = typeof spec.textGeneration.defaults &
  Record<string, JsonValue>;
const textSchema = exactConfig({
  model: { validate: field.nonEmptyString(200) },
  prompt: { validate: field.string() },
  outputMode: { validate: field.enum(["single", "variants"]) },
  variantCount: { validate: field.integer(1, 8) },
  listProcessingMode: { validate: field.enum(["aggregate", "map"]) },
  ...exportAndFanout,
});
function scalars(
  inputs: Readonly<Record<string, readonly RuntimeValue[]>>,
  ports: string[],
): ScalarValue[] {
  return ports
    .flatMap((port) => inputs[port] ?? [])
    .flatMap((value) =>
      value.kind === "scalar" ? [value.value] : value.items,
    );
}
function textValues(
  inputs: Readonly<Record<string, readonly RuntimeValue[]>>,
  ports: string[],
) {
  return scalars(inputs, ports).flatMap((value) =>
    value.type === "text"
      ? [value.value]
      : value.type === "json"
        ? [JSON.stringify(value.value)]
        : [],
  );
}
function imageValues(
  inputs: Readonly<Record<string, readonly RuntimeValue[]>>,
  ports: string[],
  config?: Record<string, JsonValue>,
  connectedInputPorts?: ReadonlySet<string>,
) {
  const connected = scalars(inputs, ports).flatMap((value) =>
    value.type === "image" ? [value.assetId.startsWith("flowz-cas:") ? value.assetId : `flowz-cas:${value.assetId}`] : [],
  );
  return resolveDirectMediaInputs(
    connected,
    config ? directMediaBindingFromConfig(config) : undefined,
    ports.filter((port) => connectedInputPorts?.has(port)).length,
  ).values;
}
async function chat(
  node: { config: TextConfig },
  context: import("../../engine/node-module").NodeExecutionContext,
  vision = false,
) {
  const connected = textValues(
    context.inputs,
    vision ? ["question"] : ["prompt", "textLists"],
  );
  const prompt = [...connected, String(node.config.prompt ?? "")]
    .filter(Boolean)
    .join("\n\n");
  if (!prompt.trim())
    throw new Error("Eine Anweisung oder verbundener Text wird benötigt.");
  const count =
    Number(node.config.variantCount) > 1 ? Number(node.config.variantCount) : 1;
  const outputs: string[] = [];
  const providerResults: {
    resultId: string;
    assetId: string;
    generationId: string;
    costMicrounits: number;
  }[] = [];
  let cost = 0;
  for (let index = 0; index < count; index++) {
    context.signal.throwIfAborted();
    const result = await runChat(
      String(node.config.model),
      count > 1
        ? `${prompt}\n\nErzeuge ausschließlich Variante ${index + 1} von ${count}.`
        : prompt,
      vision ? imageValues(context.inputs, ["image", "imageLists"], node.config, context.connectedInputPorts) : [],
      String(node.config.outputMode) === "single" ? "single" : "free",
    );
    const value = String(result.content ?? "").trim();
    if (!value) throw new Error("Das Modell hat keinen Text zurückgegeben.");
    outputs.push(value);
    providerResults.push({
      resultId: result.resultId ?? "",
      assetId: result.assetId ?? "",
      generationId: result.generationId ?? "",
      costMicrounits: result.costMicrounits ?? 0,
    });
    cost += result.costMicrounits ?? 0;
  }
  return {
    outputs: {
      text: {
        kind: "scalar" as const,
        value: { type: "text" as const, value: outputs[0] },
      },
      ...(outputs.length > 1
        ? {
            texts: {
              kind: "list" as const,
              itemType: "text" as const,
              items: outputs.map((value) => ({ type: "text" as const, value })),
            },
          }
        : {}),
    },
    metadata: {
      costMicrounits: cost,
      variants: outputs.length,
      provider: "openrouter",
      model: String(node.config.model),
      prompt,
      outputMode: String(node.config.outputMode),
      results: providerResults,
    },
  };
}
export const textGenerationAppModule = defineConcreteAppNodeModule(
  "textGeneration",
  spec.textGeneration,
  {
    validateConfig: (config): config is TextConfig => textSchema(config),
    Body: TextGenerationBody,
    execute: (node, context) => chat(node, context),
  },
);

type AnalysisConfig = typeof spec.imageAnalysis.defaults &
  Record<string, JsonValue>;
const analysisSchema = exactConfig({
  model: { validate: field.nonEmptyString(200) },
  prompt: { validate: field.string() },
  variantCount: { validate: field.integer(1, 8) },
  listProcessingMode: { validate: field.enum(["aggregate", "map"]) },
  directMedia: { validate: directMediaConfigField, optional: true },
  ...exportAndFanout,
});
export const imageAnalysisAppModule = defineConcreteAppNodeModule(
  "imageAnalysis",
  spec.imageAnalysis,
  {
    validateConfig: (config): config is AnalysisConfig =>
      analysisSchema(config),
    Body: ImageAnalysisBody,
    execute: (node, context) =>
      chat(
        {
          config: {
            ...node.config,
            outputMode:
              Number(node.config.variantCount) > 1 ? "variants" : "single",
          } as TextConfig,
        },
        context,
        true,
      ),
  },
);

type TranscriptionConfig = typeof spec.transcription.defaults &
  Record<string, JsonValue>;
const transcriptionSchema = exactConfig({
  model: { validate: field.nonEmptyString(200) },
  language: {
    validate: (value) =>
      typeof value === "string" &&
      (value === "auto" || /^[a-z]{2}$/.test(value)),
  },
  timestamps: { validate: field.boolean() },
  ...optionalExportSchema,
});
export const transcriptionAppModule = defineConcreteAppNodeModule(
  "transcription",
  spec.transcription,
  {
    validateConfig: (config): config is TranscriptionConfig =>
      transcriptionSchema(config),
    Body: TranscriptionBody,
    execute: async (node, context) => {
      const identity = context.services?.execution;
      if (!identity) throw new Error("Transkriptionskontext fehlt.");
      const audio = scalars(context.inputs, ["audio"])[0];
      if (!audio || audio.type !== "audio")
        throw new Error("Verbinde ein vollständig gespeichertes Audio.");
      const runId = crypto.randomUUID();
      const abort = () => void cancelTranscriptionRun(runId);
      context.signal.addEventListener("abort", abort, { once: true });
      try {
        const result = await runTranscription({
          runId,
          projectId: identity.projectId,
          nodeId: node.id,
          sourceNodeId: identity.sourceNodeId ?? "audio-source",
          sourceResultId: identity.sourceResultId ?? "audio-result",
          sourceBlobHash: audio.assetId,
          model: String(node.config.model),
          ...(node.config.language !== "auto"
            ? { language: String(node.config.language) }
            : {}),
          timestamps: Boolean(node.config.timestamps),
          executionFingerprint: identity.fingerprint,
        });
        if (!result.text.trim()) throw new Error("Die Transkription ist leer.");
        return {
          outputs: {
            text: {
              kind: "scalar",
              value: { type: "text", value: result.text },
            },
          },
          metadata: {
            costMicrounits: result.costMicrounits ?? 0,
            resultId: result.resultId ?? "",
            persisted: result.persisted,
            timestamps: (result.timestamps as unknown as JsonValue) ?? null,
          },
        };
      } finally {
        context.signal.removeEventListener("abort", abort);
      }
    },
  },
);

export const aiAppNodeModules = [
  textGenerationAppModule,
  imageAnalysisAppModule,
  transcriptionAppModule,
] as const;
