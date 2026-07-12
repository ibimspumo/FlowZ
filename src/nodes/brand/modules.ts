import type { JsonValue } from "../../domain/project";
import type { RuntimeValue } from "../../domain/values";
import type { FlowNodeData } from "../../types";
import {
  defineConcreteAppNodeModule,
  lazyModuleBody,
} from "../concrete-app-module";
import { exactConfig, field, optionalExportSchema } from "../config-schema";
import { nodeSpecifications as spec } from "../module-specifications";
import { executeBrandNode } from "./execute";
import { logoDesignFalAppModule } from "../image/logo-module";

const body = (name: keyof typeof import("../extracted-provider-views")) =>
  lazyModuleBody(() =>
    import("../extracted-provider-views").then((module) => ({
      default: module[name] as import("react").ComponentType<any>,
    })),
  );
const BrandBriefBody = body("BrandBriefBody"),
  AudienceAnalysisBody = body("AudienceAnalysisBody"),
  BrandNamesBody = body("BrandNamesBody"),
  DomainCheckBody = body("DomainCheckBody"),
  HandlePlanBody = body("HandlePlanBody"),
  FontPairingBody = body("FontPairingBody"),
  ColorPaletteBody = body("ColorPaletteBody"),
  ArtboardReferenceBody = body("ArtboardReferenceBody");
const model = { validate: field.nonEmptyString(200) };
const text = { validate: field.string() };
const axes = {
  validate: (value: JsonValue) =>
    Boolean(
      value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.entries(value).every(
          ([key, item]) =>
            /^[A-Za-z0-9]{4}$/.test(key) &&
            typeof item === "number" &&
            Number.isFinite(item),
        ),
    ),
};
function inputStrings(
  inputs: Readonly<Record<string, readonly RuntimeValue[]>>,
) {
  return Object.fromEntries(
    Object.entries(inputs).map(([port, values]) => [
      port,
      values.flatMap((value) => {
        const items = value.kind === "scalar" ? [value.value] : value.items;
        return items.map((item) =>
          item.type === "text"
            ? item.value
            : item.type === "json"
              ? JSON.stringify(item.value)
              : item.type === "webpage"
                ? item.url
                : `flowz-cas:${item.assetId}`,
        );
      }),
    ]),
  );
}
function brandExecutor(
  kind:
    | "brandBrief"
    | "audienceAnalysis"
    | "brandNames"
    | "domainCheck"
    | "handlePlan"
    | "fontPairing"
    | "colorPalette",
) {
  return async (
    node: { config: Record<string, JsonValue> },
    context: import("../../engine/node-module").NodeExecutionContext,
  ) => {
    context.signal.throwIfAborted();
    const result = await executeBrandNode(
      kind,
      node.config as unknown as FlowNodeData,
      inputStrings(context.inputs),
    );
    context.signal.throwIfAborted();
    const entries = result.outputs ?? { [result.output]: result.value };
    return {
      outputs: Object.fromEntries(
        Object.entries(entries).map(([id, value]) => [
          id,
          {
            kind: "scalar" as const,
            value:
              id === "styleHint"
                ? { type: "text" as const, value }
                : {
                    type: "json" as const,
                    value: JSON.parse(value) as JsonValue,
                  },
          },
        ]),
      ),
      metadata: {
        costMicrounits: result.costMicrounits ?? 0,
        ...result.parameters,
      },
    };
  };
}

type Config = Record<string, JsonValue>;
const briefSchema = exactConfig({
  brandName: text,
  offer: text,
  audience: text,
  problem: text,
  promise: text,
  personality: text,
  differentiators: text,
  constraints: text,
});
export const brandBriefAppModule = defineConcreteAppNodeModule(
  "brandBrief",
  spec.brandBrief,
  {
    validateConfig: (config): config is Config => briefSchema(config),
    Body: BrandBriefBody,
    execute: brandExecutor("brandBrief"),
  },
);
const audienceSchema = exactConfig({
  model,
  prompt: text,
  ...optionalExportSchema,
});
export const audienceAnalysisAppModule = defineConcreteAppNodeModule(
  "audienceAnalysis",
  spec.audienceAnalysis,
  {
    validateConfig: (config): config is Config => audienceSchema(config),
    Body: AudienceAnalysisBody,
    execute: brandExecutor("audienceAnalysis"),
  },
);
const namesSchema = exactConfig({
  model,
  candidateCount: { validate: field.integer(1, 20) },
  iteration: { validate: field.integer(0, 100_000) },
  prompt: text,
  ...optionalExportSchema,
});
export const brandNamesAppModule = defineConcreteAppNodeModule(
  "brandNames",
  spec.brandNames,
  {
    validateConfig: (config): config is Config => namesSchema(config),
    Body: BrandNamesBody,
    execute: brandExecutor("brandNames"),
  },
);
const domainsSchema = exactConfig({
  tlds: { validate: field.strings(20, 32) },
  privacyConsent: { validate: field.boolean() },
  selectedNameId: text,
  domainName: text,
  ...optionalExportSchema,
});
export const domainCheckAppModule = defineConcreteAppNodeModule(
  "domainCheck",
  spec.domainCheck,
  {
    validateConfig: (config): config is Config => domainsSchema(config),
    Body: DomainCheckBody,
    execute: brandExecutor("domainCheck"),
  },
);
const handlesSchema = exactConfig({
  handle: text,
  selectedNameId: text,
  ...optionalExportSchema,
});
export const handlePlanAppModule = defineConcreteAppNodeModule(
  "handlePlan",
  spec.handlePlan,
  {
    validateConfig: (config): config is Config => handlesSchema(config),
    Body: HandlePlanBody,
    execute: brandExecutor("handlePlan"),
  },
);
const fontsSchema = exactConfig({
  model,
  fontPresetSeed: { validate: field.integer(0, Number.MAX_SAFE_INTEGER) },
  fontMood: { validate: field.string(80) },
  fontSpecimenText: { validate: field.string(2_000) },
  headingFont: { validate: field.nonEmptyString(120) },
  headingFontVariant: { validate: field.integer(0, 1_000) },
  headingFontAxes: axes,
  bodyFont: { validate: field.nonEmptyString(120) },
  bodyFontVariant: { validate: field.integer(0, 1_000) },
  bodyFontAxes: axes,
  ...optionalExportSchema,
});
export const fontPairingAppModule = defineConcreteAppNodeModule(
  "fontPairing",
  spec.fontPairing,
  {
    validateConfig: (config): config is Config => fontsSchema(config),
    Body: FontPairingBody,
    execute: brandExecutor("fontPairing"),
  },
);
const paletteSchema = exactConfig({
  model,
  paletteDirection: text,
  ...optionalExportSchema,
});
export const colorPaletteAppModule = defineConcreteAppNodeModule(
  "colorPalette",
  spec.colorPalette,
  {
    validateConfig: (config): config is Config => paletteSchema(config),
    Body: ColorPaletteBody,
    execute: brandExecutor("colorPalette"),
  },
);

export const logoDesignAppModule = logoDesignFalAppModule;

const artboardSchema = exactConfig({
  artboardSelectedImageHashes: { validate: field.strings(100, 64) },
  artboardWorkspaceId: { validate: field.string(128), optional: true },
  artboardWorkspaceName: { validate: field.string(160), optional: true },
  artboardRevisionId: { validate: field.string(128), optional: true },
  artboardRevisionNumber: {
    validate: field.integer(1, Number.MAX_SAFE_INTEGER),
    optional: true,
  },
  artboardInputSnapshotId: { validate: field.string(128), optional: true },
  artboardLinkedInputSignature: {
    validate: field.string(200_000),
    optional: true,
  },
  artboardPreviewSvg: { validate: field.string(2_000_000), optional: true },
  artboardActiveImageHash: {
    validate: (value) =>
      typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
    optional: true,
  },
});
export const artboardAppModule = defineConcreteAppNodeModule(
  "artboard",
  spec.artboard,
  {
    validateConfig: (config): config is Config => artboardSchema(config),
    Body: ArtboardReferenceBody,
    execute: async (node) => {
      const image =
        typeof node.config.artboardActiveImageHash === "string"
          ? node.config.artboardActiveImageHash
          : undefined;
      const selected = Array.isArray(node.config.artboardSelectedImageHashes)
        ? (node.config.artboardSelectedImageHashes as string[])
        : [];
      return {
        outputs: {
          artboard: {
            kind: "scalar",
            value: {
              type: "json",
              value: {
                workspaceId: node.config.artboardWorkspaceId ?? null,
                revisionId: node.config.artboardRevisionId ?? null,
              },
            },
          },
          ...(image
            ? {
                image: {
                  kind: "scalar" as const,
                  value: { type: "image" as const, assetId: image },
                },
              }
            : {}),
          ...(selected.length
            ? {
                images: {
                  kind: "list" as const,
                  itemType: "image" as const,
                  items: selected.map((assetId) => ({
                    type: "image" as const,
                    assetId,
                  })),
                },
              }
            : {}),
        },
      };
    },
  },
);

export const brandAppNodeModules = [
  brandBriefAppModule,
  audienceAnalysisAppModule,
  brandNamesAppModule,
  domainCheckAppModule,
  handlePlanAppModule,
  fontPairingAppModule,
  colorPaletteAppModule,
  logoDesignAppModule,
  artboardAppModule,
] as const;
