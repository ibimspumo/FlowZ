import { applyEdgeChanges, applyNodeChanges, type Connection, type EdgeChange, type NodeChange, type Viewport, type XYPosition } from '@xyflow/react';
import { create } from 'zustand';
import { configPatchFor, connectionCreatesCycle, edgeToFlow, flowEdgeToGraph, kindForModule, moduleForKind, nextInputOrder, nodeToFlow, portValueType, removedEdgeIds, structuralNodeChanges, type RuntimeDisplay } from './app/adapters';
import { CURRENT_SCHEMA_VERSION, microUnits, migrateV1ToV2, type GraphNode, type LegacyImportBundle, type ProjectDocument, type RuntimeValue, type UpdatePolicy } from './domain';
import { inferMediaPlayable } from './domain/media-config';
import { CommandBus } from './state/command-bus';
import * as commands from './state/commands';
import { createProject, isDesktopRuntime, listProjects, openProject, ProjectConflictError, saveProject, type ProjectSummary } from './persistence/projects';
import { loadLibraryResultData, loadProjectResults } from './persistence/library';
import { getLibraryAssetContents } from './persistence/assets';
import type { LibraryAssetPayload } from './persistence/assets';
import { assetNodeConfig, assetNodeKind, assetValue, isCompatibleAssetTarget } from './components/asset-drag';
import { registry } from './registry';
import { RuntimeStore } from './runtime';
import type { DataType, FlowEdge, FlowNode, FlowNodeData, HistoryItem, ImageCollectionItem, NodeKind, NodeStatus, TranscriptionTimestamps, VideoCollectionItem } from './types';
import { materializeTemplate, type CanvasTemplate } from './templates';
import { activatedImageOutputs, activatedTextOutputs, activatedVideoOutputs, compareVariantOrder } from './components/result-curation';
import { deleteLibraryResult, setActiveLibraryResult } from './persistence/library';
import { artboardNodeOutputs } from './artboard-workspace/node-reference';
import { mediaUrl } from './persistence/media';
import { DIRECT_MEDIA_TARGETS, isDirectMediaBinding, type DirectMediaBinding } from './nodes/direct-media';
import { areValueTypesCompatible } from './engine/compatibility';
import { hydratePaidBrandOutputs, PAID_BRAND_FINGERPRINTED_MODULES } from './nodes/provider-persistence';

const LEGACY_STORAGE_KEY = 'flowz-project-v1';
const LEGACY_IMPORTED_KEY = 'flowz-project-v1-imported';
export const SAVE_DELAY = 2_000;

export const runtimeStore = new RuntimeStore();
let commandBus: CommandBus | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let savePromise: Promise<boolean> | undefined;
let saveGestureActive = false;
let changeSequence = 0;
let openGeneration = 0;
const activeRuns = new Map<string, { runId: string; fingerprint: string }>();
export const FLOW_COVER_INVALIDATED_EVENT = 'flowz-document-cover-invalidated';
function notifyFlowCoverInvalidated(documentId: string) {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(FLOW_COVER_INVALIDATED_EVENT, { detail: { documentId } }));
}
// Graph history deliberately excludes generated runtime results. Asset replacement is
// different: the visible value is part of the structural node definition, so keep the
// exact before/after display alongside the immutable CommandBus document snapshots.
const assetRuntimeSnapshots = new WeakMap<ProjectDocument, Map<string, RuntimeDisplay | undefined>>();
const EMPTY_IMPORTS: LegacyImportBundle['imports'] = { assets: [], results: [], costs: [] };

function now() { return new Date().toISOString(); }
function freshId() { return crypto.randomUUID(); }
function runtimeNodeId(projectId: string, nodeId: string) { return `${projectId}\0${nodeId}`; }
function activeRunKey(projectId: string, nodeId: string) { return `${projectId}\0${nodeId}`; }
function isAssetModule(moduleId: string) { return moduleId === 'library.asset-text' || moduleId === 'library.asset-image'; }
const CAS_HASH = /^[a-f0-9]{64}$/i;
export function casReference(blobHash?: string): string | undefined {
  return blobHash && CAS_HASH.test(blobHash) ? `flowz-cas:${blobHash.toLowerCase()}` : undefined;
}
export function persistedMedia(result: Awaited<ReturnType<typeof loadProjectResults>>[number]) {
  const kind = result.mediaType?.startsWith('video/') ? 'video' : result.mediaType?.startsWith('audio/') ? 'audio' : undefined;
  const parameters = result.parameters; const durationSeconds = Number(parameters?.durationSeconds);
  if (!kind || !result.blobHash || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return;
  const optional = (key: string) => typeof parameters?.[key] === 'number' ? Number(parameters[key]) : undefined;
  const container = String(parameters?.container ?? 'unbekannt');
  const codecs = String(parameters?.codecs ?? '').split(' + ').filter(Boolean);
  const playable = typeof parameters?.playable === 'boolean' ? parameters.playable : inferMediaPlayable(container, codecs);
  return {
    value: mediaUrl(result.blobHash), blobHash: result.blobHash, mediaType: result.mediaType,
    fileName: typeof parameters?.fileName === 'string' ? parameters.fileName : undefined,
    posterHash: typeof parameters?.posterHash === 'string' ? parameters.posterHash : undefined,
    startFrameHash: typeof parameters?.startFrameHash === 'string' ? parameters.startFrameHash : undefined,
    endFrameHash: typeof parameters?.endFrameHash === 'string' ? parameters.endFrameHash : undefined,
    outputValues: kind === 'video' ? { video: `flowz-cas:${result.blobHash}`, ...(typeof parameters?.startFrameHash === 'string' ? { startFrame: `flowz-cas:${parameters.startFrameHash}` } : {}), ...(typeof parameters?.endFrameHash === 'string' ? { endFrame: `flowz-cas:${parameters.endFrameHash}` } : {}) } : undefined,
    mediaMetadata: { kind, durationSeconds, container, codecs, width: optional('width'), height: optional('height'), fps: optional('fps'), sampleRate: optional('sampleRate'), channels: optional('channels'), playable, ...(typeof parameters?.playbackWarning === 'string' ? { playbackWarning: parameters.playbackWarning } : {}) },
  } satisfies RuntimeDisplay;
}

export function persistedTranscriptionTimestamps(parameters?: Record<string, unknown>): TranscriptionTimestamps | undefined {
  const raw = parameters?.timestampData;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const parse = (value: unknown) => Array.isArray(value) ? value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const candidate = item as Record<string, unknown>;
    return typeof candidate.start === 'number' && typeof candidate.end === 'number' && typeof candidate.text === 'string'
      ? [{ start: candidate.start, end: candidate.end, text: candidate.text }] : [];
  }) : [];
  const record = raw as Record<string, unknown>;
  const segments = parse(record.segments); const words = parse(record.words);
  return segments.length || words.length ? { segments, words } : undefined;
}

export function displayParameters(parameters?: Record<string, unknown>): Record<string, string | number | boolean> | undefined {
  if (!parameters) return;
  const entries = Object.entries(parameters).filter(([, value]) => ['string','number','boolean'].includes(typeof value));
  return entries.length ? Object.fromEntries(entries) as Record<string, string | number | boolean> : undefined;
}
function listRunParameters(parameters?: Record<string, unknown>): Record<string, string | number | boolean> | undefined {
  const direct = ['groupRunId','variantIndex','variantCount','listIndex','listCount'].flatMap((key) => ['string','number'].includes(typeof parameters?.[key]) ? [[key, parameters?.[key]] as const] : []);
  const nested = parameters?.inputFingerprint;
  const value = nested && typeof nested === 'object' && !Array.isArray(nested) ? nested as Record<string, unknown> : {};
  const entries = [...direct, ...['groupRunId','variantIndex','variantCount','listIndex','listCount'].flatMap((key) => ['string','number'].includes(typeof value[key]) ? [[key, value[key]] as const] : [])];
  return entries.length ? Object.fromEntries(entries) as Record<string, string | number | boolean> : undefined;
}

export function resolveConnectedOutput(source: FlowNodeData | undefined, sourceHandle: string | null | undefined, dataType?: DataType): string[] {
  const output = source?.outputValues?.[sourceHandle ?? ''];
  if (Array.isArray(output)) return output;
  if (typeof output === 'string') return [output];
  if (sourceHandle?.startsWith('variant:') || dataType?.endsWith('List') || dataType === 'list') return [];
  return typeof source?.value === 'string' ? [source.value] : [];
}

function executionFingerprint(document: ProjectDocument, displays: ReadonlyMap<string, RuntimeDisplay>, nodeId: string): string {
  const node = document.graph.nodes.find((item) => item.id === nodeId);
  if (!node) return 'missing';
  const inputs = document.graph.edges
    .filter((edge) => edge.targetNodeId === nodeId)
    .sort((left, right) => left.targetPortId.localeCompare(right.targetPortId) || left.order - right.order || left.id.localeCompare(right.id))
    .map((edge) => {
      const source = document.graph.nodes.find((item) => item.id === edge.sourceNodeId);
      const display = displays.get(edge.sourceNodeId);
      const visible = display?.outputValues?.[edge.sourcePortId as keyof NonNullable<RuntimeDisplay['outputValues']>] ?? display?.value;
      const sourceValue = visible ?? (source?.moduleId === 'core.text-input' ? source.config.text : source?.config.blobHash);
      return { sourceNodeId: edge.sourceNodeId, sourcePortId: edge.sourcePortId, targetPortId: edge.targetPortId, order: edge.order, value: sourceValue ?? null };
    });
  return JSON.stringify({ moduleId: node.moduleId, moduleVersion: node.moduleVersion, config: node.config, inputs });
}

export function currentExecutionFingerprint(nodeId: string): string | undefined {
  const state = useFlowStore.getState();
  return state.document ? executionFingerprint(state.document, state.runtimeDisplays, nodeId) : undefined;
}

export function persistedResultMatchesFingerprint(parameters: Record<string, unknown> | undefined, current: string): boolean {
  const direct = parameters?.executionFingerprint;
  const nested = parameters?.inputFingerprint;
  const expected = typeof direct === 'string' ? direct : nested && typeof nested === 'object' && !Array.isArray(nested)
    ? (nested as Record<string, unknown>).executionFingerprint : undefined;
  return typeof expected === 'string' && expected === current;
}
function splitPassiveLines(value: unknown) { return String(value ?? '').split(/[,\n]/).map((item) => item.trim()).filter(Boolean); }

/** Rebuilds config-owned source outputs without relying on a prior UI interaction. */
export function passiveNodeDisplay(project: Pick<ProjectDocument,'id'|'createdAt'>, node: GraphNode): RuntimeDisplay | undefined {
  if (node.moduleId === 'core.text-input') {
    const value = String(node.config.text ?? '');
    return { status:'fresh',value,outputValues:{text:value},persisted:true };
  }
  if (node.moduleId === 'brand.brief') {
    const config=node.config;
    const value=JSON.stringify({artifact:'flowz.brand-brief',version:1,id:`${project.id}:${node.id}:brief`,createdAt:project.createdAt,data:{brandName:String(config.brandName??'').trim(),offer:String(config.offer??'').trim(),audience:String(config.audience??'').trim(),problem:String(config.problem??'').trim(),promise:String(config.promise??'').trim(),personality:splitPassiveLines(config.personality),differentiators:splitPassiveLines(config.differentiators),constraints:splitPassiveLines(config.constraints)}});
    return {status:'fresh',value,outputValues:{brief:value},persisted:true};
  }
  if (node.moduleId === 'brand.artboard') {
    const data = { kind:'artboard',label:node.label,status:'fresh',updatePolicy:node.updatePolicy,...node.config } as FlowNodeData;
    const outputValues = artboardNodeOutputs(data);
    const value = typeof outputValues.artboard === 'string' ? outputValues.artboard : undefined;
    return { status:value?'fresh':'idle',value,outputValues,persisted:true };
  }
}

function withPassiveDisplays(document: ProjectDocument, runtime: ReadonlyMap<string,RuntimeDisplay>) {
  const next=new Map(runtime);
  for(const node of document.graph.nodes){const passive=passiveNodeDisplay(document,node);if(passive)next.set(node.id,{...next.get(node.id),...passive});}
  return next;
}

export function sampleGraph(): ProjectDocument['graph'] {
  const make = (id: string, kind: NodeKind, x: number, y: number, label: string): GraphNode => ({
    id, moduleId: moduleForKind(kind), moduleVersion: 1, position: { x, y }, label,
    config: kind === 'textInput' ? { text: String(registry[kind].defaults.value ?? '') } : { ...registry[kind].defaults } as GraphNode['config'],
    updatePolicy: 'manual',
  });
  return {
    nodes: [
      make('prompt', 'textInput', 90, 120, 'Produktidee'),
      make('generate', 'imageGeneration', 440, 80, 'Key Visual'),
      make('upload', 'imageInput', 90, 480, 'Referenzbild'),
      make('analyse', 'imageAnalysis', 800, 390, 'Visual analysieren'),
    ],
    edges: [
      { id: 'prompt-generate', sourceNodeId: 'prompt', sourcePortId: 'text', targetNodeId: 'generate', targetPortId: 'prompt', order: 0 },
      { id: 'upload-generate', sourceNodeId: 'upload', sourcePortId: 'image', targetNodeId: 'generate', targetPortId: 'reference', order: 0 },
      { id: 'generate-analyse', sourceNodeId: 'generate', sourcePortId: 'image', targetNodeId: 'analyse', targetPortId: 'image', order: 0 },
    ], groups: [],
  };
}

function browserDocument(): ProjectDocument {
  const timestamp = now();
  return { schemaVersion: CURRENT_SCHEMA_VERSION, id: freshId(), name: 'Unbenannter Flow', createdAt: timestamp, updatedAt: timestamp, graph: { nodes: [], edges: [], groups: [] }, canvas: { viewport: { x: 0, y: 0, zoom: 1 } } };
}

function runtimeStatus(projectId: string, node: GraphNode, display?: RuntimeDisplay): NodeStatus {
  if (display?.status === 'stale' || display?.status === 'error' || display?.status === 'temporary') return display.status;
  const state = runtimeStore.nodes.get(runtimeNodeId(projectId, node.id));
  if (state?.status === 'running' || state?.status === 'queued') return 'running';
  if (state?.status === 'error') return 'error';
  if (state?.activeResultId) return 'fresh';
  if (state?.status === 'success') return 'stale';
  return display?.status ?? (registry[kindForModule(node.moduleId) ?? 'unsupported'].inputs.length ? 'stale' : 'idle');
}

function mergeFlowNodes(document: ProjectDocument, runtime: ReadonlyMap<string, RuntimeDisplay>, previous: readonly FlowNode[] = []): FlowNode[] {
  const hydrated=withPassiveDisplays(document,runtime);
  const old = new Map(previous.map((node) => [node.id, node]));
  return document.graph.nodes.map((node) => {
    const display = { ...hydrated.get(node.id), status: runtimeStatus(document.id, node, hydrated.get(node.id)) };
    const adapted = nodeToFlow(node, display);
    const prior = old.get(node.id);
    return prior ? { ...prior, ...adapted, selected: prior.selected, dragging: prior.dragging, measured: prior.measured } : adapted;
  });
}

function mergeFlowEdges(document: ProjectDocument, previous: readonly FlowEdge[] = []): FlowEdge[] {
  const old = new Map(previous.map((edge) => [edge.id, edge]));
  return document.graph.edges.map((edge) => ({ ...old.get(edge.id), ...edgeToFlow(edge, document.graph.nodes) }));
}

function validatedConnection(document: ProjectDocument, connection: Connection, replacingEdgeId?: string): ReturnType<typeof flowEdgeToGraph> | undefined {
  if (!connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) return;
  const source = document.graph.nodes.find((node) => node.id === connection.source);
  const target = document.graph.nodes.find((node) => node.id === connection.target);
  if (!source || !target || source.id === target.id) return;
  const sourceKind = kindForModule(source.moduleId); const targetKind = kindForModule(target.moduleId);
  if (!sourceKind || !targetKind) return;
  const targetPort = connection.targetHandle.split('::')[0];
  const outputValueType=portValueType(sourceKind,'output',connection.sourceHandle),inputValueType=portValueType(targetKind,'input',targetPort);
  if (!outputValueType || !inputValueType || !areValueTypesCompatible(outputValueType,inputValueType)) return;
  const input = registry[targetKind].inputs.find((item) => item.id === targetPort);
  if (!input) return;
  const occupied = document.graph.edges.some((edge) => edge.id !== replacingEdgeId && edge.targetNodeId === target.id && edge.targetPortId === targetPort);
  if (!input.multiple && occupied) return;
  const id = replacingEdgeId ?? `edge-${freshId()}`;
  const candidate = flowEdgeToGraph({ ...connection, id } as FlowEdge, nextInputOrder(document, target.id, targetPort, replacingEdgeId));
  return connectionCreatesCycle(document, candidate, replacingEdgeId) ? undefined : candidate;
}

function legacyBundle(): LegacyImportBundle | undefined {
  if (typeof localStorage === 'undefined') return;
  const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.schemaVersion === 1) return migrateV1ToV2(parsed, now());
  } catch { /* A malformed legacy cache remains untouched for manual recovery. */ }
}

function displaysFromLegacy(bundle: LegacyImportBundle): Map<string, RuntimeDisplay> {
  const displays = new Map<string, RuntimeDisplay>();
  for (const result of bundle.imports.results.filter((item) => item.active)) {
    let runtimeValue: RuntimeValue | undefined;
    if (result.value.kind === 'text') {
      displays.set(result.nodeId, { status: 'temporary', value: result.value.text });
      runtimeValue = { kind: 'scalar', value: { type: 'text', value: result.value.text } };
    }
    else {
      const assetImportId = result.value.assetImportId;
      const asset = bundle.imports.assets.find((item) => item.id === assetImportId);
      if (asset) {
        displays.set(result.nodeId, { status: 'temporary', value: `data:${asset.payload.mediaType};base64,${asset.payload.data}`, fileName: asset.fileName });
        runtimeValue = { kind: 'scalar', value: { type: 'image', assetId: asset.id, mimeType: asset.payload.mediaType } };
      }
    }
    if (runtimeValue) {
      const runId = `legacy-run:${bundle.project.id}:${result.id}`; const fingerprint = `legacy:${result.id}`;
      try {
        runtimeStore.queueRun({ id: runId, nodeId: runtimeNodeId(bundle.project.id, result.nodeId), fingerprintSnapshot: fingerprint, createdAt: result.createdAt ?? bundle.project.updatedAt, startedAt: result.createdAt ?? bundle.project.updatedAt });
        runtimeStore.completeRun(runId, { resultId: result.id, completedAt: result.createdAt ?? bundle.project.updatedAt, currentFingerprint: fingerprint, outputs: { output: runtimeValue } });
      } catch { /* An already-bridged immutable result is safe to reuse. */ }
    }
  }
  for (const cost of bundle.imports.costs) {
    const previous = displays.get(cost.nodeId) ?? {};
    displays.set(cost.nodeId, { ...previous, cost: cost.money.amountMicros / 1_000_000 });
  }
  return displays;
}

async function hydratePersistedResults(
  set: (partial: Partial<FlowState>) => void,
  get: () => FlowState,
  projectId: string,
) {
  if (!isDesktopRuntime()) return;
  const results = await loadProjectResults(projectId);
  if (get().document?.id !== projectId) return;
  const next = new Map(get().runtimeDisplays);
  const orderedResults = [...results].sort((left, right) => Number(right.active) - Number(left.active));
  for (const result of orderedResults) {
    const graphNode=get().document?.graph.nodes.find((node)=>node.id===result.nodeId);if(!graphNode)continue;
    const paidBrandOutputs = hydratePaidBrandOutputs(result.kind, result.textValue, result.parameters);
    const value = result.kind === 'webpage' ? result.textValue : result.dataUrl ?? result.textValue;
    const deferredMedia = Boolean(result.blobHash && result.mediaType);
    if (!value && !deferredMedia) continue;
    const previous = next.get(result.nodeId);
    if(result.active&&result.hydrationError){next.set(result.nodeId,{...previous,status:'error',error:result.hydrationError,history:previous?.history});}
    const rawCostProvenance = result.parameters?.costProvenance;
    const costProvenance: 'actual'|'estimated'|'unknown'|undefined = rawCostProvenance === 'actual' || rawCostProvenance === 'estimated' || rawCostProvenance === 'unknown' ? rawCostProvenance : undefined;
    const activeMedia = result.active ? persistedMedia(result) : undefined;
    const activeImageReference = result.active && result.mediaType?.startsWith('image/') ? casReference(result.blobHash) : undefined;
    const activeImageOutput = activeImageReference ? { image: activeImageReference } : undefined;
    const screenshotReference = result.kind === 'webpage' && result.mediaType?.startsWith('image/') ? casReference(result.blobHash) : undefined;
    const webpageOutputs = result.kind === 'webpage'
      ? { text: result.textValue, ...(screenshotReference ? { image: screenshotReference, screenshot: screenshotReference } : {}) }
      : undefined;
    const history = [...(previous?.history ?? []), {
      id: result.resultId, createdAt: result.createdAt, value: value ?? '',
      runId: String(listRunParameters(result.parameters)?.groupRunId ?? result.runId), costRunId: result.runId,
      ...(result.costMicrounits == null ? {} : { cost: result.costMicrounits / 1_000_000 }),
      ...(costProvenance ? { costProvenance } : {}),
      ...(result.model ? { model: result.model } : {}),
      ...(result.prompt ? { prompt: result.prompt } : {}),
      ...(displayParameters(result.parameters) || listRunParameters(result.parameters) ? { parameters: { ...displayParameters(result.parameters), ...listRunParameters(result.parameters) } } : {}),
      ...(persistedTranscriptionTimestamps(result.parameters) ? { timestamps: persistedTranscriptionTimestamps(result.parameters) } : {}),
      ...(result.assetId ? { assetId: result.assetId } : {}),
      ...(result.blobHash ? { blobHash: result.blobHash } : {}),
      ...(result.mediaType ? { mediaType: result.mediaType } : {}),
      ...(webpageOutputs ? { outputValues: webpageOutputs } : activeImageOutput ? { outputValues: activeImageOutput } : paidBrandOutputs ? { outputValues: paidBrandOutputs.outputValues } : {}),
      persisted: true,
      active: result.active,
    }];
    next.set(result.nodeId, activeMedia ? { ...previous, ...activeMedia, status: 'fresh', persisted: true, assetId: result.assetId, history } : previous?.status === 'fresh' || !result.active || !value ? { ...previous, history } : {
      ...previous, status: 'fresh', value, cost: result.costMicrounits == null ? previous?.cost : result.costMicrounits / 1_000_000, ...(costProvenance ? { costProvenance } : {}),
      ...(webpageOutputs ? { outputValues: webpageOutputs } : activeImageOutput ? { outputValues: activeImageOutput, blobHash: result.blobHash, mediaType: result.mediaType } : paidBrandOutputs ? { outputValues: paidBrandOutputs.outputValues } : {}),
      history, fileName: previous?.fileName, assetId: result.assetId, persisted: true,
    });
  }
  const resultMetadata = new Map(results.map((result) => [result.resultId, result]));
  for (const node of get().document?.graph.nodes ?? []) {
    if (!['ai.image-generation','brand.logo-design'].includes(node.moduleId)) continue;
    const fanOutIds = Array.isArray(node.config.fanOutResultIds) ? node.config.fanOutResultIds.filter((value): value is string => typeof value === 'string') : [];
    const active = results.find((result) => result.nodeId === node.id && result.active && result.mediaType?.startsWith('image/'));
    const groupRunId = listRunParameters(active?.parameters)?.groupRunId;
    const activeRunIds = active ? results.filter((result) => result.nodeId === node.id && result.mediaType?.startsWith('image/') && (groupRunId ? listRunParameters(result.parameters)?.groupRunId === groupRunId : result.runId === active.runId))
      .sort(compareVariantOrder).map((result) => result.resultId) : [];
    const materializedIds = [...new Set([...activeRunIds, ...fanOutIds])];
    if (!materializedIds.length) continue;
    const loaded = await Promise.all(materializedIds.map(async (resultId) => {try{return { resultId, dataUrl: await loadLibraryResultData(projectId, resultId) };}catch{return {resultId,dataUrl:undefined,error:true};}}));
    if (get().document?.id !== projectId) return;
    const previews = new Map(loaded.filter((item): item is { resultId: string; dataUrl: string } => Boolean(item.dataUrl)).map((item) => [item.resultId, item.dataUrl]));
    const references = new Map(materializedIds.flatMap((resultId) => {
      const result = resultMetadata.get(resultId);
      const reference = result?.mediaType?.startsWith('image/') ? casReference(result.blobHash) : undefined;
      return reference ? [[resultId, reference] as const] : [];
    }));
    const previous = next.get(node.id); const history = previous?.history?.map((item) => previews.has(item.id) ? { ...item, value: previews.get(item.id)! } : item);
    const outputValues: Record<string, string | string[] | undefined> = { ...(previous?.outputValues ?? {}) };
    const activeReference = active ? references.get(active.resultId) : undefined;
    if (activeReference) outputValues.image = activeReference;
    else delete outputValues.image;
    if (activeRunIds.length > 1) outputValues.images = activeRunIds.flatMap((resultId) => references.get(resultId) ?? []);
    else delete outputValues.images;
    for (const resultId of fanOutIds) {
      const reference = references.get(resultId);
      if (reference) outputValues[`variant:${resultId}`] = reference;
      else delete outputValues[`variant:${resultId}`];
    }
    const totalCost = groupRunId && active ? (active.costMicrounits ?? 0) / 1_000_000 : previous?.cost;
    next.set(node.id, { ...previous, history, outputValues, cost: totalCost, ...(loaded.some((item)=>'error' in item)?{status:'error' as const,error:'Mindestens ein gespeichertes Bild ist im lokalen CAS nicht lesbar.'}:{}) });
  }
  // Text variants and Map runs share one run identity. Rebuild the ordered typed
  // list output on reload while keeping the deliberately active scalar result.
  for (const node of get().document?.graph.nodes ?? []) {
    if (!['ai.text-generation','ai.image-analysis'].includes(node.moduleId)) continue;
    const active = results.find((result) => result.nodeId === node.id && result.active && typeof result.textValue === 'string');
    if (!active) continue;
    const groupRunId = listRunParameters(active.parameters)?.groupRunId;
    const run = results.filter((result) => result.nodeId === node.id && typeof result.textValue === 'string' && (groupRunId ? listRunParameters(result.parameters)?.groupRunId === groupRunId : result.runId === active.runId))
      .sort(compareVariantOrder);
    const previous = next.get(node.id); const texts = run.map((result) => result.textValue!);
    const expected = Number(listRunParameters(active.parameters)?.variantCount ?? active.parameters?.variantCount ?? run.length); const partial = Number.isFinite(expected) && expected > run.length;
    const totalCost = (active.costMicrounits ?? 0) / 1_000_000;
    const previousOutputs = { ...(previous?.outputValues ?? {}) }; delete previousOutputs.texts;
    next.set(node.id, { ...previous, status: partial ? 'error' : previous?.status, error: partial ? `${run.length}/${expected} Varianten sind gespeichert. Beim nächsten Lauf werden nur fehlende Ergebnisse wiederholt.` : previous?.error, cost: totalCost, outputValues: { ...previousOutputs, text: active.textValue, ...(texts.length > 1 ? { texts } : {}) } });
  }
  for (const node of get().document?.graph.nodes ?? []) {
    if (!['image.transform','image.trim-transparent'].includes(node.moduleId)) continue;
    const active = results.find((result) => result.nodeId === node.id && result.active && result.blobHash && result.mediaType?.startsWith('image/'));
    if (!active?.blobHash) continue;
    const groupRunId = String(listRunParameters(active.parameters)?.groupRunId ?? '');
    const run = results.filter((result) => result.nodeId === node.id && result.blobHash && (!groupRunId || listRunParameters(result.parameters)?.groupRunId === groupRunId))
      .sort(compareVariantOrder);
    const previous=next.get(node.id);const images=run.map((result)=>`flowz-cas:${result.blobHash!}`);const expected=Number(listRunParameters(active.parameters)?.listCount??run.length);
    next.set(node.id,{...previous,status:run.length<expected?'error':previous?.status,error:run.length<expected?`${run.length}/${expected} Bilder sind lokal verarbeitet.`:previous?.error,blobHash:active.blobHash,mediaType:active.mediaType,outputValues:{...(previous?.outputValues??{}),image:`flowz-cas:${active.blobHash}`,images},cost:0,costProvenance:'actual'});
  }
  for (const node of get().document?.graph.nodes ?? []) {
    if (node.moduleId !== 'ai.video-generation') continue;
    const fanOutIds = Array.isArray(node.config.fanOutResultIds) ? node.config.fanOutResultIds.filter((value): value is string => typeof value === 'string') : [];
    const active = results.find((result) => result.nodeId === node.id && result.active && result.mediaType?.startsWith('video/'));
    const groupRunId = String(listRunParameters(active?.parameters)?.groupRunId ?? '') || undefined;
    if (!active) continue;
    const run = results.filter((result) => result.nodeId === node.id && (groupRunId ? listRunParameters(result.parameters)?.groupRunId === groupRunId : result.runId === active.runId) && result.blobHash)
      .sort(compareVariantOrder);
    const previous = next.get(node.id); const videos = run.map((result) => `flowz-cas:${result.blobHash!}`); const expected = Number(listRunParameters(active.parameters)?.variantCount ?? run.length);
    const totalCost = run.reduce((sum, result) => sum + (result.costMicrounits ?? 0), 0) / 1_000_000;
    const outputValues: Record<string, string | string[]> = { ...(previous?.outputValues ?? {}), video: `flowz-cas:${active.blobHash}`, videos };
    for (const resultId of fanOutIds) { const result = resultMetadata.get(resultId); if (result?.blobHash && result.mediaType?.startsWith('video/')) outputValues[`variant:${resultId}`] = `flowz-cas:${result.blobHash}`; }
    next.set(node.id, { ...previous, status: run.length < expected ? 'error' : previous?.status, error: run.length < expected ? `${run.length}/${expected} Videovarianten sind gespeichert.` : previous?.error, cost: totalCost, outputValues });
  }
  // Curated list nodes persist only immutable result IDs in the graph. Their image
  // bytes are materialized on project open, never embedded in project JSON.
  for (const node of get().document?.graph.nodes ?? []) {
    if (node.moduleId !== 'core.image-collection') continue;
    const resultIds = Array.isArray(node.config.collectionResultIds)
      ? node.config.collectionResultIds.filter((value): value is string => typeof value === 'string') : [];
    const loaded = await Promise.all(resultIds.map(async (resultId) => {
      const result = resultMetadata.get(resultId); const dataUrl = await loadLibraryResultData(projectId, resultId).catch(()=>undefined);
      if (!result || !dataUrl || !result.mediaType?.startsWith('image/') || !casReference(result.blobHash)) return;
      return { id: resultId, runId: result.runId, createdAt: result.createdAt, value: dataUrl, assetId: result.assetId, blobHash: result.blobHash, mediaType: result.mediaType, persisted: true } satisfies ImageCollectionItem;
    }));
    if (get().document?.id !== projectId) return;
    const items = loaded.filter(Boolean) as ImageCollectionItem[];
    const outputValues: Record<string, string | string[]> = { images: items.map((item) => casReference(item.blobHash)!) };
    for (const item of items) outputValues[`variant:${item.id}`] = casReference(item.blobHash)!;
    const complete = items.length === resultIds.length;
    next.set(node.id, { status: complete && items.length ? 'fresh' : 'error', value: items[0]?.value, persisted: true, collectionItems: items, outputValues, ...(!complete ? { error: `${resultIds.length-items.length}/${resultIds.length} kuratierte Bilder fehlen.` } : items.length ? {} : { error: 'Die gespeicherte Bildauswahl ist nicht mehr verfügbar.' }) });
  }
  for (const node of get().document?.graph.nodes ?? []) {
    if (node.moduleId !== 'core.video-collection') continue;
    const resultIds = Array.isArray(node.config.collectionResultIds)
      ? node.config.collectionResultIds.filter((value): value is string => typeof value === 'string') : [];
    const items = resultIds.flatMap((resultId) => {
      const result = resultMetadata.get(resultId);
      if (!result?.blobHash || !result.mediaType?.startsWith('video/')) return [];
      return [{ id: resultId, runId: result.runId, createdAt: result.createdAt, value: `flowz-media://localhost/${result.blobHash}`, assetId: result.assetId, blobHash: result.blobHash, mediaType: result.mediaType, parameters: displayParameters(result.parameters), persisted: true } satisfies VideoCollectionItem];
    });
    const outputValues: Record<string, string | string[]> = { videos: items.map((item) => `flowz-cas:${item.blobHash}`) };
    for (const item of items) outputValues[`variant:${item.id}`] = `flowz-cas:${item.blobHash}`;
    const complete = items.length === resultIds.length;
    next.set(node.id, { status: complete && items.length ? 'fresh' : 'error', value: items[0]?.blobHash, blobHash: items[0]?.blobHash, mediaType: items[0]?.mediaType, persisted: true, videoCollectionItems: items, outputValues, ...(!complete ? { error: `${resultIds.length-items.length}/${resultIds.length} kuratierte Videos fehlen.` } : items.length ? {} : { error: 'Die gespeicherte Videoauswahl ist nicht mehr verfügbar.' }) });
  }
  const references = get().document!.graph.nodes.filter((node) => node.moduleId === 'library.asset-text' || node.moduleId === 'library.asset-image');
  for (let offset = 0; offset < references.length; offset += 100) {
    const chunk = references.slice(offset, offset + 100);
    const payloads = await getLibraryAssetContents(chunk.map((node) => String(node.config.assetVersionId ?? '')));
    if (get().document?.id !== projectId) return;
    const byVersion = new Map(payloads.map((payload) => [payload.versionId, payload]));
    for (const node of chunk) {
      const payload = byVersion.get(String(node.config.assetVersionId ?? ''));
      if (!payload) {
        next.set(node.id, { status: 'error', error: 'Die gebundene Asset-Version ist nicht mehr verfügbar.' });
        continue;
      }
      if (payload.kind === 'image') {
        const reference = casReference(payload.blobHash);
        if (!reference) {
          next.set(node.id, { status: 'error', error: 'Die gebundene Bild-Asset-Version hat keine gültige lokale CAS-Referenz.' });
          continue;
        }
        next.set(node.id, {
          status: 'fresh', value: payload.dataUrl ?? mediaUrl(payload.blobHash!), persisted: true,
          assetId: payload.assetId, blobHash: payload.blobHash, mediaType: payload.mediaType,
          outputValues: { image: reference },
        });
      } else if (payload.text) {
        next.set(node.id, { status: 'fresh', value: payload.text, persisted: true, assetId: payload.assetId, outputValues: { text: payload.text } });
      }
    }
  }
  const document = get().document!;
  const activeByNode = new Map(results.filter((result) => result.active).map((result) => [result.nodeId, result]));
  const fingerprintedModules = new Set(['ai.text-generation','ai.image-generation','image.upscale','image.transform','image.trim-transparent','image.background-removal','ai.video-generation','media.video-frame','ai.image-analysis','ai.transcription','context.webpage','context.research',...PAID_BRAND_FINGERPRINTED_MODULES]);
  for (const node of document.graph.nodes) {
    const result = activeByNode.get(node.id);
    if (!result || !fingerprintedModules.has(node.moduleId)) continue;
    const current = executionFingerprint(document, next, node.id); const display = next.get(node.id);
    if (display && !persistedResultMatchesFingerprint(result.parameters, current)) next.set(node.id, { ...display, status: 'stale' });
  }
  set({ runtimeDisplays: next, nodes: mergeFlowNodes(document, next, get().nodes) });
}

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'conflict' | 'error' | 'offline';
type ProjectPhase = 'booting' | 'ready' | 'error';
export type FlowState = {
  phase: ProjectPhase; projectError?: string; document?: ProjectDocument; revision?: number; baseUpdatedAt?: string;
  projects: ProjectSummary[]; projectMenuOpen: boolean; saveState: SaveState; saveError?: string;
  pendingLegacyImports: LegacyImportBundle['imports']; runtimeDisplays: Map<string, RuntimeDisplay>;
  nodes: FlowNode[]; edges: FlowEdge[]; canUndo: boolean; canRedo: boolean;
  initialize: (projectId?: string) => Promise<void>; setProjectMenuOpen: (open: boolean) => void; createAndOpenProject: (name?: string) => Promise<string | undefined>; openExistingProject: (id: string) => Promise<void>;
  retrySave: () => void; reloadAfterConflict: () => Promise<void>; flushPendingSave: () => Promise<number>;
  onNodesChange: (changes: NodeChange<FlowNode>[]) => void; onEdgesChange: (changes: EdgeChange<FlowEdge>[]) => void;
  connect: (connection: Connection) => void; reconnect: (edge: FlowEdge, connection: Connection) => void; deleteEdge: (id: string) => void;
  updateNode: (id: string, patch: Partial<FlowNodeData>, propagate?: boolean) => boolean; addNode: (kind: NodeKind, position?: XYPosition, initialConfig?: Record<string, import('./domain').JsonValue>) => string; deleteNode: (id: string) => void;
  insertTemplate: (template: CanvasTemplate, anchor: XYPosition) => boolean;
  updateNodePolicy: (id: string, policy: UpdatePolicy) => void;
  createGroup: (nodeIds: readonly string[], name?: string) => string | undefined;
  renameGroup: (id: string, name: string) => void;
  ungroup: (id: string) => void;
  deleteGroupNodes: (id: string) => void;
  addImageCollection: (sourceNodeId: string, items: HistoryItem[]) => string | undefined;
  addVideoCollection: (sourceNodeId: string, items: HistoryItem[]) => string | undefined;
  setFanOutResults: (nodeId: string, resultIds: readonly string[]) => boolean;
  bindAssetToNode: (id: string, item: LibraryAssetPayload) => boolean;
  bindDirectMediaToNode: (id: string, binding: DirectMediaBinding) => boolean;
  clearDirectMediaFromNode: (id: string) => boolean;
  activateHistoryResult: (nodeId: string, resultId: string) => Promise<boolean>;
  deleteHistoryResult: (nodeId: string, resultId: string) => Promise<boolean>;
  refreshPersistedResults: () => Promise<void>;
  reset: () => void; inputsFor: (id: string, type: DataType) => string[]; inputsForPort: (id: string, portId: string) => string[]; setViewport: (viewport: Viewport) => void; beginGesture: () => void; endGesture: () => void; undo: () => void; redo: () => void;
};

function armSaveTimer(set: (partial: Partial<FlowState> | ((state: FlowState) => Partial<FlowState>)) => void, get: () => FlowState) {
  if (!isDesktopRuntime() || saveGestureActive) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flushSave(set, get), SAVE_DELAY);
}

function scheduleSave(set: (partial: Partial<FlowState> | ((state: FlowState) => Partial<FlowState>)) => void, get: () => FlowState) {
  changeSequence += 1;
  set({ saveState: isDesktopRuntime() ? 'dirty' : 'offline', saveError: undefined, canUndo: commandBus?.canUndo ?? false, canRedo: commandBus?.canRedo ?? false });
  if (!isDesktopRuntime()) return;
  armSaveTimer(set, get);
}

async function flushSave(set: (partial: Partial<FlowState> | ((state: FlowState) => Partial<FlowState>)) => void, get: () => FlowState): Promise<boolean> {
  if (saveGestureActive) return false;
  if (savePromise) {
    const previousSucceeded = await savePromise;
    return previousSucceeded && get().saveState === 'dirty' ? flushSave(set, get) : previousSucceeded;
  }
  saveTimer = undefined;
  const state = get();
  if (state.saveState === 'saved' || state.saveState === 'offline') return true;
  if (!state.document || state.revision == null || !state.baseUpdatedAt || state.saveState === 'conflict') return false;
  const operation = (async () => {
    const sequence = changeSequence;
    const projectId = state.document!.id;
    set({ saveState: 'saving', saveError: undefined });
    try {
      const saved = await saveProject({ project: state.document!, expectedRevision: state.revision!, expectedUpdatedAt: state.baseUpdatedAt! });
      if (get().document?.id === projectId) set({ revision: saved.revision, baseUpdatedAt: saved.project.updatedAt, saveState: sequence === changeSequence ? 'saved' : 'dirty' });
      return true;
    } catch (error) {
      if (get().document?.id === projectId) {
        if (error instanceof ProjectConflictError) set({ saveState: 'conflict', saveError: error.message });
        else set({ saveState: 'error', saveError: error instanceof Error ? error.message : String(error) });
      }
      return false;
    } finally {
      if (get().saveState === 'dirty' || (get().document?.id === projectId && sequence !== changeSequence && get().saveState !== 'conflict')) {
        armSaveTimer(set, get);
      }
    }
  })();
  savePromise = operation;
  try { return await operation; }
  finally { if (savePromise === operation) savePromise = undefined; }
}

async function prepareProjectSwitch(
  set: (partial: Partial<FlowState> | ((state: FlowState) => Partial<FlowState>)) => void,
  get: () => FlowState,
): Promise<boolean> {
  const state = get();
  if (saveGestureActive) {
    set({ saveError: 'Projektwechsel ist erst möglich, nachdem die laufende Canvas-Geste beendet wurde.', projectMenuOpen: false });
    return false;
  }
  if (state.saveState === 'offline' || state.saveState === 'saved' || state.saveState === 'idle') return true;
  if (state.saveState === 'conflict') {
    set({ saveError: 'Der lokale Stand hat einen Konflikt. Lade ihn bewusst neu oder sichere zuerst eine Recovery-Kopie.', projectMenuOpen: false });
    return false;
  }
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = undefined; }
  if (state.saveState === 'error') set({ saveState: 'dirty' });
  const saved = await flushSave(set, get);
  if (!saved || !['saved', 'offline'].includes(get().saveState)) {
    set({ saveError: get().saveError ?? 'Projektwechsel abgebrochen, weil der aktuelle Stand nicht gespeichert werden konnte.', projectMenuOpen: false });
    return false;
  }
  return true;
}

function replaceDocument(set: (partial: Partial<FlowState>) => void, project: ProjectDocument, revision: number, runtimeDisplays = new Map<string, RuntimeDisplay>(), pendingLegacyImports = EMPTY_IMPORTS) {
  if (saveTimer) clearTimeout(saveTimer);
  saveGestureActive = false;
  changeSequence += 1;
  activeRuns.clear();
  commandBus = new CommandBus(project);
  // CommandBus owns the canonical frozen clone used by its first undo entry. The
  // Zustand document must be that exact instance so WeakMap-coupled asset runtime
  // snapshots also resolve when the very first command is undone after opening.
  const canonical = commandBus.current;
  const hydratedDisplays=withPassiveDisplays(canonical,runtimeDisplays);
  set({ document: canonical, revision, baseUpdatedAt: canonical.updatedAt, runtimeDisplays:hydratedDisplays,
    nodes: mergeFlowNodes(canonical, hydratedDisplays), edges: mergeFlowEdges(canonical), canUndo: false, canRedo: false,
    pendingLegacyImports, phase: 'ready', projectError: undefined, saveState: isDesktopRuntime() ? 'saved' : 'offline', saveError: undefined, projectMenuOpen: false });
}

export const useFlowStore = create<FlowState>((set, get) => {
  const commit = (document: ProjectDocument, schedule = true) => {
    const state = get();
    const runtimeDisplays=withPassiveDisplays(document,state.runtimeDisplays);
    set({ document,runtimeDisplays, nodes: mergeFlowNodes(document, runtimeDisplays, state.nodes), edges: mergeFlowEdges(document, state.edges), canUndo: commandBus?.canUndo ?? false, canRedo: commandBus?.canRedo ?? false });
    if (schedule) scheduleSave(set, get);
  };
  const execute = (command: Parameters<CommandBus['execute']>[0], schedule = true) => {
    if (!commandBus) return;
    commit(commandBus.execute(command), schedule);
  };
  const reconcileAssetModuleChanges = (previous: ProjectDocument, next: ProjectDocument) => {
    const displays = new Map(get().runtimeDisplays);
    const snapshot = assetRuntimeSnapshots.get(next);
    const ids = new Set([...previous.graph.nodes.map((node) => node.id), ...next.graph.nodes.map((node) => node.id)]);
    for (const id of ids) {
      const prior = previous.graph.nodes.find((item) => item.id === id);
      const node = next.graph.nodes.find((item) => item.id === id);
      const changedAssetDefinition = Boolean(prior && node && (
        prior.moduleId !== node.moduleId
        || (isAssetModule(node.moduleId) && String(prior.config.assetVersionId ?? '') !== String(node.config.assetVersionId ?? ''))
      ));
      if (!changedAssetDefinition) continue;
      if (snapshot?.has(id)) {
        const restored = snapshot.get(id);
        if (restored) displays.set(id, restored); else displays.delete(id);
        continue;
      }
      // Asset replacement commands always register exact document-bound snapshots.
      // Missing snapshots must fail closed instead of retaining or globally caching
      // a potentially very large image Data URL.
      displays.delete(id);
    }
    set({ runtimeDisplays: displays });
  };
  const markDownstreamStale = (rootId: string, includeRoot = false) => {
    const state = get(); const next = new Map(state.runtimeDisplays); const queue = [rootId]; const seen = new Set<string>();
    if (includeRoot) {
      seen.add(rootId);
      next.set(rootId, { ...next.get(rootId), status: 'stale' });
    }
    while (queue.length) {
      const current = queue.shift()!;
      state.document?.graph.edges.filter((edge) => edge.sourceNodeId === current).forEach((edge) => {
        if (!seen.has(edge.targetNodeId)) { seen.add(edge.targetNodeId); queue.push(edge.targetNodeId); next.set(edge.targetNodeId, { ...next.get(edge.targetNodeId), status: 'stale' }); }
      });
    }
    set({ runtimeDisplays: next, nodes: state.document ? mergeFlowNodes(state.document, next, state.nodes) : state.nodes });
  };
  return {
    phase: 'booting', projects: [], projectMenuOpen: false, saveState: 'idle', pendingLegacyImports: { assets: [], results: [], costs: [] }, runtimeDisplays: new Map(), nodes: [], edges: [], canUndo: false, canRedo: false,
    initialize: async (requestedProjectId) => {
      if (get().phase !== 'booting') {
        if (requestedProjectId && get().document?.id !== requestedProjectId) await get().openExistingProject(requestedProjectId);
        return;
      }
      try {
        const stagedLegacy = legacyBundle();
        const importedProjectId = typeof localStorage === 'undefined' ? null : localStorage.getItem(LEGACY_IMPORTED_KEY);
        const legacy = importedProjectId ? undefined : stagedLegacy;
        if (!isDesktopRuntime()) {
          const existing = get().document;
          const project = existing && (!requestedProjectId || existing.id === requestedProjectId) ? existing : legacy?.project ?? browserDocument();
          replaceDocument(set, project, 0, legacy ? displaysFromLegacy(legacy) : new Map(), legacy?.imports);
          return;
        }
        const projects = await listProjects(); set({ projects });
        if (requestedProjectId) {
          const opened = await openProject(requestedProjectId);
          const pending = importedProjectId === opened.project.id ? stagedLegacy : undefined;
          replaceDocument(set, opened.project, opened.revision, pending ? displaysFromLegacy(pending) : new Map(), pending?.imports);
          await hydratePersistedResults(set, get, opened.project.id);
          return;
        }
        if (projects.length) {
          const opened = await openProject(projects[0].id);
          const pending = importedProjectId === opened.project.id ? stagedLegacy : undefined;
          replaceDocument(set, opened.project, opened.revision, pending ? displaysFromLegacy(pending) : new Map(), pending?.imports);
          await hydratePersistedResults(set, get, opened.project.id);
          return;
        }
        const created = await createProject(legacy?.project.name ?? 'Mein erster Flow');
        const source = legacy?.project ?? created.project;
        const imported = { ...source, id: created.project.id, createdAt: created.project.createdAt, updatedAt: created.project.updatedAt };
        const saved = await saveProject({ project: imported, expectedRevision: created.revision, expectedUpdatedAt: created.project.updatedAt });
        replaceDocument(set, saved.project, saved.revision, legacy ? displaysFromLegacy(legacy) : new Map(), legacy?.imports);
        await hydratePersistedResults(set, get, saved.project.id);
        if (legacy) {
          localStorage.setItem(LEGACY_IMPORTED_KEY, saved.project.id);
          set({ pendingLegacyImports: legacy.imports });
        }
        set({ projects: await listProjects() });
      } catch (error) {
        // Browser preview persistence may be unavailable (for example a denied
        // localStorage origin). The canvas itself must still remain usable.
        if (!isDesktopRuntime()) replaceDocument(set, browserDocument(), 0);
        else set({ phase: 'error', projectError: error instanceof Error ? error.message : String(error) });
      }
    },
    setProjectMenuOpen: (projectMenuOpen) => set({ projectMenuOpen }),
    createAndOpenProject: async (name = 'Neuer Flow') => {
      const generation = ++openGeneration;
      if (!await prepareProjectSwitch(set, get)) return;
      if (!isDesktopRuntime()) {
        const project = { ...browserDocument(), name };
        replaceDocument(set, project, 0);
        set({ projects: [{ id: project.id, name: project.name, updatedAt: project.updatedAt, revision: 1, diagnosis: 'healthy' }] });
        return project.id;
      }
      try { const opened = await createProject(name); if (generation !== openGeneration) return; replaceDocument(set, opened.project, opened.revision); await hydratePersistedResults(set, get, opened.project.id); set({ projects: await listProjects() }); return opened.project.id; }
      catch (error) { set({ projectError: error instanceof Error ? error.message : String(error) }); }
    },
    openExistingProject: async (id) => {
      const generation = ++openGeneration;
      if (id === get().document?.id) { set({ projectMenuOpen: false }); return; }
      if (!await prepareProjectSwitch(set, get)) return;
      set({ phase: 'booting', projectError: undefined, projectMenuOpen: false });
      try {
        const opened = await openProject(id);
        if (generation !== openGeneration) return;
        const pending = localStorage.getItem(LEGACY_IMPORTED_KEY) === id ? legacyBundle() : undefined;
        replaceDocument(set, opened.project, opened.revision, pending ? displaysFromLegacy(pending) : new Map(), pending?.imports);
        await hydratePersistedResults(set, get, opened.project.id);
      }
      catch (error) { set({ phase: 'error', projectError: error instanceof Error ? error.message : String(error), projectMenuOpen: false }); }
    },
    retrySave: () => { set({ saveState: 'dirty' }); void flushSave(set, get); },
    flushPendingSave: async () => {
      if (!isDesktopRuntime()) throw new Error('Medienimporte sind nur in der Desktop-App verfügbar.');
      if (saveGestureActive) throw new Error('Speichern ist während einer laufenden Canvas-Geste gesperrt. Bitte die Geste zuerst beenden.');
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = undefined; }
      if (get().saveState === 'error') set({ saveState: 'dirty' });
      const saved = await flushSave(set, get);
      const state = get();
      if (!saved || state.saveState !== 'saved' || state.revision == null) {
        throw new Error(state.saveError ?? 'Der aktuelle Flow konnte vor dem Medienimport nicht revisionssicher gespeichert werden.');
      }
      return state.revision;
    },
    reloadAfterConflict: async () => {
      const state = get(); const id = state.document?.id;
      if (!id || !state.document) return;
      const recoveryKey = `flowz-conflict-recovery:${id}:${Date.now()}`;
      localStorage.setItem(recoveryKey, JSON.stringify(state.document));
      const generation = ++openGeneration;
      try {
        const opened = await openProject(id);
        if (generation !== openGeneration) return;
        replaceDocument(set, opened.project, opened.revision);
        await hydratePersistedResults(set, get, opened.project.id);
        set({ saveError: `Serverstand geladen. Der lokale Konfliktstand liegt als Recovery-Kopie unter ${recoveryKey}.` });
      } catch (error) { set({ saveError: error instanceof Error ? error.message : String(error) }); }
    },
    onNodesChange: (changes) => {
      const state = get(); set({ nodes: applyNodeChanges(changes, state.nodes) });
      if (!commandBus) return;
      const structural = structuralNodeChanges(changes);
      if (!structural.positions.size && !structural.removed.length) return;
      const affectedTargets = new Set(structural.removed.flatMap((id) => state.document?.graph.edges.filter((edge) => edge.sourceNodeId === id).map((edge) => edge.targetNodeId) ?? []));
      structural.positions.forEach((position, id) => commandBus?.execute(commands.moveNode(id, position)));
      if (structural.removed.length) commandBus.runTransaction('Nodes löschen', () => structural.removed.forEach((id) => commandBus?.execute(commands.deleteNode(id))));
      commit(commandBus.current);
      affectedTargets.forEach((id) => markDownstreamStale(id, true));
    },
    onEdgesChange: (changes) => {
      const state = get();
      const removedTargets = new Set(removedEdgeIds(changes).map((id) => state.document?.graph.edges.find((edge) => edge.id === id)?.targetNodeId).filter((id): id is string => Boolean(id)));
      set({ edges: applyEdgeChanges(changes, state.edges) });
      const removed = removedEdgeIds(changes);
      if (!removed.length || !commandBus) return;
      commandBus.runTransaction('Verbindungen löschen', () => removed.forEach((id) => commandBus?.execute(commands.disconnect(id))));
      commit(commandBus.current);
      removedTargets.forEach((id) => markDownstreamStale(id, true));
    },
    connect: (connection) => {
      const state = get(); const document = state.document;
      if (!document) return;
      const candidate = validatedConnection(document, connection);
      if (!candidate) { set({ saveError: 'Diese Verbindung ist wegen Typ, Kapazität oder Zyklus nicht zulässig.' }); return; }
      execute(commands.connect(candidate)); markDownstreamStale(candidate.targetNodeId, true);
    },
    reconnect: (edge, connection) => {
      const state = get(); const document = state.document;
      if (!document || !commandBus) return;
      const candidate = validatedConnection(document, connection, edge.id);
      if (!candidate) { set({ saveError: 'Diese neue Verbindung ist wegen Typ, Kapazität oder Zyklus nicht zulässig.' }); return; }
      commandBus.runTransaction('Verbindung neu verbinden', () => { commandBus?.execute(commands.disconnect(edge.id)); commandBus?.execute(commands.connect(candidate)); });
      commit(commandBus.current);
      markDownstreamStale(edge.target, true);
      if (connection.target !== edge.target) markDownstreamStale(connection.target, true);
    },
    deleteEdge: (id) => { const target = get().document?.graph.edges.find((edge) => edge.id === id)?.targetNodeId; execute(commands.disconnect(id)); if (target) markDownstreamStale(target, true); },
    updateNode: (id, patch, propagate = false) => {
      const state = get(); const graphNode = state.document?.graph.nodes.find((node) => node.id === id); if (!graphNode) return false;
      const projectId = state.document!.id;
      const kind = kindForModule(graphNode.moduleId) ?? 'unsupported'; const config = configPatchFor(kind, patch);
      const configChanged = Object.entries(config).some(([key, value]) => JSON.stringify(graphNode.config[key]) !== JSON.stringify(value));
      if (Object.keys(config).length) execute(commands.updateNodeConfig(id, config));
      const currentDocument = get().document;
      if (!currentDocument || currentDocument.id !== projectId) return false;
      const fingerprint = executionFingerprint(currentDocument, get().runtimeDisplays, id);
      let acceptsFreshResult = true;
      if (patch.status === 'running') {
        const runId = `ui-run:${freshId()}`;
        runtimeStore.queueRun({ id: runId, nodeId: runtimeNodeId(projectId, id), fingerprintSnapshot: fingerprint, createdAt: now(), startedAt: now() });
        activeRuns.set(activeRunKey(projectId, id), { runId, fingerprint });
      } else if (patch.status === 'fresh' && typeof patch.value === 'string') {
        const activeKey = activeRunKey(projectId, id);
        const active = activeRuns.get(activeKey);
        if (active) {
          acceptsFreshResult = active.fingerprint === fingerprint;
          const mediaType = kind === 'videoGeneration' || kind === 'videoInput' ? 'video' : ['imageGeneration','imageInput','imageTransform','imageTrimTransparent','imageUpscale','backgroundRemoval','videoFrame','logoDesign'].includes(kind) ? 'image' : undefined;
          const output: RuntimeValue = mediaType
            ? { kind: 'scalar', value: { type: mediaType, assetId: patch.assetId ?? `pending:${id}:${freshId()}`, mimeType: patch.mediaType ?? (patch.value.startsWith('data:image/') ? patch.value.slice(5, patch.value.indexOf(';')) : undefined) } }
            : { kind: 'scalar', value: { type: 'text', value: patch.value } };
          try { runtimeStore.completeRun(active.runId, { resultId: `result:${freshId()}`, completedAt: now(), currentFingerprint: fingerprint, outputs: { output }, ...(patch.cost == null ? {} : { cost: { amountMicros: microUnits(Math.round(patch.cost * 1_000_000)), currency: 'USD', provenance: 'actual' as const } }) }); } catch { /* UI keeps the provider result visible even if a superseded run completed. */ }
          activeRuns.delete(activeKey);
        }
      } else if (patch.status === 'error') {
        const activeKey = activeRunKey(projectId, id);
        const active = activeRuns.get(activeKey);
        if (active) { runtimeStore.failRun(active.runId, { code: 'provider_error', message: patch.error ?? 'Ausführung fehlgeschlagen', retryable: true }, now()); activeRuns.delete(activeKey); }
      }
      const runtimePatch: RuntimeDisplay = {}; for (const key of ['status','value','cost','costProvenance','error','history','fileName','assetId','persisted','outputValues','blobHash','posterHash','startFrameHash','endFrameHash','mediaType','mediaMetadata','collectionItems','videoCollectionItems'] as const) if (patch[key] !== undefined || key === 'error' && 'error' in patch) (runtimePatch as Record<string, unknown>)[key] = patch[key];
      if (patch.status === 'fresh' && !acceptsFreshResult) {
        delete runtimePatch.value;
        delete runtimePatch.cost;
        delete runtimePatch.outputValues;
        delete runtimePatch.assetId;
        delete runtimePatch.persisted;
        runtimePatch.status = 'stale';
      }
      if (runtimePatch.status === 'fresh' && runtimePatch.value !== undefined && patch.persisted !== true) runtimePatch.status = 'temporary';
      if (Object.keys(runtimePatch).length) {
        const next = new Map(get().runtimeDisplays); next.set(id, { ...next.get(id), ...runtimePatch });
        set({ runtimeDisplays: next, nodes: get().document ? mergeFlowNodes(get().document!, next, get().nodes) : get().nodes });
      }
      if (patch.status === 'fresh' && patch.persisted === true) notifyFlowCoverInvalidated(projectId);
      if (propagate || configChanged) markDownstreamStale(id);
      return acceptsFreshResult;
    },
    addNode: (kind, position = { x: 240 + Math.random() * 180, y: 180 + Math.random() * 220 }, initialConfig = {}) => {
      const definition = registry[kind]; const id = `${kind}-${freshId()}`;
      const config = { ...(kind === 'textInput' ? { text: String(definition.defaults.value ?? '') } : definition.defaults), ...initialConfig } as GraphNode['config'];
      execute(commands.addNode({ id, moduleId: moduleForKind(kind), moduleVersion: 1, position, label: definition.label, labelId:`node:${kind}`, config, updatePolicy: 'manual' })); return id;
    },
    insertTemplate: (template, anchor) => {
      if (!commandBus || !get().document) return false;
      try {
        const graph = materializeTemplate(template, anchor);
        commandBus.runTransaction(`Vorlage einsetzen: ${template.name}`, () => {
          graph.nodes.forEach((node) => commandBus?.execute(commands.addNode(node)));
          graph.edges.forEach((edge) => commandBus?.execute(commands.connect(edge)));
          graph.groups.forEach((group) => commandBus?.execute(commands.addGroup(group)));
        });
        commit(commandBus.current);
        return true;
      } catch (error) {
        set({ saveError: error instanceof Error ? error.message : String(error) });
        return false;
      }
    },
    addImageCollection: (sourceNodeId, selected) => {
      const source = get().document?.graph.nodes.find((node) => node.id === sourceNodeId);
      const seen = new Set<string>();
      const items = selected.filter((item) => item.persisted && item.id && item.blobHash && item.mediaType?.startsWith('image/') && !seen.has(item.id) && Boolean(seen.add(item.id))).slice(0, 200);
      if (!source || items.length < 2 || selected.length > 200) return;
      const id = `imageCollection-${freshId()}`;
      execute(commands.addNode({
        id, moduleId: moduleForKind('imageCollection'), moduleVersion: 1,
        position: { x: source.position.x + 370, y: source.position.y + 80 },
        label: `Bildauswahl · ${items.length}`, config: { collectionResultIds: items.map((item) => item.id) }, updatePolicy: 'frozen',
      }));
      const collectionItems: ImageCollectionItem[] = items.map(({ id: resultId, runId, createdAt, assetId, blobHash, mediaType, persisted }) => ({ id: resultId, runId, createdAt, value: mediaUrl(blobHash!), assetId, blobHash, mediaType, persisted }));
      const outputValues: Record<string, string | string[]> = { images: collectionItems.map((item) => `flowz-cas:${item.blobHash}`) };
      for (const item of collectionItems) outputValues[`variant:${item.id}`] = `flowz-cas:${item.blobHash}`;
      const runtimeDisplays = new Map(get().runtimeDisplays);
      runtimeDisplays.set(id, { status: 'fresh', value: collectionItems[0].value, persisted: true, collectionItems, outputValues });
      const document = get().document;
      if (document) set({ runtimeDisplays, nodes: mergeFlowNodes(document, runtimeDisplays, get().nodes) });
      return id;
    },
    addVideoCollection: (sourceNodeId, selected) => {
      const source = get().document?.graph.nodes.find((node) => node.id === sourceNodeId);
      const seen = new Set<string>();
      const items = selected.filter((item) => item.persisted && item.id && item.blobHash && item.mediaType?.startsWith('video/') && !seen.has(item.id) && Boolean(seen.add(item.id))).slice(0, 200);
      if (!source || items.length < 2 || selected.length > 200) return;
      const id = `videoCollection-${freshId()}`;
      execute(commands.addNode({
        id, moduleId: moduleForKind('videoCollection'), moduleVersion: 1,
        position: { x: source.position.x + 370, y: source.position.y + 80 },
        label: `Videoauswahl · ${items.length}`, config: { collectionResultIds: items.map((item) => item.id) }, updatePolicy: 'frozen',
      }));
      const videoCollectionItems: VideoCollectionItem[] = items.map(({ id: resultId, runId, createdAt, assetId, blobHash, mediaType, parameters, persisted }) => ({ id: resultId, runId, createdAt, value: `flowz-media://localhost/${blobHash}`, assetId, blobHash, mediaType, parameters, persisted }));
      const outputValues: Record<string, string | string[]> = { videos: videoCollectionItems.map((item) => `flowz-cas:${item.blobHash}`) };
      for (const item of videoCollectionItems) outputValues[`variant:${item.id}`] = `flowz-cas:${item.blobHash}`;
      const runtimeDisplays = new Map(get().runtimeDisplays);
      runtimeDisplays.set(id, { status: 'fresh', value: videoCollectionItems[0].blobHash, blobHash: videoCollectionItems[0].blobHash, mediaType: videoCollectionItems[0].mediaType, persisted: true, videoCollectionItems, outputValues });
      const document = get().document;
      if (document) set({ runtimeDisplays, nodes: mergeFlowNodes(document, runtimeDisplays, get().nodes) });
      return id;
    },
    setFanOutResults: (nodeId, resultIds) => {
      const state = get(); const graphNode = state.document?.graph.nodes.find((node) => node.id === nodeId); const display = state.runtimeDisplays.get(nodeId);
      const kind = graphNode && kindForModule(graphNode.moduleId);
      if (!graphNode || !display?.history || !kind || !["imageGeneration","videoGeneration","logoDesign"].includes(kind)) return false;
      const history = new Map(display.history.map((item) => [item.id, item]));
      const connected = state.document?.graph.edges.filter((edge) => edge.sourceNodeId === nodeId && edge.sourcePortId.startsWith("variant:")).map((edge) => edge.sourcePortId.slice("variant:".length)) ?? [];
      const selected = [...new Set([...connected, ...resultIds])].filter((id) => {
        const item = history.get(id); return kind === "videoGeneration" ? item?.mediaType?.startsWith("video/") : item?.mediaType?.startsWith("image/");
      });
      if (!selected.length) return false;
      execute(commands.updateNodeConfig(nodeId, { fanOutResultIds: selected }));
      const next = new Map(get().runtimeDisplays); const current = next.get(nodeId); const outputValues = { ...(current?.outputValues ?? {}) };
      for (const key of Object.keys(outputValues)) if (key.startsWith("variant:")) delete outputValues[key];
      for (const id of selected) { const item = history.get(id); if (item?.blobHash) outputValues[`variant:${id}`] = `flowz-cas:${item.blobHash}`; }
      next.set(nodeId, { ...current, outputValues });
      set({ runtimeDisplays: next, nodes: get().document ? mergeFlowNodes(get().document!, next, get().nodes) : get().nodes });
      return true;
    },
    bindAssetToNode: (id, item) => {
      const state = get();
      const graphNode = state.document?.graph.nodes.find((node) => node.id === id);
      const currentKind = graphNode && kindForModule(graphNode.moduleId);
      const value = assetValue(item);
      if (!graphNode || !currentKind || !value || !isCompatibleAssetTarget(item.kind, currentKind)) return false;
      const nextKind = assetNodeKind(item.kind);
      const beforeDocument = state.document!;
      const beforeSnapshots = assetRuntimeSnapshots.get(beforeDocument) ?? new Map<string, RuntimeDisplay | undefined>();
      beforeSnapshots.set(id, state.runtimeDisplays.get(id));
      assetRuntimeSnapshots.set(beforeDocument, beforeSnapshots);
      execute(commands.replaceNodeDefinition(id, {
        moduleId: moduleForKind(nextKind), moduleVersion: 1, label: registry[nextKind].label,labelId:`node:${nextKind}`,
        config: assetNodeConfig(item),
      }));
      const runtimeDisplays = new Map(get().runtimeDisplays);
      const display: RuntimeDisplay = {
        status: 'fresh', value, persisted: true, assetId: item.assetId,
        outputValues: item.kind === 'image' ? { image: value } : { text: value },
      };
      runtimeDisplays.set(id, display);
      const document = get().document;
      if (document) {
        const afterSnapshots = assetRuntimeSnapshots.get(document) ?? new Map<string, RuntimeDisplay | undefined>();
        afterSnapshots.set(id, display);
        assetRuntimeSnapshots.set(document, afterSnapshots);
        set({ runtimeDisplays, nodes: mergeFlowNodes(document, runtimeDisplays, get().nodes) });
      }
      markDownstreamStale(id);
      return true;
    },
    bindDirectMediaToNode: (id, binding) => {
      const state = get();
      const node = state.document?.graph.nodes.find((item) => item.id === id);
      const kind = node && kindForModule(node.moduleId);
      if (!node || !kind || !DIRECT_MEDIA_TARGETS.has(kind) || !isDirectMediaBinding(binding)) return false;
      if (binding.source.kind === 'project-result'
        && (binding.source.projectId !== state.document?.id || binding.source.projectRevision !== state.revision)) return false;
      if (JSON.stringify(node.config.directMedia) === JSON.stringify(binding)) return true;
      execute(commands.updateNodeConfig(
        id,
        { directMedia: binding as unknown as import('./domain').JsonValue },
        { field: 'directMedia', sessionId: freshId() },
      ), false);
      markDownstreamStale(id, true);
      scheduleSave(set, get);
      return true;
    },
    clearDirectMediaFromNode: (id) => {
      const state = get();
      const node = state.document?.graph.nodes.find((item) => item.id === id);
      const kind = node && kindForModule(node.moduleId);
      if (!node || !kind || !DIRECT_MEDIA_TARGETS.has(kind) || node.config.directMedia === undefined) return false;
      const { directMedia: _removed, ...config } = node.config;
      execute(commands.replaceNodeDefinition(id, {
        moduleId: node.moduleId, moduleVersion: node.moduleVersion, label: node.label, labelId: node.labelId, config,
      }), false);
      markDownstreamStale(id, true);
      scheduleSave(set, get);
      return true;
    },
    activateHistoryResult: async (nodeId, resultId) => {
      const state = get(), projectId = state.document?.id;
      const node = state.document?.graph.nodes.find((item) => item.id === nodeId);
      const display = state.runtimeDisplays.get(nodeId), selected = display?.history?.find((item) => item.id === resultId);
      if (!projectId || !node || !display || !selected?.persisted || display.status === 'running') return false;
      const historySnapshot = display.history;
      await setActiveLibraryResult(projectId, nodeId, resultId);
      if (get().document?.id !== projectId) return false;
      const currentDisplay = get().runtimeDisplays.get(nodeId);
      if (currentDisplay?.status === 'running' || !currentDisplay?.history?.some((item) => item.id === resultId)) return false;
      // If a completion landed while the durable activation was in flight, the
      // explicit user choice wins by becoming the final database mutation.
      if (currentDisplay.history !== historySnapshot) await setActiveLibraryResult(projectId, nodeId, resultId);
      const history = currentDisplay.history.map((item) => ({ ...item, active: item.id === resultId }));
      const fanOutIds = Array.isArray(node.config.fanOutResultIds) ? node.config.fanOutResultIds.filter((value): value is string => typeof value === 'string') : [];
      const outputValues = selected.mediaType?.startsWith('image/') ? activatedImageOutputs(history, resultId, fanOutIds)
        : selected.mediaType?.startsWith('video/') ? activatedVideoOutputs(history, resultId, fanOutIds)
          : ['ai.text-generation','ai.image-analysis'].includes(node.moduleId) ? activatedTextOutputs(history, resultId)
            : { [registry[kindForModule(node.moduleId) ?? 'unsupported'].outputs[0]?.id ?? 'output']: selected.value };
      const value = selected.blobHash && selected.mediaType?.startsWith('image/') ? `flowz-media://localhost/${selected.blobHash}`
        : selected.blobHash && selected.mediaType?.startsWith('video/') ? `flowz-media://localhost/${selected.blobHash}` : selected.value;
      const next = new Map(get().runtimeDisplays);
      next.set(nodeId, { ...next.get(nodeId), status: 'fresh', value, blobHash: selected.blobHash, mediaType: selected.mediaType, assetId: selected.assetId, cost: selected.cost, costProvenance: selected.costProvenance, history, outputValues, persisted: true, error: undefined });
      set({ runtimeDisplays: next, nodes: get().document ? mergeFlowNodes(get().document!, next, get().nodes) : get().nodes });
      markDownstreamStale(nodeId);
      notifyFlowCoverInvalidated(projectId);
      return true;
    },
    deleteHistoryResult: async (nodeId, resultId) => {
      const state = get(), projectId = state.document?.id, display = state.runtimeDisplays.get(nodeId);
      const item = display?.history?.find((entry) => entry.id === resultId);
      if (!projectId || !item || item.active) return false;
      const protectedIds = new Set<string>();
      for (const node of state.document?.graph.nodes ?? []) {
        for (const key of ['collectionResultIds','fanOutResultIds']) {
          const ids = node.config[key]; if (Array.isArray(ids)) ids.forEach((id) => { if (typeof id === 'string') protectedIds.add(id); });
        }
        const direct = node.config.directMedia;
        if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
          const source = direct.source;
          if (source && typeof source === 'object' && !Array.isArray(source) && source.kind === 'project-result' && typeof source.resultId === 'string') protectedIds.add(source.resultId);
        }
      }
      await deleteLibraryResult(projectId, resultId, [...protectedIds]);
      if (get().document?.id !== projectId) return false;
      const next = new Map(get().runtimeDisplays), current = next.get(nodeId);
      next.set(nodeId, { ...current, history: current?.history?.filter((entry) => entry.id !== resultId) });
      set({ runtimeDisplays: next, nodes: get().document ? mergeFlowNodes(get().document!, next, get().nodes) : get().nodes });
      return true;
    },
    refreshPersistedResults: async () => {
      const projectId = get().document?.id;
      if (!projectId) return;
      const cleared = new Map([...get().runtimeDisplays].map(([id, display]) => [id, { ...display, history: [] }]));
      set({ runtimeDisplays: cleared, nodes: get().document ? mergeFlowNodes(get().document!, cleared, get().nodes) : get().nodes });
      await hydratePersistedResults(set, get, projectId);
    },
    deleteNode: (id) => {
      const targets = new Set(get().document?.graph.edges.filter((edge) => edge.sourceNodeId === id).map((edge) => edge.targetNodeId) ?? []);
      execute(commands.deleteNode(id));
      targets.forEach((target) => markDownstreamStale(target, true));
    },
    updateNodePolicy: (id, policy) => execute(commands.updateNodePolicy(id, policy)),
    createGroup: (nodeIds, name) => {
      const document = get().document; if (!document) return;
      const assigned = new Set(document.graph.groups.flatMap((group) => group.nodeIds));
      const valid = [...new Set(nodeIds)].filter((id) => document.graph.nodes.some((node) => node.id === id) && !assigned.has(id));
      if (valid.length < 2) return;
      const id = `group-${freshId()}`;
      execute(commands.addGroup({ id, name: name?.trim() || `Workflow ${document.graph.groups.length + 1}`, nodeIds: valid, color: '#ec4899' }));
      return id;
    },
    renameGroup: (id, name) => { const clean = name.trim(); if (clean) execute(commands.updateGroup(id, { name: clean })); },
    ungroup: (id) => execute(commands.deleteGroup(id)),
    deleteGroupNodes: (id) => {
      const group = get().document?.graph.groups.find((item) => item.id === id);
      if (!group || !commandBus) return;
      const targets = new Set(get().document?.graph.edges.filter((edge) => group.nodeIds.includes(edge.sourceNodeId) && !group.nodeIds.includes(edge.targetNodeId)).map((edge) => edge.targetNodeId) ?? []);
      commandBus.runTransaction('Workflow samt Nodes löschen', () => {
        group.nodeIds.forEach((nodeId) => commandBus?.execute(commands.deleteNode(nodeId)));
        commandBus?.execute(commands.deleteGroup(id));
      });
      commit(commandBus.current); targets.forEach((target) => markDownstreamStale(target, true));
    },
    reset: () => {
      if (!commandBus) return;
      execute({ label: 'Beispiel wiederherstellen', apply: (document) => ({ ...document, graph: sampleGraph(), canvas: { viewport: { x: 0, y: 0, zoom: 1 } } }) });
      const document = get().document;
      const runtimeDisplays = new Map<string, RuntimeDisplay>();
      if (document) {
        for (const key of activeRuns.keys()) if (key.startsWith(`${document.id}\0`)) activeRuns.delete(key);
      }
      set({ runtimeDisplays, nodes: document ? mergeFlowNodes(document, runtimeDisplays) : [] });
    },
    inputsFor: (id, type) => {
      const state = get();
      return state.edges.filter((edge) => edge.target === id && edge.data?.dataType === type)
        .sort((a, b) => (a.data?.order ?? 0) - (b.data?.order ?? 0))
        .flatMap((edge) => {
          const source = state.nodes.find((node) => node.id === edge.source)?.data;
          return resolveConnectedOutput(source, edge.sourceHandle, type);
        }).filter((value): value is string => Boolean(value));
    },
    inputsForPort: (id, portId) => {
      const state = get();
      return state.edges.filter((edge) => edge.target === id && edge.targetHandle?.split('::')[0] === portId)
        .sort((a, b) => (a.data?.order ?? 0) - (b.data?.order ?? 0))
        .flatMap((edge) => {
          const source = state.nodes.find((node) => node.id === edge.source)?.data;
          return resolveConnectedOutput(source, edge.sourceHandle, edge.data?.dataType);
        }).filter((value): value is string => Boolean(value));
    },
    setViewport: (viewport) => {
      if (!commandBus || !get().document) return;
      execute({ label: 'Canvas verschieben', coalesceKey: 'canvas-viewport', apply: (document) => {
        const current = document.canvas.viewport; return current.x === viewport.x && current.y === viewport.y && current.zoom === viewport.zoom ? document : { ...document, canvas: { viewport } };
      } });
    },
    beginGesture: () => {
      saveGestureActive = true;
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = undefined; }
    },
    endGesture: () => {
      commandBus?.endCoalescing();
      if (!saveGestureActive) return;
      saveGestureActive = false;
      if (get().saveState === 'dirty') armSaveTimer(set, get);
    },
    undo: () => {
      if (!commandBus?.canUndo || !get().document) return;
      const previous = get().document!; const next = commandBus.undo();
      reconcileAssetModuleChanges(previous, next); commit(next);
    },
    redo: () => {
      if (!commandBus?.canRedo || !get().document) return;
      const previous = get().document!; const next = commandBus.redo();
      reconcileAssetModuleChanges(previous, next); commit(next);
    },
  };
});
