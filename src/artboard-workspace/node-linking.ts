import { persistArtboardComposites, type ArtboardCompositeResult } from "../api";
import { renderArtboardPngFromDocument, renderArtboardSvg } from "../nodes/brand/artboard-renderer";
import type { ArtboardDocument, ArtboardInputSnapshot, InputBinding } from "../nodes/brand/artboard-domain";
import { mediaUrl } from "../persistence/media";
import type { FlowEdge, FlowNode } from "../types";
import type { ArtboardNodeBinding, ArtboardNodeRequest } from "./node-bridge";
import type { OpenArtboardDocument } from "./repository";

const CAS = /^flowz-cas:([a-f0-9]{64})$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const basePort = (value: string | null | undefined) => value?.split("::")[0] ?? "output";
const validId = (value: string | undefined, fallback: string) => value && ID.test(value) ? value : fallback;
const connectedOutput = (node: FlowNode, sourceHandle: string | null | undefined, dataType?: string): string[] => {
  const output = node.data.outputValues?.[sourceHandle ?? ""];
  if (Array.isArray(output)) return output;
  if (typeof output === "string") return [output];
  if (sourceHandle?.startsWith("variant:") || dataType?.endsWith("List") || dataType === "list") return [];
  return typeof node.data.value === "string" ? [node.data.value] : [];
};

function upstreamValues(nodeId: string, portId: "palette" | "fonts" | "images" | "imageLists", nodes: readonly FlowNode[], edges: readonly FlowEdge[]): string[] {
  return edges
    .filter((edge) => edge.target === nodeId && basePort(edge.targetHandle) === portId)
    .sort((left, right) => (left.data?.order ?? 0) - (right.data?.order ?? 0) || left.id.localeCompare(right.id))
    .flatMap((edge) => {
      const source = nodes.find((node) => node.id === edge.source);
      return source ? connectedOutput(source, edge.sourceHandle, edge.data?.dataType) : [];
    })
    .filter(Boolean);
}

/** Reconstructs a durable node link from the authoritative active Flow.
 * This avoids a volatile one-request-per-workspace session map becoming the
 * source of truth after reloads or when multiple nodes share a workspace. */
export function artboardNodeRequestFromFlow(flowId: string, nodeId: string, nodes: readonly FlowNode[], edges: readonly FlowEdge[]): ArtboardNodeRequest {
  const palette = upstreamValues(nodeId, "palette", nodes, edges);
  const fonts = upstreamValues(nodeId, "fonts", nodes, edges);
  const images = [...upstreamValues(nodeId, "images", nodes, edges), ...upstreamValues(nodeId, "imageLists", nodes, edges)];
  return { flowId, nodeId, upstream: { fingerprint: JSON.stringify({ palette, fonts, images }), palette, fonts, images } };
}

function artifactType(value: string): string {
  try {
    const artifact = (JSON.parse(value) as { artifact?: unknown }).artifact;
    return typeof artifact === "string" && ID.test(artifact) ? artifact : "flowz.artifact";
  } catch { return "flowz.artifact"; }
}

function activeResultId(node: FlowNode, value: string, fallback: string): string {
  const history = node.data.history ?? [];
  const matches = (item: (typeof history)[number]) => item.value === value
    || (CAS.test(value) && item.blobHash === value.match(CAS)?.[1])
    || Object.values(item.outputValues ?? {}).some((output) => Array.isArray(output) ? output.includes(value) : output === value);
  const match = history.find((item) => item.active && matches(item)) ?? history.find(matches);
  return validId(match?.id, fallback);
}

async function rawSha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Converts the current typed Flow connections into immutable Artboard bindings. */
export async function createArtboardInputSnapshot(request: ArtboardNodeRequest, nodes: readonly FlowNode[], edges: readonly FlowEdge[]): Promise<ArtboardInputSnapshot> {
  const bindings: Record<string, InputBinding> = {};
  const incoming = edges.filter((edge) => edge.target === request.nodeId && ["palette", "fonts", "images", "imageLists"].includes(basePort(edge.targetHandle)))
    .sort((left, right) => basePort(left.targetHandle).localeCompare(basePort(right.targetHandle)) || (left.data?.order ?? 0) - (right.data?.order ?? 0) || left.id.localeCompare(right.id));
  const counters = new Map<string, number>();
  for (const edge of incoming) {
    const source = nodes.find((node) => node.id === edge.source); if (!source) continue;
    const port = basePort(edge.targetHandle); const values = connectedOutput(source, edge.sourceHandle, edge.data?.dataType);
    for (const value of values) {
      if ((port === "images" || port === "imageLists") && !CAS.test(value)) throw new Error("Artboard-Bilder müssen zuerst sicher im lokalen Medienspeicher vorliegen.");
      const bindingPort = port === "imageLists" ? "images" : port;
      const index = counters.get(bindingPort) ?? 0; counters.set(bindingPort, index + 1);
      // The native persistence boundary re-hashes the exact result text stored
      // in SQLite. Hash the same bytes here (not a JSON fingerprint wrapper).
      const hash = await rawSha256(value);
      const id = `${bindingPort}-${index}`;
      bindings[id] = {
        id,
        source: { projectId: validId(request.flowId, "flow"), nodeId: validId(source.id, `source-${hash.slice(0, 24)}`), portId: validId(basePort(edge.sourceHandle), "output"), resultId: activeResultId(source, value, `result-${hash.slice(0, 24)}`) },
        snapshot: CAS.test(value) ? { kind: "cas", hash: value.match(CAS)![1] } : { kind: "artifact", artifactType: artifactType(value), artifactHash: hash },
        mode: "live",
      };
    }
  }
  return {
    id: crypto.randomUUID(), createdAt: new Date().toISOString(), bindings,
    source: { projectId: validId(request.flowId, "flow"), nodeId: validId(request.nodeId, "artboard-node"), signature: request.upstream.fingerprint },
  };
}

export function artboardBindingFromRevision(opened: OpenArtboardDocument, request: ArtboardNodeRequest): ArtboardNodeBinding {
  const workspace = opened.revision.workspace;
  const active = workspace.boards[workspace.activeBoardId];
  if (!active) throw new Error("Das aktive Artboard fehlt.");
  return {
    flowId: request.flowId, nodeId: request.nodeId, workspaceId: opened.record.id, workspaceName: workspace.name,
    revisionId: opened.revision.id, revisionNumber: opened.revision.revisionNumber, inputSnapshotId: active.inputSnapshot.id,
    linkedInputSignature: request.upstream.fingerprint,
    previewSvg: renderArtboardSvg(active.document, (hash) => `flowz-media://localhost/${hash}`),
    // Composite hashes are populated only after the exact canonical render has
    // been durably committed to CAS. Never substitute a source image layer.
    activeImageHash: undefined,
    selectedImageHashes: [],
  };
}

type CompositeDependencies = {
  render: (document: ArtboardDocument) => Promise<string>;
  persist: typeof persistArtboardComposites;
};

const defaultCompositeDependencies: CompositeDependencies = {
  render: (document) => renderArtboardPngFromDocument(document, mediaUrl),
  persist: persistArtboardComposites,
};

function pngBytes(dataUrl: string): number[] {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) throw new Error("Der kanonische Artboard-Renderer hat keine gültigen PNG-Daten geliefert.");
  const binary = atob(match[1]);
  return Array.from(binary, (character) => character.charCodeAt(0));
}

/** Rasterizes the exact canonical SVG and commits all active/selected board
 * composites as one revision-bound CAS batch. */
export async function persistedArtboardBindingFromRevision(
  opened: OpenArtboardDocument,
  request: ArtboardNodeRequest,
  dependencies: CompositeDependencies = defaultCompositeDependencies,
): Promise<ArtboardNodeBinding> {
  const base = artboardBindingFromRevision(opened, request);
  const workspace = opened.revision.workspace;
  const selected = [...workspace.selectedBoardIds];
  const boardIds = [...new Set([workspace.activeBoardId, ...selected])];
  const rendered = await Promise.all(boardIds.map(async (boardId) => {
    const board = workspace.boards[boardId];
    if (!board) throw new Error(`Das Artboard ${boardId} fehlt in der aktuellen Revision.`);
    return { boardId, pngBytes: pngBytes(await dependencies.render(board.document)) };
  }));
  const operationHash = await rawSha256(JSON.stringify({
    artifact: "flowz.artboard-composite-operation", version: 1,
    flowId: request.flowId, nodeId: request.nodeId, workspaceId: opened.record.id,
    revisionId: opened.revision.id, activeBoardId: workspace.activeBoardId, selectedBoardIds: selected,
  }));
  const results = await dependencies.persist({
    operationId: `composite-${operationHash}`,
    projectId: request.flowId,
    nodeId: request.nodeId,
    workspaceId: opened.record.id,
    revisionId: opened.revision.id,
    composites: rendered.map((item) => ({
      ...item,
      active: item.boardId === workspace.activeBoardId,
      ...(selected.includes(item.boardId) ? { selectedIndex: selected.indexOf(item.boardId) } : {}),
    })),
  });
  const byBoard = new Map<string, ArtboardCompositeResult>();
  for (const result of results) {
    if (byBoard.has(result.boardId) || !CAS.test(`flowz-cas:${result.blobHash}`)) throw new Error("Der persistierte Artboard-Composite-Batch ist inkonsistent.");
    byBoard.set(result.boardId, result);
  }
  if (byBoard.size !== boardIds.length || boardIds.some((boardId) => !byBoard.has(boardId))) throw new Error("Der persistierte Artboard-Composite-Batch ist unvollständig.");
  return {
    ...base,
    activeImageHash: byBoard.get(workspace.activeBoardId)!.blobHash,
    selectedImageHashes: selected.map((boardId) => byBoard.get(boardId)!.blobHash),
  };
}
