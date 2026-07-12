import type { GraphNode, JsonValue } from "../domain/project";
import type {
  InputCardinality,
  RuntimeValue,
  ValueType,
} from "../domain/values";
import type { ListExecutionOptions, ListMapResult } from "./list-execution";
import { createElement, type ComponentType } from "react";

export type OutputPort = {
  id: string;
  label: string;
  labelKey?: string;
  /** Product-facing type identity while DataType call sites move to ValueType. */
  dataType?: string;
  valueType: ValueType;
};

export type InputPort = OutputPort & {
  optional?: boolean;
  cardinality?: InputCardinality;
  /** Presentation compatibility while cardinality is the engine truth. */
  multiple?: boolean;
};

/** @deprecated Prefer InputPort or OutputPort where the direction is known. */
export type NodePort = InputPort;

export type NodeExecutionContext = {
  signal: AbortSignal;
  inputs: Readonly<Record<string, readonly RuntimeValue[]>>;
  reportProgress?: (progress: number, message?: string) => void;
  services?: NodeExecutionServices;
};

export type NodeExecutionServices = {
  execution?: {
    projectId: string;
    fingerprint: string;
    sourceNodeId?: string;
    sourceResultId?: string;
  };
  webpage?: {
    fetch: (request: {
      url: string;
      includeScreenshot: boolean;
    }) => Promise<{
      finalUrl: string;
      title?: string;
      text: string;
      screenshotDataUrl?: string;
      screenshotProvider?: string;
      truncated: boolean;
    }>;
  };
  research?: {
    search: (request: {
      query: string;
      resultCount: number;
      freshness: string;
    }) => Promise<{ provider: string; markdown: string; resultCount: number }>;
  };
  assets?: {
    get: (
      versionId: string,
    ) => Promise<{ text?: string; dataUrl?: string; mediaType?: string }>;
  };
  mediaInputs?: {
    get: (
      nodeId: string,
      kind: "image" | "video" | "audio",
      signal: AbortSignal,
    ) => Promise<{
      assetId: string;
      mediaType?: string;
      startFrameAssetId?: string;
      endFrameAssetId?: string;
    }>;
  };
  results?: {
    getImage: (
      resultId: string,
    ) => Promise<{ assetId: string; mediaType?: string }>;
    getVideo?: (
      resultId: string,
    ) => Promise<{ assetId: string; mediaType?: string }>;
  };
  videoFrame?: {
    extract: (request: {
      nodeId: string;
      videoAssetId: string;
      mode: "first" | "last" | "seconds" | "percent";
      value?: number;
      signal: AbortSignal;
    }) => Promise<{
      assetId: string;
      mediaType: string;
      width?: number;
      height?: number;
    }>;
  };
  imageOperations?: {
    transform: (request: {
      nodeId: string;
      sourceAssetId: string;
      recipe: Record<string, JsonValue>;
      signal: AbortSignal;
    }) => Promise<{
      assetId: string;
      mediaType: string;
      width: number;
      height: number;
    }>;
    trimTransparent: (request: {
      nodeId: string;
      sourceAssetId: string;
      padding: number;
      threshold: number;
      signal: AbortSignal;
    }) => Promise<{
      assetId: string;
      mediaType: string;
      width: number;
      height: number;
      outcome: string;
    }>;
  };
  /** Provider transport is injected by the desktop runtime. Modules own request
   * semantics; credentials, uploads, durable paid-run state and CAS persistence
   * stay behind this narrow boundary. */
  fal?: {
    image: (request: {
      runId: string;
      nodeId: string;
      modelId: string;
      endpoint: string;
      schemaHash: string;
      prompt: string;
      references: string[];
      mask?: string;
      config: Record<string, unknown>;
      costEstimate?: JsonValue;
      costContext?: JsonValue;
      streaming: boolean;
      signal: AbortSignal;
    }) => Promise<{
      runId: string;
      targetCurrent: boolean;
      contractError?: string;
      costMicrounits?: number;
      costProvenance: "actual" | "estimated" | "unknown";
      images: {
        resultId: string;
        assetId: string;
        blobHash: string;
        mediaType: string;
        width: number;
        height: number;
        hasAlpha: boolean;
      }[];
    }>;
    imageTool: (request: {
      runId: string;
      nodeId: string;
      endpoint: string;
      schemaHash: string;
      source: string;
      config: Record<string, unknown>;
      estimatedCostMicrounits?: number;
      signal: AbortSignal;
    }) => Promise<{
      runId: string;
      resultId: string;
      assetId: string;
      blobHash: string;
      mediaType: string;
      width: number;
      height: number;
      hasAlpha: boolean;
      targetCurrent: boolean;
      contractError?: string;
      costMicrounits?: number;
      costProvenance: "actual" | "estimated" | "unknown";
    }>;
    video: (request: {
      runId: string;
      nodeId: string;
      endpoint: string;
      schemaHash: string;
      prompt: string;
      duration: number | "auto";
      resolution: string;
      aspectRatio: string;
      generateAudio: boolean;
      bitrateMode: "standard" | "high";
      seed?: number;
      startFrame?: string;
      endFrame?: string;
      references: string[];
      estimatedCostMicrounits?: number;
      costEstimate?: JsonValue;
      costContext?: JsonValue;
      signal: AbortSignal;
    }) => Promise<{
      runId: string;
      resultId: string;
      videoHash: string;
      startFrameHash: string;
      endFrameHash: string;
      mediaType: string;
      mediaMetadata: JsonValue;
      posterHash?: string;
      targetCurrent: boolean;
      contractError?: string;
      costMicrounits?: number;
      costProvenance: "actual" | "estimated" | "unknown";
    }>;
  };
  listMap?: {
    execute: (options: ListExecutionOptions) => Promise<ListMapResult>;
  };
};

export type NodeExecutionResult = {
  outputs: Readonly<Record<string, RuntimeValue>>;
  metadata?: Readonly<Record<string, JsonValue>>;
};

export type NodeViewProps<Config extends Record<string, JsonValue>> = {
  node: GraphNode & { config: Config };
  selected: boolean;
  /** Runtime-owned view state. Concrete interactive modules validate this at their view boundary. */
  runtimeProps?: unknown;
};

export type NodeIconProps = { size?: number; className?: string };

/** A localizable product-owned label with a stable catalog key and DE fallback. */
export type LocalizedModuleText = {
  key: string;
  fallback: string;
};

export type AppModuleMetadata<Kind extends string = string> = {
  kind: Kind;
  label: LocalizedModuleText;
  description: LocalizedModuleText;
  category: LocalizedModuleText;
};

export type NodeCostEstimate = {
  currency: "USD";
  amountMicrounits?: number;
  provenance: "estimated" | "unknown";
};

export type NativeNodeExecutionAdapter<
  Config extends Record<string, JsonValue>,
> = {
  kind: "native";
  execute: (
    node: GraphNode & { config: Config },
    context: NodeExecutionContext,
  ) => Promise<NodeExecutionResult>;
};

export type NodeExecutionAdapter<Config extends Record<string, JsonValue>> =
  NativeNodeExecutionAdapter<Config>;

export type NodeViewAdapter = { kind: "module"; layout?: "shell" | "complete" };

/**
 * Complete application-level module contract. It is intentionally separate
 * from the smaller engine NodeModule. Every canonical app module owns metadata, ports, config, view and
 * execution declarations in one record.
 */
export type AppNodeModule<
  Id extends string = string,
  Kind extends string = string,
  Config extends Record<string, JsonValue> = Record<string, JsonValue>,
> = {
  id: Id;
  version: number;
  persistable: boolean;
  visibility: "public" | "hidden" | "unsupported";
  metadata: AppModuleMetadata<Kind>;
  inputs: readonly InputPort[];
  outputs: readonly OutputPort[];
  defaultConfig: Config;
  validateConfig: (config: Record<string, JsonValue>) => config is Config;
  Icon: ComponentType<NodeIconProps>;
  Body: ComponentType<NodeViewProps<Config>>;
  viewAdapter: NodeViewAdapter;
  execution: NodeExecutionAdapter<Config>;
  runLabel?: LocalizedModuleText;
  estimateCost?: (
    node: GraphNode & { config: Config },
    context: NodeExecutionContext,
  ) => NodeCostEstimate | undefined;
};

export function defineAppNodeModule<
  const Id extends string,
  const Kind extends string,
  const Config extends Record<string, JsonValue>,
>(module: AppNodeModule<Id, Kind, Config>): AppNodeModule<Id, Kind, Config> {
  return module;
}

export async function executeAppNodeModule<
  Config extends Record<string, JsonValue>,
>(
  module: AppNodeModule<string, string, Config>,
  node: GraphNode & { config: Config },
  context: NodeExecutionContext,
): Promise<NodeExecutionResult> {
  assertAppNodeCompatibility(module, node);
  return module.execution.execute(node, context);
}

export function assertAppNodeCompatibility<
  Config extends Record<string, JsonValue>,
>(
  module: AppNodeModule<string, string, Config>,
  node: GraphNode,
): asserts node is GraphNode & { config: Config } {
  if (node.moduleId !== module.id)
    throw new Error(
      `Node module id ${node.moduleId} does not match ${module.id}.`,
    );
  if (node.moduleVersion !== module.version)
    throw new Error(
      `Node module version ${node.moduleVersion} is incompatible with ${module.id}@${module.version}.`,
    );
  if (!module.validateConfig(node.config))
    throw new Error(
      `Node config is invalid for ${module.id}@${module.version}.`,
    );
}

export type NodeModule<
  Id extends string = string,
  Config extends Record<string, JsonValue> = Record<string, JsonValue>,
> = {
  id: Id;
  version: number;
  label: string;
  category: string;
  inputs: readonly InputPort[];
  outputs: readonly OutputPort[];
  defaultConfig: Config;
  View: ComponentType<NodeViewProps<Config>>;
  Icon: ComponentType<NodeIconProps>;
  validateConfig?: (config: Record<string, JsonValue>) => config is Config;
  execute: (
    node: GraphNode & { config: Config },
    context: NodeExecutionContext,
  ) => Promise<NodeExecutionResult>;
};

export function defineNodeModule<
  const Id extends string,
  const Config extends Record<string, JsonValue>,
>(module: NodeModule<Id, Config>): NodeModule<Id, Config> {
  return module;
}

/** Generic renderers for intentionally plain modules; registry consumers never switch on module id. */
export function DefaultNodeView({
  node,
  selected,
}: NodeViewProps<Record<string, JsonValue>>) {
  return createElement(
    "div",
    {
      "data-node-module": node.moduleId,
      "data-selected": selected || undefined,
    },
    node.label ?? node.moduleId,
  );
}

export function DefaultNodeIcon({ size = 16, className }: NodeIconProps) {
  return createElement(
    "span",
    { className, style: { width: size, height: size }, "aria-hidden": true },
    "◇",
  );
}
