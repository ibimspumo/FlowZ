import { applyWorkspaceOperations } from "../artboard-workspace/repository";
import type { ArtboardWorkspaceOperation } from "../artboard-workspace/types";
import { createArtboardRenderPlan, renderArtboardPreviewPngFromDocument } from "../nodes/brand/artboard-renderer";
import { mediaUrl } from "../persistence/media";
import {
  ARTBOARD_FORMATS,
  MAX_ARTBOARD_LAYERS,
  findBoardPlacement,
  validateArtboardWorkspace,
  type ArtboardBoard,
  type ArtboardLayer,
  type ArtboardPreset,
  type ArtboardWorkspace,
  type InputBinding,
} from "../nodes/brand/artboard-domain";
import type { ArtboardAgentSelection } from "../artboard-agent-ui/types";
import type { ArtboardProposalRepository } from "./proposal-repository";
import { validatePersistedArtboardProposal, type ArtboardImageGenerationIntent, type PersistedArtboardProposal, type ProposalDiffItem, type ResolvedArtboardProposal } from "./proposals";
import { ARTBOARD_READ_TOOLS, validateToolInvocation, type ToolInvocation } from "./tool-contract";
import type { AgentToolResult, ArtboardAgentToolExecutor } from "./types";

const MAX_READ_LAYERS = 100;
const MAX_PREVIEW_ITEMS = 80;

export type RevisionBoundArtboardAgentContext = {
  workspace: ArtboardWorkspace;
  branchId: string;
  revision: { id: string; number: number };
  selection: ArtboardAgentSelection;
};

export interface ArtboardAgentContextProvider {
  /** Must return the exact requested revision or reject; never silently substitutes the current head. */
  getContext(request: { workspaceId: string; branchId: string; expectedRevisionId?: string; expectedRevisionNumber?: number }): Promise<RevisionBoundArtboardAgentContext>;
}

export type RevisionHeadLoader = (workspaceId: string) => Promise<{ workspace: ArtboardWorkspace; branchId: string; revision: { id: string; number: number } } | undefined>;

/** Bridges a canonical revision repository to the tool executor without coupling it to React/App state. */
export class RepositoryArtboardAgentContextProvider implements ArtboardAgentContextProvider {
  constructor(private readonly loadHead: RevisionHeadLoader, private readonly getSelection: (workspaceId: string) => ArtboardAgentSelection) {}
  async getContext(request: { workspaceId: string; branchId: string; expectedRevisionId?: string; expectedRevisionNumber?: number }): Promise<RevisionBoundArtboardAgentContext> {
    const loaded = await this.loadHead(request.workspaceId);
    if (!loaded) throw new Error("Der Artboard-Workspace wurde nicht gefunden.");
    if (loaded.branchId !== request.branchId) throw new Error("Der angeforderte Artboard-Branch wurde nicht gefunden.");
    if (request.expectedRevisionId !== undefined && loaded.revision.id !== request.expectedRevisionId || request.expectedRevisionNumber !== undefined && loaded.revision.number !== request.expectedRevisionNumber) throw new Error("Die exakte Proposal-Revision ist nicht mehr der aktuelle Repository-Head; Wiederaufnahme wird fail-closed beendet.");
    return { ...loaded, selection: clone(this.getSelection(request.workspaceId)) };
  }
}

const clone = <T,>(value: T): T => structuredClone(value);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function shortHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(36);
}

function args(invocation: ToolInvocation) { return invocation.arguments; }
function text(value: unknown) { return String(value); }
function number(value: unknown) { return value as number; }
function ids(value: unknown) { return value as string[]; }
function toolPaint(value:unknown):Extract<ArtboardLayer,{type:"shape"|"container"}>["fill"]{const paint=clone(value) as Extract<ArtboardLayer,{type:"shape"|"container"}>["fill"];if(paint.kind==="solid")paint.color=paint.color.toUpperCase();else paint.stops=paint.stops.map((stop)=>({...stop,color:stop.color.toUpperCase()})) as typeof paint.stops;return paint;}
function toolStyle(value:unknown):ArtboardLayer["style"]{if(value===undefined)return undefined;const style=clone(value) as NonNullable<ArtboardLayer["style"]>;if(style.border)style.border.color=style.border.color.toUpperCase();if(style.shadow)style.shadow.color=style.shadow.color.toUpperCase();return style;}

function verifyContext(context: RevisionBoundArtboardAgentContext, workspaceId: string, branchId: string) {
  validateArtboardWorkspace(context.workspace);
  if (context.workspace.id !== workspaceId || context.branchId !== branchId) throw new Error("Der revisionsgebundene Artboard-Kontext passt nicht zum Werkzeugaufruf.");
}

function publicLayer(layer: ArtboardLayer) {
  const base = { id: layer.id, type: layer.type, name: layer.name, locked: layer.locked, visible: layer.visible, version: layer.version, geometry: clone(layer.geometry), style:clone(layer.style) };
  if (layer.type === "text") return { ...base, text: layer.text.slice(0, 4_000), color: layer.color, fontRef: layer.fontRef, fontFamily:layer.fontFamily,fontHash:layer.fontHash,fontWeight:layer.fontWeight,fontStyle:layer.fontStyle,fontAxes:clone(layer.fontAxes), fontSize: layer.fontSize, align: layer.align };
  if (layer.type === "shape") return { ...base, shape: layer.shape, fill:clone(layer.fill) };
  if (layer.type === "image") return { ...base, bindingId: layer.bindingId, casHash: layer.casHash, assetVersionId:layer.assetVersionId,fit: layer.fit };
  if(layer.type==="container")return {...base,childIds:layer.childIds.slice(0,100),layout:clone(layer.layout),fill:clone(layer.fill)};
  return { ...base, childIds: layer.childIds.slice(0, 100) };
}

function toolLayer(value: Record<string, unknown>, version: number): ArtboardLayer {
  const base = { id: text(value.id), name: text(value.name), locked: Boolean(value.locked), visible: Boolean(value.visible), version, geometry: clone(value.geometry) as ArtboardLayer["geometry"], style:toolStyle(value.style) };
  if (value.type === "text") return { ...base, type: "text", text: text(value.text), color: text(value.color).toUpperCase(), fontRef: value.fontRef === undefined ? undefined : text(value.fontRef),fontFamily:value.fontFamily===undefined?undefined:text(value.fontFamily),fontHash:value.fontHash===undefined?undefined:text(value.fontHash),fontWeight:value.fontWeight===undefined?undefined:number(value.fontWeight),fontStyle:value.fontStyle as "normal"|"italic"|undefined,fontAxes:value.fontAxes===undefined?undefined:clone(value.fontAxes) as Record<string,number>, fontSize: number(value.fontSize), align: value.align as "left" | "center" | "right" };
  if (value.type === "shape") return { ...base, type: "shape", shape: value.shape as "rectangle" | "ellipse", fill: value.fill===undefined?{ kind: "solid", color: text(value.color).toUpperCase() }:toolPaint(value.fill) };
  if (value.type === "image") return { ...base, type: "image", bindingId: value.bindingId === undefined ? undefined : text(value.bindingId), casHash: value.casHash === undefined ? undefined : text(value.casHash),assetVersionId:value.assetVersionId===undefined?undefined:text(value.assetVersionId), fit: value.fit as "cover" | "contain" | "fill" };
  if(value.type==="container")return {...base,type:"container",childIds:ids(value.childIds),layout:clone(value.layout) as Extract<ArtboardLayer,{type:"container"}>["layout"],fill:toolPaint(value.fill)};
  return { ...base, type: "group", childIds: ids(value.childIds) };
}

function boardOrThrow(workspace: ArtboardWorkspace, boardId: string): ArtboardBoard {
  const board = workspace.boards[boardId];
  if (!board) throw new Error(`Board ${boardId} existiert in der gebundenen Revision nicht.`);
  return board;
}

function parentOf(board: ArtboardBoard, layerId: string) {
  return Object.values(board.document.layers).find((layer): layer is Extract<ArtboardLayer, { type: "group"|"container" }> => (layer.type === "group"||layer.type==="container") && layer.childIds.includes(layerId));
}

function validateCandidate(workspace: ArtboardWorkspace, operations: ArtboardWorkspaceOperation[]) {
  const candidate = applyWorkspaceOperations(workspace, operations);
  validateArtboardWorkspace(candidate);
  return candidate;
}

function assertFontReferencesExist(workspace: ArtboardWorkspace, layers: readonly ArtboardLayer[]) {
  const knownHashes = new Set(Object.values(workspace.boards).flatMap((board) => Object.values(board.document.layers)
    .flatMap((layer) => layer.type === "text" && layer.fontHash ? [layer.fontHash] : [])));
  for (const layer of layers) if (layer.type === "text" && layer.fontHash && !knownHashes.has(layer.fontHash)) {
    throw new Error("fontHash verweist auf keinen bereits geladenen Workspace-Font. Für Systemschriften nur fontFamily ohne fontHash senden.");
  }
}

function mutationOperations(invocation: ToolInvocation, workspace: ArtboardWorkspace, createdAt:string): { operations: ArtboardWorkspaceOperation[]; intent?: ArtboardImageGenerationIntent; result: Record<string, unknown> } {
  const value = args(invocation);
  if(invocation.tool==="create_board"||invocation.tool==="duplicate_board_as_variant"){
    const width=number(value.width),height=number(value.height);const preset=(Object.entries(ARTBOARD_FORMATS) as [ArtboardPreset,{width:number;height:number}][]).find(([,format])=>format.width===width&&format.height===height)?.[0];if(!preset)throw new Error("Die Board-Abmessungen entsprechen keinem unterstützten Format.");
    const sourceId=invocation.tool==="duplicate_board_as_variant"?text(value.sourceBoardId):value.sourceBoardId===undefined?workspace.activeBoardId:text(value.sourceBoardId);const source=boardOrThrow(workspace,sourceId);const suffix=shortHash(`${text(value.proposalId)}:${text(value.operationId)}`);const boardId=`board-agent-${suffix}`;if(workspace.boards[boardId])throw new Error("Die deterministische Board-ID ist bereits belegt.");
    const format={preset,width,height};const duplicate=invocation.tool==="duplicate_board_as_variant";const layers=duplicate?clone(source.document.layers):{};
    for(const layer of Object.values(layers)){layer.geometry.width=Math.min(layer.geometry.width,width);layer.geometry.height=Math.min(layer.geometry.height,height);layer.geometry.x=Math.max(0,Math.min(layer.geometry.x,width-layer.geometry.width));layer.geometry.y=Math.max(0,Math.min(layer.geometry.y,height-layer.geometry.height));}
    const board:ArtboardBoard={id:boardId,name:text(value.name),activeRevisionId:`revision-${suffix}`,document:{schemaVersion:1,id:`document-${suffix}`,name:text(value.name),format,paint:duplicate?clone(source.document.paint):{kind:"solid",color:"#FFFFFF"},rootLayerIds:duplicate?clone(source.document.rootLayerIds):[],layers,bindings:duplicate?clone(source.document.bindings):{},tokenRefs:duplicate?clone(source.document.tokenRefs):{}},inputSnapshot:duplicate?{...clone(source.inputSnapshot),id:`snapshot-${suffix}`,createdAt}: {id:`snapshot-${suffix}`,createdAt,bindings:{}},ancestry:{branchId:source.ancestry.branchId,parentBoardId:duplicate?source.id:undefined,sourceRevisionId:duplicate?source.activeRevisionId:undefined},createdAt};
    const placement=findBoardPlacement(workspace,format,source.id);return {operations:[{type:"create-board",board,placement}],result:{boardId,sourceBoardId:source.id,format,placement,kind:duplicate?"variant":"board"}};
  }
  if (invocation.tool === "delete_board") {
    const boardId = text(value.boardId);
    const board = boardOrThrow(workspace, boardId);
    if (Object.keys(workspace.boards).length <= 1) throw new Error("Das letzte Artboard kann nicht entfernt werden.");
    return { operations: [{ type: "delete-board", boardId }], result: { boardId, boardName: board.name, status: "awaiting-explicit-apply" } };
  }
  const boardId = text(value.boardId); const board = boardOrThrow(workspace, boardId);
  if (invocation.tool === "create_layers") {
    const raw = value.layers as Record<string, unknown>[];
    if (Object.keys(board.document.layers).length + raw.length > MAX_ARTBOARD_LAYERS) throw new Error(`Das Board darf höchstens ${MAX_ARTBOARD_LAYERS} Ebenen enthalten.`);
    const existing = new Set(Object.keys(board.document.layers)); const incoming = new Set(raw.map((layer) => text(layer.id)));
    if (incoming.size !== raw.length || [...incoming].some((id) => existing.has(id))) throw new Error("Neue Ebenen brauchen eindeutige, noch unbenutzte IDs.");
    const layers = raw.map((layer) => toolLayer(layer, 1));
    assertFontReferencesExist(workspace, layers);
    for (const layer of layers) if ((layer.type === "group"||layer.type==="container") && layer.childIds.some((id) => !existing.has(id) && !incoming.has(id))) throw new Error(`Container ${layer.id} verweist auf eine unbekannte Ebene.`);
    const childIds = new Set(layers.flatMap((layer) => layer.type === "group"||layer.type==="container" ? layer.childIds : []));
    for (const childId of childIds) if (parentOf(board, childId)) throw new Error(`Ebene ${childId} besitzt bereits eine Gruppe als Elternteil.`);
    const nextLayers = clone(board.document.layers); layers.forEach((layer) => { nextLayers[layer.id] = layer; });
    const roots = [...board.document.rootLayerIds.filter((id) => !childIds.has(id)), ...layers.filter((layer) => !childIds.has(layer.id)).map((layer) => layer.id)];
    const operations: ArtboardWorkspaceOperation[] = [{ type: "set-layer-tree", boardId, layers: nextLayers, rootLayerIds: roots }];
    return { operations, result: { createdLayerIds: layers.map((layer) => layer.id) } };
  }
  if (invocation.tool === "update_layers") {
    const raw = value.layers as Record<string, unknown>[];
    const operations = raw.map((item): ArtboardWorkspaceOperation => {
      const current = board.document.layers[text(item.id)]; if (!current) throw new Error(`Ebene ${text(item.id)} existiert nicht.`);
      const layer = toolLayer(item, current.version + 1); if (layer.type !== current.type) throw new Error(`Der Typ der Ebene ${current.id} darf nicht geändert werden.`);
      if(layer.type==="text"&&current.type==="text"){
        const explicitFamily = typeof item.fontFamily === "string";
        if (!explicitFamily) { layer.fontRef??=current.fontRef;layer.fontFamily??=current.fontFamily;layer.fontHash??=current.fontHash;layer.fontWeight??=current.fontWeight;layer.fontStyle??=current.fontStyle;layer.fontAxes??=clone(current.fontAxes); }
        else if (!layer.fontHash) { delete layer.fontRef; delete layer.fontHash; delete layer.fontAxes; }
        assertFontReferencesExist(workspace, [layer]);
      }
      if(layer.type==="image"&&current.type==="image"&&layer.casHash===current.casHash)layer.assetVersionId??=current.assetVersionId;
      layer.style??=clone(current.style);
      return { type: "update-layer", boardId, layerId: layer.id, patch: layer };
    });
    return { operations, result: { updatedLayerIds: raw.map((item) => text(item.id)) } };
  }
  if (invocation.tool === "delete_layers") {
    const requested = ids(value.layerIds); const deleting = new Set(requested);
    for (const id of requested) if (!board.document.layers[id]) throw new Error(`Ebene ${id} existiert nicht.`);
    const collect = (id: string) => { const layer = board.document.layers[id]; deleting.add(id); if (layer?.type === "group"||layer?.type==="container") layer.childIds.forEach(collect); };
    requested.forEach(collect);
    const operations: ArtboardWorkspaceOperation[] = [];
    for (const layer of Object.values(board.document.layers)) if ((layer.type === "group"||layer.type==="container") && !deleting.has(layer.id) && layer.childIds.some((id) => deleting.has(id))) operations.push({ type: "update-layer", boardId, layerId: layer.id, patch: { childIds: layer.childIds.filter((id) => !deleting.has(id)), version: layer.version + 1 } });
    operations.push({ type: "delete-layers", boardId, layerIds: [...deleting] });
    return { operations, result: { deletedLayerIds: [...deleting] } };
  }
  if (invocation.tool === "duplicate_layers") {
    const requested = ids(value.layerIds);
    for (const id of requested) { const layer = board.document.layers[id]; if (!layer) throw new Error(`Ebene ${id} existiert nicht.`); if (parentOf(board, id)) throw new Error("Verschachtelte Ebenen können nur über ihre Root-Gruppe dupliziert werden."); }
    const nextLayers = clone(board.document.layers); const nextRoots = [...board.document.rootLayerIds]; const duplicateIds: string[] = [];
    for (const sourceId of requested) {
      const remap = new Map<string, string>(); const collect = (id: string) => { const layer = board.document.layers[id]; remap.set(id, `${id.slice(0, 88)}-copy-${shortHash(`${text(value.operationId)}:${id}`)}`); if (layer.type === "group"||layer.type==="container") layer.childIds.forEach(collect); }; collect(sourceId);
      for (const generated of remap.values()) if (nextLayers[generated]) throw new Error("Die deterministische Duplikat-ID kollidiert mit einer vorhandenen Ebene.");
      for (const [oldId, newId] of remap) { const source = board.document.layers[oldId]; const layer = clone(source); layer.id = newId; layer.name = oldId === sourceId ? `${source.name} Kopie` : source.name; layer.version = 1; if (layer.type === "group"||layer.type==="container") layer.childIds = layer.childIds.map((id) => remap.get(id)!); layer.geometry.x = Math.min(board.document.format.width - layer.geometry.width, layer.geometry.x + 24); layer.geometry.y = Math.min(board.document.format.height - layer.geometry.height, layer.geometry.y + 24); nextLayers[newId] = layer; }
      const id = remap.get(sourceId)!; const rootIndex = nextRoots.indexOf(sourceId) + 1; nextRoots.splice(rootIndex, 0, id); duplicateIds.push(id);
    }
    return { operations: [{ type: "set-layer-tree", boardId, layers: nextLayers, rootLayerIds: nextRoots }], result: { duplicatedLayerIds: duplicateIds } };
  }
  if (invocation.tool === "reorder_layers") {
    const requested = ids(value.layerIds);const parent=parentOf(board,requested[0]);const siblings=parent?parent.childIds:board.document.rootLayerIds;if(requested.some((id)=>!siblings.includes(id)||parentOf(board,id)?.id!==parent?.id))throw new Error("Neu angeordnete Ebenen müssen dieselbe Eltern-Ebene besitzen.");
    const positions = requested.map((id) => siblings.indexOf(id)).sort((a, b) => a - b); const desired = [...siblings]; positions.forEach((position, index) => { desired[position] = requested[index]; });
    const operations: ArtboardWorkspaceOperation[] = []; const current = [...siblings];
    for (let index = 0; index < desired.length; index += 1) { const wanted = desired[index]; while (current.indexOf(wanted) > index) { operations.push({ type: "reorder-layer", boardId, layerId: wanted, direction: "backward" }); const old = current.indexOf(wanted); current.splice(old, 1); current.splice(old - 1, 0, wanted); } }
    return { operations, result: { rootLayerIds: desired } };
  }
  if (invocation.tool === "set_board_properties") {
    const operations: ArtboardWorkspaceOperation[] = [];
    if (value.name !== undefined) operations.push({ type: "rename-board", boardId, name: text(value.name) });
    if (value.backgroundColor !== undefined) operations.push({ type: "set-board-paint", boardId, color: text(value.backgroundColor).toUpperCase() });
    if (value.width !== undefined || value.height !== undefined) {
      if (value.width === undefined || value.height === undefined) throw new Error("Breite und Höhe müssen gemeinsam gesetzt werden.");
      const preset = (Object.entries(ARTBOARD_FORMATS) as [ArtboardPreset, { width: number; height: number }][]).find(([, format]) => format.width === value.width && format.height === value.height)?.[0];
      if (!preset) throw new Error("Die Abmessungen entsprechen keinem unterstützten Artboard-Preset.");
      operations.push({ type: "set-board-format", boardId, format: { preset, width: number(value.width), height: number(value.height) } });
    }
    return { operations, result: { changed: operations.map((operation) => operation.type) } };
  }
  if (invocation.tool === "bind_layer_resource") {
    const layerId = text(value.layerId); const layer = board.document.layers[layerId]; if (!layer || layer.type !== "image") throw new Error("Nur eine vorhandene Bildebene kann an eine Ressource gebunden werden.");
    const bindingId = text(value.bindingId); if (!board.document.bindings[bindingId]) throw new Error(`Binding ${bindingId} existiert nicht.`);
    const layers = clone(board.document.layers); const bound = clone(layer); bound.bindingId = bindingId; delete bound.casHash; bound.version += 1; layers[layerId] = bound;
    return { operations: [{ type: "set-layer-tree", boardId, rootLayerIds: clone(board.document.rootLayerIds), layers }], result: { layerId, bindingId } };
  }
  if (invocation.tool === "propose_image_generation") {
    const referenceBindingIds = ids(value.referenceBindingIds); for (const id of referenceBindingIds) if (!board.document.bindings[id]) throw new Error(`Referenz-Binding ${id} existiert nicht.`);
    const intent: ArtboardImageGenerationIntent = { id: `fal-intent-${shortHash(text(value.operationId))}`, provider: "fal.ai", boardId, prompt: text(value.prompt), role: text(value.role), aspectRatio: text(value.aspectRatio), referenceBindingIds, requiresExplicitConfirmation: true };
    return { operations: [], intent, result: { intentId: intent.id, provider: intent.provider, status: "awaiting-explicit-paid-confirmation", generated: false } };
  }
  throw new Error(`Werkzeug ${invocation.tool} ist keine unterstützte Mutation.`);
}

function describeChanges(before: ArtboardWorkspace, after: ArtboardWorkspace, intents: ArtboardImageGenerationIntent[]): ProposalDiffItem[] {
  const changes: ProposalDiffItem[] = [];
  for (const boardId of new Set([...Object.keys(before.boards), ...Object.keys(after.boards)])) {
    const oldBoard = before.boards[boardId]; const nextBoard = after.boards[boardId]; const boardName = nextBoard?.name ?? oldBoard?.name;
    if (!oldBoard && nextBoard) { changes.push({ id: `board:${boardId}`, label: `Board „${nextBoard.name}“ hinzufügen`, kind: "add", boardName }); continue; }
    if (oldBoard && !nextBoard) { changes.push({ id: `board:${boardId}`, label: `Board „${oldBoard.name}“ entfernen`, kind: "remove", boardName }); continue; }
    if (!oldBoard || !nextBoard) continue;
    if (oldBoard.name !== nextBoard.name) changes.push({ id: `board-name:${boardId}`, label: "Board umbenennen", kind: "change", boardName, before: oldBoard.name, after: nextBoard.name });
    if (canonical(oldBoard.document.paint) !== canonical(nextBoard.document.paint)) changes.push({ id: `board-paint:${boardId}`, label: "Hintergrund ändern", kind: "change", boardName, before: canonical(oldBoard.document.paint), after: canonical(nextBoard.document.paint) });
    for (const layerId of new Set([...Object.keys(oldBoard.document.layers), ...Object.keys(nextBoard.document.layers)])) {
      const oldLayer = oldBoard.document.layers[layerId]; const nextLayer = nextBoard.document.layers[layerId];
      if (!oldLayer && nextLayer) changes.push({ id: `layer:${boardId}:${layerId}`, label: `Ebene „${nextLayer.name}“ hinzufügen`, kind: "add", boardName });
      else if (oldLayer && !nextLayer) changes.push({ id: `layer:${boardId}:${layerId}`, label: `Ebene „${oldLayer.name}“ entfernen`, kind: "remove", boardName });
      else if (canonical(oldLayer) !== canonical(nextLayer)) changes.push({ id: `layer:${boardId}:${layerId}`, label: `Ebene „${nextLayer!.name}“ ändern`, kind: "change", boardName });
    }
  }
  for (const intent of intents) changes.push({ id: intent.id, label: `Kostenpflichtige Bildgenerierung „${intent.role}“ vorbereiten`, kind: "add", boardName: before.boards[intent.boardId]?.name });
  return changes;
}

function summary(changes: readonly ProposalDiffItem[]) {
  if (!changes.length) return "Keine Artboard-Änderungen vorgeschlagen.";
  const counts = { add: 0, change: 0, remove: 0 }; changes.forEach((item) => { counts[item.kind] += 1; });
  return `${changes.length} Änderung${changes.length === 1 ? "" : "en"}: ${counts.add} neu, ${counts.change} angepasst, ${counts.remove} entfernt.`;
}

type VisualReviewEvidence = { kind: "visual-review"; boardId: string; operationCount: number; mutationReceiptCount: number; width: number; height: number; reviewedAt: string };
function visualReview(value: unknown): value is VisualReviewEvidence { return Boolean(value && typeof value === "object" && (value as { kind?: unknown }).kind === "visual-review"); }

export class PersistentArtboardAgentToolExecutor implements ArtboardAgentToolExecutor {
  private queues = new Map<string, Promise<unknown>>();
  constructor(private readonly contextProvider: ArtboardAgentContextProvider, private readonly proposals: ArtboardProposalRepository, private readonly now = () => new Date()) {}

  private serialized<T>(proposalId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(proposalId) ?? Promise.resolve(); const next = previous.catch(() => undefined).then(work);
    this.queues.set(proposalId, next); void next.finally(() => { if (this.queues.get(proposalId) === next) this.queues.delete(proposalId); }).catch(() => undefined); return next;
  }

  async execute(invocation: ToolInvocation): Promise<AgentToolResult> {
    const checked = validateToolInvocation(invocation, { calls: 0, mutations: 0 }).invocation;
    if ((ARTBOARD_READ_TOOLS as readonly string[]).includes(checked.tool)) {
      const proposalId = checked.tool === "render_preview" && typeof args(checked).proposalId === "string" ? text(args(checked).proposalId) : undefined;
      return proposalId ? this.serialized(proposalId, () => this.read(checked)) : this.read(checked);
    }
    const proposalId = text(args(checked).proposalId);
    return this.serialized(proposalId, () => this.write(checked));
  }

  private async context(invocation: ToolInvocation, revision?: { id?: string; number?: number }) {
    const value = args(invocation); const context = await this.contextProvider.getContext({ workspaceId: text(value.workspaceId), branchId: text(value.branchId), expectedRevisionId: revision?.id, expectedRevisionNumber: revision?.number });
    verifyContext(context, text(value.workspaceId), text(value.branchId));
    if (revision?.id !== undefined && context.revision.id !== revision.id || revision?.number !== undefined && context.revision.number !== revision.number) throw new Error("Die angeforderte Artboard-Revision ist nicht mehr exakt verfügbar; der Vorschlag wird aus Sicherheitsgründen nicht fortgesetzt.");
    return context;
  }

  private async read(invocation: ToolInvocation): Promise<AgentToolResult> {
    const context = await this.context(invocation); const value = args(invocation); let workspace = context.workspace;
    if (invocation.tool === "get_workspace_info") return { content: { workspaceId: workspace.id, name: workspace.name, revision: context.revision, boards: Object.values(workspace.boards).slice(0, 64).map((board) => ({ id: board.id, name: board.name, revisionId: board.activeRevisionId, format: board.document.format, layerCount: Object.keys(board.document.layers).length, placement: workspace.placements[board.id] })) } };
    if (invocation.tool === "get_selection") return { content: clone(context.selection) };
    if (invocation.tool === "get_board") { const board = boardOrThrow(workspace, text(value.boardId)); return { content: { id: board.id, name: board.name, revisionId: board.activeRevisionId, format: board.document.format, background:clone(board.document.paint), rootLayerIds: board.document.rootLayerIds.slice(0, MAX_READ_LAYERS), layerCount: Object.keys(board.document.layers).length, bindingIds: Object.keys(board.document.bindings).slice(0, MAX_READ_LAYERS) } }; }
    if (invocation.tool === "get_layer_tree") { const board = boardOrThrow(workspace, text(value.boardId)); const node = (id: string, depth: number): unknown => { const layer = board.document.layers[id]; return { id, type: layer.type, name: layer.name, visible: layer.visible, locked: layer.locked, ...((layer.type === "group"||layer.type==="container") && depth < 6 ? { children: layer.childIds.slice(0, MAX_READ_LAYERS).map((child) => node(child, depth + 1)) } : {}) }; }; return { content: { boardId: board.id, roots: board.document.rootLayerIds.slice(0, MAX_READ_LAYERS).map((id) => node(id, 1)) } }; }
    if (invocation.tool === "get_layers") { const wanted = ids(value.layerIds); const found: unknown[] = []; for (const board of Object.values(workspace.boards)) for (const id of wanted) if (board.document.layers[id]) found.push({ boardId: board.id, ...publicLayer(board.document.layers[id]) }); if (found.length !== wanted.length) throw new Error("Mindestens eine angeforderte Ebene fehlt oder ihre ID ist nicht workspaceweit eindeutig."); return { content: { layers: found } }; }
    if (invocation.tool === "get_bound_inputs") { const wanted = ids(value.bindingIds); const found: unknown[] = []; for (const board of Object.values(workspace.boards)) for (const id of wanted) { const binding = board.document.bindings[id]; if (binding) found.push({ boardId: board.id, ...clone(binding) }); } if (found.length !== wanted.length) throw new Error("Mindestens ein angefordertes Binding fehlt oder ist nicht eindeutig."); return { content: { bindings: found } }; }
    let previewDraft: PersistedArtboardProposal | undefined;
    if (value.proposalId !== undefined) {
      const draft = await this.proposals.findProposal(text(value.proposalId));
      if (!draft) throw new Error("Der angeforderte Proposal-Entwurf wurde nicht gefunden.");
      validatePersistedArtboardProposal(draft);
      if (draft.workspaceId !== context.workspace.id || draft.branchId !== context.branchId || draft.expectedRevisionId !== context.revision.id || draft.expectedRevisionNumber !== context.revision.number) throw new Error("Die Vorschau gehört nicht zur aktuellen gebundenen Proposal-Revision.");
      workspace = validateCandidate(context.workspace, draft.operations);
      previewDraft = draft;
    }
    const previewBoardId = text(value.boardId);
    const removalPreview = Boolean(previewDraft && !workspace.boards[previewBoardId] && previewDraft.operations.some((operation) => operation.type === "delete-board" && operation.boardId === previewBoardId));
    const board = removalPreview ? boardOrThrow(context.workspace, previewBoardId) : boardOrThrow(workspace, previewBoardId);const viewportWidth=number(value.width),viewportHeight=number(value.height);const scale=Math.min(viewportWidth/board.document.format.width,viewportHeight/board.document.format.height);const offsetX=(viewportWidth-board.document.format.width*scale)/2,offsetY=(viewportHeight-board.document.format.height*scale)/2;const plan=createArtboardRenderPlan(board.document);
    const previewItems=plan.layers.map((layer)=>({id:layer.id,type:layer.type,name:layer.name,x:Math.round(offsetX+layer.geometry.x*scale),y:Math.round(offsetY+layer.geometry.y*scale),width:Math.round(layer.geometry.width*scale),height:Math.round(layer.geometry.height*scale),rotation:layer.geometry.rotation,zIndex:layer.zIndex,paint:layer.type==="shape"||layer.type==="container"?clone(layer.fill):undefined,color:layer.type==="text"?layer.color:undefined,style:clone(layer.style),layout:layer.type==="container"?clone(layer.layout):undefined}));
    const imageDataUrl = typeof window === "undefined" ? undefined : await renderArtboardPreviewPngFromDocument(board.document, mediaUrl, number(value.width), number(value.height));
    if (previewDraft) {
      if (previewDraft.state !== "draft" || previewDraft.operations.length < 1) throw new Error("Nur ein aktiver Proposal-Entwurf mit Änderungen kann visuell geprüft werden.");
      if (previewDraft.receipts.length >= 96) throw new Error("Das Belegbudget dieses Artboard-Vorschlags ist ausgeschöpft.");
      const mutationReceiptCount = previewDraft.receipts.filter((receipt) => !visualReview(receipt.result)).length;
      const reviewedAt = this.now().toISOString(); const evidence: VisualReviewEvidence = { kind: "visual-review", boardId: board.id, operationCount: previewDraft.operations.length, mutationReceiptCount, width: viewportWidth, height: viewportHeight, reviewedAt };
      previewDraft.receipts.push({ operationId: `visual-preview-${shortHash(`${previewDraft.proposalId}:${previewDraft.receipts.length}:${board.id}`)}`, payloadFingerprint: canonical({ tool: invocation.tool, arguments: value }), result: evidence }); previewDraft.updatedAt = reviewedAt; await this.proposals.saveProposal(previewDraft);
    }
    return { content: { kind: "structured-artboard-preview", renderer:"canonical-v2", boardId: board.id, proposalId: value.proposalId, removalPreview, width:viewportWidth, height:viewportHeight, contentBounds:{x:Math.round(offsetX),y:Math.round(offsetY),width:Math.round(board.document.format.width*scale),height:Math.round(board.document.format.height*scale)}, background:clone(board.document.paint), items: previewItems.slice(0, MAX_PREVIEW_ITEMS), truncated: previewItems.length > MAX_PREVIEW_ITEMS }, imageDataUrl };
  }

  private async write(invocation: ToolInvocation): Promise<AgentToolResult> {
    const value = args(invocation); const proposalId = text(value.proposalId); const operationId = text(value.operationId); const fingerprint = canonical({ tool: invocation.tool, arguments: value });
    let draft = await this.proposals.findProposal(proposalId);
    if (draft) validatePersistedArtboardProposal(draft);
    if (draft) {
      const receipt = draft.receipts.find((item) => item.operationId === operationId); if (receipt) { if (receipt.payloadFingerprint !== fingerprint) throw new Error("operationId wurde bereits mit einem anderen Tool-Payload verwendet."); return { content: clone(receipt.result), proposalId }; }
      if (draft.state === "frozen") throw new Error("Der Vorschlag ist bereits abgeschlossen und unveränderlich.");
      if (draft.workspaceId !== value.workspaceId || draft.branchId !== value.branchId || draft.expectedRevisionNumber !== value.expectedRevision) throw new Error("Der Tool-Aufruf passt nicht zur gebundenen Proposal-Revision.");
    }
    const context = await this.context(invocation, draft ? { id: draft.expectedRevisionId, number: draft.expectedRevisionNumber } : { number: number(value.expectedRevision) });
    if (!draft) {
      const timestamp = this.now().toISOString(); draft = { proposalId, workspaceId: context.workspace.id, branchId: context.branchId, expectedRevisionId: context.revision.id, expectedRevisionNumber: context.revision.number, state: "draft", operations: [], imageGenerationIntents: [], receipts: [], createdAt: timestamp, updatedAt: timestamp };
    }
    const before = context.workspace; const current = validateCandidate(before, draft.operations);
    let result: unknown;
    if (invocation.tool === "finish_working") {
      const reviews = draft.receipts.map((receipt) => receipt.result).filter(visualReview); const changedBoards = new Set(draft.operations.map((operation) => operation.type === "create-board" ? operation.board.id : "boardId" in operation ? operation.boardId : undefined).filter((id): id is string => Boolean(id)));
      if (!draft.operations.length || [...changedBoards].some((boardId) => !reviews.some((review) => review.boardId === boardId && review.operationCount === draft.operations.length))) throw new Error("Jedes geänderte Board muss nach der letzten Proposal-Operation mit render_preview visuell geprüft werden.");
      const firstReview = reviews[0]; const mutationReceiptCount = draft.receipts.filter((receipt) => !visualReview(receipt.result)).length; if (!firstReview || mutationReceiptCount - firstReview.mutationReceiptCount > 1) throw new Error("Nach der ersten visuellen Prüfung ist höchstens eine gezielte Korrekturoperation erlaubt.");
      const changes = describeChanges(before, current, draft.imageGenerationIntents); const resolved: ResolvedArtboardProposal = { proposalId, summary: summary(changes), batch: { operationId: `agent-${proposalId.slice(0, 90)}-${shortHash(proposalId)}`, expectedRevisionId: draft.expectedRevisionId, expectedRevisionNumber: draft.expectedRevisionNumber, operations: clone(draft.operations) }, changes, ...(draft.imageGenerationIntents.length ? { warnings: ["Bildgenerierungen werden nicht automatisch gestartet und benötigen eine separate Kostenbestätigung."], followUpIntents: clone(draft.imageGenerationIntents) } : {}) };
      draft.state = "frozen"; draft.resolved = resolved; result = { frozen: true, summary: resolved.summary, changeCount: changes.length, paidFollowUpCount: draft.imageGenerationIntents.length };
    } else {
      const mutation = mutationOperations(invocation, current, draft.createdAt); validateCandidate(current, mutation.operations); draft.operations.push(...clone(mutation.operations)); if (mutation.intent) draft.imageGenerationIntents.push(clone(mutation.intent)); result = mutation.result;
    }
    if (draft.operations.length > 80 || draft.imageGenerationIntents.length > 24 || draft.receipts.length >= 96) throw new Error("Das Gesamtbudget dieses Artboard-Vorschlags ist ausgeschöpft.");
    draft.receipts.push({ operationId, payloadFingerprint: fingerprint, result: clone(result) }); draft.updatedAt = this.now().toISOString(); await this.proposals.saveProposal(draft);
    return { content: result, proposalId };
  }
}

export function createProposalResolver(repository: ArtboardProposalRepository) {
  return async (proposalId: string): Promise<ResolvedArtboardProposal> => {
    const proposal = await repository.findProposal(proposalId);
    if (!proposal) throw new Error("Der Artboard-Vorschlag wurde nicht gefunden. Der Lauf kann nicht sicher wiederhergestellt werden.");
    validatePersistedArtboardProposal(proposal);
    if (proposal.state !== "frozen" || !proposal.resolved) throw new Error("Der Artboard-Vorschlag ist nach dem Neustart noch unvollständig und kann nicht angewendet werden.");
    return clone(proposal.resolved);
  };
}
