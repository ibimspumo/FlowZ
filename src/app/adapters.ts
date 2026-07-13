import type { EdgeChange, NodeChange, Viewport } from "@xyflow/react";
import type {
  GraphEdge,
  GraphNode,
  JsonValue,
  ProjectDocument,
} from "../domain";
import { wouldCreateCycle } from "../engine/graph";
import { definitionFromAppModule, registry } from "../registry";
import type {
  DataType,
  FlowEdge,
  FlowNode,
  FlowNodeData,
  NodeKind,
  NodeStatus,
} from "../types";
import { isMediaNodeConfig } from "../domain/media-config";
import { kindForModuleId, moduleIdForKind } from "../nodes";
import { canonicalNodeRegistry, type CanonicalNodeRegistry } from "../nodes";
import { assertAppNodeCompatibility } from "../engine/node-module";
import { scalarType, type ValueType } from "../domain/values";

export type RuntimeDisplay = Partial<
  Pick<
    FlowNodeData,
    | "status"
    | "value"
    | "cost"
    | "costProvenance"
    | "error"
    | "history"
    | "fileName"
    | "assetId"
    | "persisted"
    | "outputValues"
    | "blobHash"
    | "posterHash"
    | "startFrameHash"
    | "endFrameHash"
    | "mediaType"
    | "mediaMetadata"
    | "collectionItems"
    | "videoCollectionItems"
  >
>;

export function kindForModule(moduleId: string): NodeKind | undefined {
  return kindForModuleId(moduleId);
}
export function moduleForKind(kind: NodeKind): string {
  const moduleId = moduleIdForKind(kind);
  if (!moduleId) throw new Error(`Node kind ${kind} is not persistable.`);
  return moduleId;
}

export function nodeToFlow(
  node: GraphNode,
  runtime?: RuntimeDisplay,
  modules: CanonicalNodeRegistry = canonicalNodeRegistry,
): FlowNode {
  validateNodeForAppRegistry(node, modules);
  const appModule = modules.get(node.moduleId);
  const kind = (appModule?.metadata.kind as NodeKind | undefined) ?? "unsupported";
  const definition = appModule ? definitionFromAppModule(appModule) : registry.unsupported;
  if (
    (kind === "videoInput" || kind === "audioInput") &&
    !isMediaNodeConfig(node.config, kind === "videoInput" ? "video" : "audio")
  )
    throw new Error(`Invalid persisted config for ${node.moduleId}`);
  const defaults = definition.defaults;
  const config = node.config as Partial<FlowNodeData>;
  const labelId=node.labelId??(node.label==null||node.label===definition.label?`node:${kind}`:undefined);
  const inputValue =
    kind === "textInput"
      ? String(node.config.text ?? defaults.value ?? "")
      : undefined;
  const baseStatus: NodeStatus = definition.inputs.length
    ? "stale"
    : "idle";
  return {
    id: node.id,
    type: "flowNode",
    position: node.position,
    data: {
      ...defaults,
      ...config,
      ...(inputValue === undefined ? {} : { value: inputValue }),
      // Persisted config is untrusted. Canonical identity and execution state
      // must always win so an unknown module cannot masquerade as a known one.
      kind,
      label: node.label ?? definition.label,
      ...(labelId?{labelId}:{}),
      status: runtime?.status ?? baseStatus,
      updatePolicy: node.updatePolicy,
      ...(kind === "unsupported" ? { unsupportedModuleId: node.moduleId } : {}),
      ...runtime,
    },
  };
}

/** Native configs fail closed before they enter the React Flow runtime. */
export function validateNodeForAppRegistry(
  node: GraphNode,
  modules: CanonicalNodeRegistry = canonicalNodeRegistry,
): void {
  const module = modules.get(node.moduleId);
  if (module?.viewAdapter.kind === "module")
    assertAppNodeCompatibility(module, node);
}

export function edgeToFlow(
  edge: GraphEdge,
  nodes: readonly GraphNode[],
): FlowEdge {
  const source = nodes.find((node) => node.id === edge.sourceNodeId);
  const kind = source && kindForModule(source.moduleId);
  const type = kind ? portType(kind, "output", edge.sourcePortId) : undefined;
  return {
    id: edge.id,
    source: edge.sourceNodeId,
    sourceHandle: edge.sourcePortId,
    target: edge.targetNodeId,
    // The React node owns one real Handle per canonical input port. Ordering of
    // multiple cables is graph data, not part of the rendered Handle identity.
    // Synthesizing `prompt::0` here made valid persisted/template edges point at
    // handles that do not exist, so React Flow silently omitted their paths.
    targetHandle: edge.targetPortId,
    type: "default",
    animated: false,
    className:
      type?.endsWith("List") || type === "list" ? "edge-list" : undefined,
    data: { dataType: type ?? "text", order: edge.order },
  };
}

export function flowEdgeToGraph(
  edge: Pick<
    FlowEdge,
    "id" | "source" | "sourceHandle" | "target" | "targetHandle"
  >,
  order: number,
): GraphEdge {
  return {
    id: edge.id,
    sourceNodeId: edge.source,
    sourcePortId: edge.sourceHandle ?? "output",
    targetNodeId: edge.target,
    targetPortId: (edge.targetHandle ?? "input").split("::")[0],
    order,
  };
}

export function nextInputOrder(
  document: ProjectDocument,
  targetNodeId: string,
  targetPortId: string,
  excludingId?: string,
): number {
  const used = new Set(
    document.graph.edges
      .filter(
        (edge) =>
          edge.targetNodeId === targetNodeId &&
          edge.targetPortId === targetPortId &&
          edge.id !== excludingId,
      )
      .map((edge) => edge.order),
  );
  let order = 0;
  while (used.has(order)) order += 1;
  return order;
}

export function connectionCreatesCycle(
  document: ProjectDocument,
  edge: GraphEdge,
  replacingId?: string,
): boolean {
  return wouldCreateCycle(
    {
      nodes: document.graph.nodes,
      edges: document.graph.edges.filter((item) => item.id !== replacingId),
    },
    edge,
  );
}

export function configPatchFor(
  kind: NodeKind,
  patch: Partial<FlowNodeData>,
): Record<string, JsonValue> {
  const config: Record<string, JsonValue> = {};
  const baseAllowed =
    kind === "textInput"
      ? ["value"]
      : kind === "imageInput"
        ? []
        : kind === "videoInput" || kind === "audioInput"
          ? []
          : kind === "imageGeneration"
            ? [
                "prompt",
                "model",
                "aspectRatio",
                "resolution",
                "outputFormat",
                "variants",
                "seed",
                "quality",
                "background",
                "inputFidelity",
                "safetyTolerance",
                "thinkingLevel",
                "webSearch",
                "steps",
                "guidance",
                "acceleration",
                "safetyChecker",
                "streamingEnabled",
                "imageEndpointConfigs",
                "fanOutResultIds",
                "listProcessingMode",
              ]
            : kind === "imageUpscale"
              ? [
                  "model",
                  "upscaleMode",
                  "factor",
                  "targetResolution",
                  "outputFormat",
                  "seed",
                  "noise",
                  "topazModel",
                  "faceEnhancement",
                  "subjectDetection",
                  "faceEnhancementCreativity",
                  "faceEnhancementStrength",
                  "sharpen",
                  "denoise",
                  "fixCompression",
                  "strength",
                  "creativity",
                  "texture",
                  "redefinePrompt",
                  "autoprompt",
                  "detail",
                  "enhancementStrength",
                  "premiumConfirmed",
                  "cropToFill",
                ]
              : kind === "imageTransform"
                ? [
                    "transformMode",
                    "transformAspect",
                    "targetWidth",
                    "targetHeight",
                    "dimensionLock",
                    "noUpscale",
                    "outputFormat",
                    "transformQuality",
                    "transformBackground",
                    "cropX",
                    "cropY",
                    "cropWidth",
                    "cropHeight",
                    "listProcessingMode",
                  ]
                : kind === "imageTrimTransparent"
                  ? ["trimPadding", "trimThreshold", "listProcessingMode"]
                : kind === "backgroundRemoval"
                  ? ["model"]
                    : kind === "videoGeneration"
                    ? [
                        "prompt",
                        "model",
                        "duration",
                        "aspectRatio",
                        "resolution",
                        "generateAudio",
                        "bitrateMode",
                        "seed",
                        "variantCount",
                        "listProcessingMode",
                        "endpointConfigs",
                        "fanOutResultIds",
                      ]
                    : kind === "videoFrame"
                      ? ["frameMode", "frameValue"]
                      : kind === "transcription"
                        ? ["model", "language", "timestamps"]
                        : kind === "webpage"
                              ? ["url", "includeScreenshot"]
                              : kind === "research"
                                ? ["query", "resultCount", "freshness"]
                                : kind === "brandBrief"
                                  ? [
                                      "brandName",
                                      "offer",
                                      "audience",
                                      "problem",
                                      "promise",
                                      "personality",
                                      "differentiators",
                                      "constraints",
                                    ]
                                  : kind === "audienceAnalysis"
                                    ? ["model", "prompt"]
                                    : kind === "brandNames"
                                      ? [
                                          "model",
                                          "prompt",
                                          "candidateCount",
                                          "iteration",
                                        ]
                                      : kind === "domainCheck"
                                        ? [
                                            "domainName",
                                            "tlds",
                                            "privacyConsent",
                                            "selectedNameId",
                                          ]
                                        : kind === "handlePlan"
                                          ? ["handle", "selectedNameId"]
                                          : kind === "fontPairing"
                                            ? [
                                                "model",
                                                "fontPresetSeed",
                                                "fontMood",
                                                "fontSpecimenText",
                                                "fontSpecimenExpanded",
                                                "headingFont",
                                                "headingFontVariant",
                                                "headingFontAxes",
                                                "bodyFont",
                                                "bodyFontVariant",
                                                "bodyFontAxes",
                                              ]
                                            : kind === "colorPalette"
                                              ? ["model", "paletteDirection"]
                                              : kind === "logoDesign"
                                                ? [
                                                    "prompt",
                                                    "model",
                                                    "aspectRatio",
                                                    "resolution",
                                                    "outputFormat",
                                                    "variants",
                                                    "quality",
                                                    "background",
                                                    "inputFidelity",
                                                    "streamingEnabled",
                                                    "imageEndpointConfigs",
                                                    "fanOutResultIds",
                                                    "listProcessingMode",
                                                    "inlineBrief",
                                                    "briefOverride",
                                                  ]
                                                : kind === "artboard"
                                                  ? [
                                                      "artboardWorkspaceId",
                                                      "artboardWorkspaceName",
                                                      "artboardRevisionId",
                                                      "artboardRevisionNumber",
                                                      "artboardInputSnapshotId",
                                                      "artboardLinkedInputSignature",
                                                      "artboardPreviewSvg",
                                                      "artboardActiveImageHash",
                                                      "artboardSelectedImageHashes",
                                                    ]
                                                  : kind === "textGeneration" || kind === "imageAnalysis"
                                                    ? [
                                                          "prompt",
                                                          "model",
                                                          "outputMode",
                                                          "variantCount",
                                                          "listProcessingMode",
                                                      ]
                                                    : [];
  const exportable = new Set<NodeKind>([
    "textGeneration",
    "imageGeneration",
    "imageUpscale",
    "imageTransform",
    "imageTrimTransparent",
    "backgroundRemoval",
    "videoGeneration",
    "videoFrame",
    "imageAnalysis",
    "transcription",
    "research",
    "webpage",
    "audienceAnalysis",
    "brandNames",
    "domainCheck",
    "handlePlan",
    "fontPairing",
    "colorPalette",
    "logoDesign",
    "artboard",
  ]);
  const allowed = exportable.has(kind)
    ? [
        ...baseAllowed,
        "exportFolderGrant",
        "exportFolderLabel",
        "exportNameTemplate",
        "exportOverwrite",
        "exportedFiles",
      ]
    : baseAllowed;
  for (const key of allowed) {
    const value = patch[key];
    if (value !== undefined)
      config[key === "value" && kind === "textInput" ? "text" : key] =
        value as JsonValue;
  }
  return config;
}

export function structuralNodeChanges(
  changes: readonly NodeChange<FlowNode>[],
): { positions: Map<string, { x: number; y: number }>; removed: string[] } {
  const positions = new Map<string, { x: number; y: number }>();
  const removed: string[] = [];
  for (const change of changes) {
    if (change.type === "position" && change.position)
      positions.set(change.id, change.position);
    if (change.type === "remove") removed.push(change.id);
  }
  return { positions, removed };
}

export function removedEdgeIds(
  changes: readonly EdgeChange<FlowEdge>[],
): string[] {
  return changes
    .filter(
      (change): change is Extract<EdgeChange<FlowEdge>, { type: "remove" }> =>
        change.type === "remove",
    )
    .map((change) => change.id);
}

export function viewportChanged(a: Viewport, b: Viewport): boolean {
  return a.x !== b.x || a.y !== b.y || a.zoom !== b.zoom;
}

export function portType(
  kind: NodeKind,
  direction: "input" | "output",
  portId: string,
): DataType | undefined {
  const base = portId.split("::")[0];
  if (
    direction === "output" &&
    base.startsWith("variant:") &&
    (kind === "imageGeneration" ||
      kind === "logoDesign" ||
      kind === "imageCollection")
  )
    return "image";
  if (
    direction === "output" &&
    base.startsWith("variant:") &&
    (kind === "videoGeneration" || kind === "videoCollection")
  )
    return "video";
  return (
    direction === "input" ? registry[kind].inputs : registry[kind].outputs
  ).find((port) => port.id === base)?.type;
}

export function portValueType(
  kind: NodeKind,
  direction: "input" | "output",
  portId: string,
): ValueType | undefined {
  const base = portId.split("::")[0];
  if (direction === "output" && base.startsWith("variant:")) {
    if (kind === "imageGeneration" || kind === "logoDesign" || kind === "imageCollection") return scalarType("image");
    if (kind === "videoGeneration" || kind === "videoCollection") return scalarType("video");
  }
  const module = canonicalNodeRegistry.byKind[kind];
  return (direction === "input" ? module?.inputs : module?.outputs)?.find((port) => port.id === base)?.valueType;
}
