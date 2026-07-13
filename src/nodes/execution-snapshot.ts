import type { JsonValue } from "../domain/project";
import { currentExecutionFingerprint, useFlowStore } from "../store";
import type { RuntimeDisplay } from "../app/adapters";

export type ExecutionConnectionSnapshot = {
  sourceNodeId: string;
  sourcePortId: string;
  targetPortId: string;
  order: number;
  identity: string;
  sourceConfig?: Record<string, JsonValue>;
  resultIds?: string[];
  activeResultId?: string;
};

export type ExecutionSnapshot = {
  moduleId: string;
  moduleVersion: number;
  nodeConfig: Record<string, JsonValue>;
  connections: ExecutionConnectionSnapshot[];
  executionFingerprint: string;
  projectRevision: number;
  requestContract?: Record<string, unknown>;
};

const CONFIG_OWNED_SOURCE_MODULES = new Set([
  "core.text-input",
  "core.image-input",
  "core.video-input",
  "core.audio-input",
  "library.asset-text",
  "library.asset-image",
  "brand.brief",
  "brand.artboard",
]);

const ALWAYS_CONFIG_SOURCE_MODULES = new Set([
  "core.text-input",
  "library.asset-text",
  "library.asset-image",
  "brand.brief",
  "brand.artboard",
]);

const CONFIG_PORTS = new Map<string, ReadonlySet<string>>([
  ["core.text-input", new Set(["text"])],
  ["core.image-input", new Set(["image"])],
  ["core.video-input", new Set(["video", "startFrame", "endFrame"])],
  ["core.audio-input", new Set(["audio"])],
  ["library.asset-text", new Set(["text"])],
  ["library.asset-image", new Set(["image"])],
  ["brand.brief", new Set(["brief"])],
  ["brand.artboard", new Set(["artboard", "image", "images"])],
]);

type DurableOutput = {
  id: string;
  value?: string;
  blobHash?: string;
  active?: boolean;
};

function durableOutputs(display: RuntimeDisplay | undefined): DurableOutput[] {
  const history = (display?.history ?? []).flatMap((item) =>
    item.persisted && item.id
      ? [{ id: item.id, value: item.value, blobHash: item.blobHash, active: item.active }]
      : [],
  );
  const images = (display?.collectionItems ?? []).flatMap((item) =>
    item.persisted && item.id
      ? [{ id: item.id, value: item.value, blobHash: item.blobHash }]
      : [],
  );
  const videos = (display?.videoCollectionItems ?? []).flatMap((item) =>
    item.persisted && item.id
      ? [{ id: item.id, value: item.value, blobHash: item.blobHash }]
      : [],
  );
  const seen = new Set<string>();
  return [...history, ...images, ...videos].filter((item) =>
    seen.has(item.id) ? false : Boolean(seen.add(item.id)),
  );
}

function matchesDurableValue(item: DurableOutput, value: unknown): boolean {
  if (typeof value !== "string") return false;
  return item.value === value || (item.blobHash ? value === `flowz-cas:${item.blobHash}` : false);
}

const RESULT_PORTS = new Map<string, ReadonlySet<string>>([
  ["ai.text-generation", new Set(["text", "texts"])],
  ["ai.image-analysis", new Set(["text", "texts"])],
  ["ai.transcription", new Set(["text"])],
  ["context.research", new Set(["text"])],
  ["context.webpage", new Set(["text", "image", "screenshot"])],
  ["brand.audience", new Set(["audience"])],
  ["brand.names", new Set(["names"])],
  ["brand.domain", new Set(["domains"])],
  ["brand.handle-plan", new Set(["handles"])],
  ["brand.font-pairing", new Set(["pairing", "styleHint"])],
  ["brand.color-palette", new Set(["palette"])],
  ["ai.image-generation", new Set(["image", "images"])],
  ["brand.logo-design", new Set(["image", "images"])],
  ["image.upscale", new Set(["image", "images"])],
  ["image.transform", new Set(["image", "images"])],
  ["image.trim-transparent", new Set(["image", "images"])],
  ["image.background-removal", new Set(["image", "images"])],
  ["media.video-frame", new Set(["image", "images"])],
  ["core.image-input", new Set(["image"])],
  ["core.image-collection", new Set(["images"])],
  ["ai.video-generation", new Set(["video", "videos", "startFrame", "endFrame"])],
  ["core.video-input", new Set(["video", "startFrame", "endFrame"])],
  ["core.audio-input", new Set(["audio"])],
  ["core.video-collection", new Set(["videos"])],
]);

const VARIANT_MODULES = new Set([
  "ai.image-generation",
  "brand.logo-design",
  "ai.video-generation",
  "core.image-collection",
  "core.video-collection",
]);

function resultIdentity(
  sourceModuleId: string,
  sourcePortId: string,
  value: unknown,
  display: RuntimeDisplay | undefined,
): Pick<ExecutionConnectionSnapshot, "identity" | "resultIds" | "activeResultId"> | undefined {
  const durable = durableOutputs(display);
  if (!durable.length) return;
  const active = durable.find((item) => item.active);
  const collection = ["core.image-collection", "core.video-collection"].includes(sourceModuleId);
  const variant = sourcePortId.startsWith("variant:") ? sourcePortId.slice("variant:".length) : undefined;
  if (variant) {
    if (!VARIANT_MODULES.has(sourceModuleId)) return;
    const exact = durable.find((item) => item.id === variant && matchesDurableValue(item, value));
    return exact ? { identity: "results", resultIds: [exact.id] } : undefined;
  }
  if (!RESULT_PORTS.get(sourceModuleId)?.has(sourcePortId)) return;

  const values = Array.isArray(value) ? value : [value];
  const used = new Set<string>();
  const resolved = values.flatMap((candidate) => {
    const item = durable.find((entry) => !used.has(entry.id) && matchesDurableValue(entry, candidate));
    if (!item) return [];
    used.add(item.id);
    return [item.id];
  });
  if (resolved.length === values.length && resolved.length > 0) {
    if (!collection && (!active || !resolved.includes(active.id))) return;
    return {
      identity: "results",
      resultIds: resolved,
      ...(!collection && active ? { activeResultId: active.id } : {}),
    };
  }

  // Multi-output results such as webpage screenshots, video boundary frames and
  // Brand font style hints are all derived from the same durable active result.
  // Rust validates the exact source port against that result's persisted fields.
  const derivedPort =
    (sourceModuleId === "context.webpage" && ["image", "screenshot"].includes(sourcePortId)) ||
    (sourceModuleId === "ai.video-generation" && ["startFrame", "endFrame"].includes(sourcePortId)) ||
    (sourceModuleId === "brand.font-pairing" && sourcePortId === "styleHint");
  if (active && derivedPort && value !== null && value !== undefined) {
    return { identity: "results", resultIds: [active.id], activeResultId: active.id };
  }
}

/**
 * Captures the exact persisted graph revision and immutable upstream identities
 * used by the current execution. Rust validates the same shape immediately
 * before activating a completed result.
 */
export async function currentExecutionSnapshot(
  nodeId: string,
  projectRevision: number,
  requestContract?: Record<string, unknown>,
): Promise<ExecutionSnapshot> {
  const state = useFlowStore.getState();
  const document = state.document;
  const node = document?.graph.nodes.find((item) => item.id === nodeId);
  const executionFingerprint = currentExecutionFingerprint(nodeId);
  if (
    !document ||
    !node ||
    state.revision !== projectRevision ||
    !executionFingerprint
  )
    throw new Error("Der Ausführungsstand ist nicht revisionssicher verfügbar.");
  const parsedFingerprint = JSON.parse(executionFingerprint) as {
    inputs?: Array<{ sourceNodeId?: string; sourcePortId?: string; targetPortId?: string; order?: number; value?: unknown }>;
  };

  const connections = await Promise.all(
    document.graph.edges
      .filter((edge) => edge.targetNodeId === nodeId)
      .sort(
        (left, right) =>
          left.targetPortId.localeCompare(right.targetPortId) ||
          left.order - right.order ||
          left.id.localeCompare(right.id),
      )
      .map(async (edge): Promise<ExecutionConnectionSnapshot> => {
        const sourceNode = document.graph.nodes.find(
          (item) => item.id === edge.sourceNodeId,
        );
        const sourceDisplay = state.nodes.find(
          (item) => item.id === edge.sourceNodeId,
        )?.data ?? state.runtimeDisplays.get(edge.sourceNodeId);
        if (!sourceNode)
          throw new Error("Eine verbundene Quell-Node ist nicht mehr vorhanden.");
        const input = parsedFingerprint.inputs?.find(
          (item) =>
            item.sourceNodeId === edge.sourceNodeId &&
            item.sourcePortId === edge.sourcePortId &&
            item.targetPortId === edge.targetPortId &&
            item.order === edge.order,
        );
        if (!input || input.value === null || input.value === undefined)
          throw new Error("Eine verbundene Quelle besitzt keinen revisionssicheren Ausgabewert.");
        if (
          ALWAYS_CONFIG_SOURCE_MODULES.has(sourceNode.moduleId) &&
          CONFIG_PORTS.get(sourceNode.moduleId)?.has(edge.sourcePortId)
        ) {
          return {
            sourceNodeId: edge.sourceNodeId,
            sourcePortId: edge.sourcePortId,
            targetPortId: edge.targetPortId,
            order: edge.order,
            identity: "config",
            sourceConfig: structuredClone(sourceNode.config),
          };
        }
        const result = resultIdentity(sourceNode.moduleId, edge.sourcePortId, input.value, sourceDisplay);
        if (result) {
          return {
            sourceNodeId: edge.sourceNodeId,
            sourcePortId: edge.sourcePortId,
            targetPortId: edge.targetPortId,
            order: edge.order,
            ...result,
            ...(["core.image-collection", "core.video-collection"].includes(sourceNode.moduleId)
              ? { sourceConfig: structuredClone(sourceNode.config) }
              : {}),
          };
        }
        if (
          CONFIG_OWNED_SOURCE_MODULES.has(sourceNode.moduleId) &&
          CONFIG_PORTS.get(sourceNode.moduleId)?.has(edge.sourcePortId)
        ) {
          return {
            sourceNodeId: edge.sourceNodeId,
            sourcePortId: edge.sourcePortId,
            targetPortId: edge.targetPortId,
            order: edge.order,
            identity: "config",
            sourceConfig: structuredClone(sourceNode.config),
          };
        }
        throw new Error(`Die Ausgabe von ${sourceNode.moduleId}.${edge.sourcePortId} besitzt keine dauerhafte, prüfbare Identität.`);
      }),
  );

  return {
    moduleId: node.moduleId,
    moduleVersion: node.moduleVersion,
    nodeConfig: structuredClone(node.config),
    connections,
    executionFingerprint,
    projectRevision,
    ...(requestContract ? { requestContract: structuredClone(requestContract) } : {}),
  };
}
