export const ARTBOARD_DOCUMENT_VERSION = 1 as const;
export const ARTBOARD_WORKSPACE_VERSION = 1 as const;
export const MAX_ARTBOARD_LAYERS = 300;
export const MAX_ARTBOARD_DEPTH = 6;
export const MAX_ARTBOARD_DIMENSION = 32_768;
export const MAX_PASTEBOARD_COORDINATE = 1_000_000;

export const ARTBOARD_FORMATS = {
  "instagram-post": { label: "Instagram Post", width: 1080, height: 1080 },
  "instagram-story": { label: "Instagram Story", width: 1080, height: 1920 },
  "youtube-thumbnail": { label: "YouTube Thumbnail", width: 1920, height: 1080 },
  "meta-ad": { label: "Meta Ad", width: 1200, height: 628 },
} as const;

export type ArtboardPreset = keyof typeof ARTBOARD_FORMATS;
export type ArtboardFormat = { preset: ArtboardPreset; width: number; height: number };
export type ArtboardGeometry = { x: number; y: number; width: number; height: number; rotation: number };
export type ArtboardPaint =
  | { kind: "solid"; color: string }
  | { kind: "linear-gradient"; angle: number; stops: [{ color: string; offset: number }, { color: string; offset: number }] };
export type ArtboardLayerStyle = {
  opacity?: number;
  border?: { width: number; color: string };
  borderRadius?: number;
  shadow?: { x: number; y: number; blur: number; color: string; opacity: number };
};
export type ArtboardContainerLayout =
  | { mode: "free"; padding: number }
  | { mode: "flex"; direction: "row" | "column"; gap: number; padding: number; justify: "start" | "center" | "end" | "space-between"; align: "start" | "center" | "end" | "stretch" }
  | { mode: "grid"; columns: number; gap: number; padding: number; align: "start" | "center" | "end" | "stretch" };
export type InputBinding = {
  id: string;
  source: { projectId: string; nodeId: string; portId: string; resultId: string };
  snapshot:
    | { kind: "cas"; hash: string }
    | { kind: "artifact"; artifactType: string; artifactHash: string };
  mode: "live" | "pinned";
};
export type ArtboardTokenRefs = {
  palette?: { artifactId: string; snapshotHash: string };
  fonts?: { artifactId: string; snapshotHash: string };
};
type BaseLayer = {
  id: string;
  name: string;
  locked: boolean;
  visible: boolean;
  version: number;
  geometry: ArtboardGeometry;
  style?: ArtboardLayerStyle;
};
export type GroupLayer = BaseLayer & { type: "group"; childIds: string[] };
/** A safe, structured DOM-like layout box. Children are positioned relative to its content box. */
export type ContainerLayer = BaseLayer & { type: "container"; childIds: string[]; layout: ArtboardContainerLayout; fill: ArtboardPaint };
export type TextLayer = BaseLayer & {
  type: "text";
  text: string;
  color: string;
  fontRef?: string;
  fontFamily?: string;
  fontHash?: string;
  fontWeight?: number;
  fontStyle?: "normal" | "italic";
  fontAxes?: Record<string, number>;
  fontSize: number;
  align: "left" | "center" | "right";
};
export type ImageLayer = BaseLayer & {
  type: "image";
  bindingId?: string;
  casHash?: string;
  /** Immutable library provenance when the CAS image was inserted from Assets. */
  assetVersionId?: string;
  fit: "cover" | "contain" | "fill";
};
export type ShapeLayer = BaseLayer & {
  type: "shape";
  shape: "rectangle" | "ellipse";
  fill: ArtboardPaint;
};
export type ArtboardLayer = GroupLayer | ContainerLayer | TextLayer | ImageLayer | ShapeLayer;
export type ArtboardDocument = {
  schemaVersion: typeof ARTBOARD_DOCUMENT_VERSION;
  id: string;
  name: string;
  format: ArtboardFormat;
  paint: ArtboardPaint;
  rootLayerIds: string[];
  layers: Record<string, ArtboardLayer>;
  bindings: Record<string, InputBinding>;
  tokenRefs: ArtboardTokenRefs;
};
export type ArtboardInputSnapshot = {
  id: string;
  createdAt: string;
  source?: { projectId: string; nodeId: string; signature: string };
  ignoredSignatures?: string[];
  bindings: Record<string, InputBinding>;
};
export type ArtboardBoard = {
  id: string;
  name: string;
  activeRevisionId: string;
  document: ArtboardDocument;
  inputSnapshot: ArtboardInputSnapshot;
  ancestry: {
    branchId: string;
    parentBoardId?: string;
    sourceRevisionId?: string;
  };
  createdAt: string;
};
export type PasteboardPlacement = { x: number; y: number };
export type ArtboardWorkspace = {
  schemaVersion: typeof ARTBOARD_WORKSPACE_VERSION;
  id: string;
  name: string;
  boards: Record<string, ArtboardBoard>;
  placements: Record<string, PasteboardPlacement>;
  selectedBoardIds: string[];
  activeBoardId: string;
  pasteboard: { margin: number; gap: number; grid: number };
};
export type UpstreamVersionAvailable = {
  state: "new-version-available";
  boardId: string;
  currentSnapshotId: string;
  availableSnapshot: ArtboardInputSnapshot;
};
export type UpstreamUpdateDecision = "keep-current" | "update-current-board" | "create-new-variant";
export type UpstreamUpdateIntent =
  | { type: "none"; boardId: string }
  | { type: "create-revision"; boardId: string; snapshot: ArtboardInputSnapshot }
  | { type: "create-board-variant"; sourceBoardId: string; snapshot: ArtboardInputSnapshot };

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const COLOR = /^#[0-9A-F]{6}$/;
const FORBIDDEN_CONTENT = /(?:\b(?:https?|file|data|javascript):|url\s*\(|<\/?(?:script|style|iframe)\b|@import\b|(?:^|[\s;{}])(?:position|display|background|font-family)\s*:)/i;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} muss ein Objekt sein.`);
  return value as Record<string, unknown>;
}
function known(value: Record<string, unknown>, keys: readonly string[], label: string) {
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  if (extra.length) throw new Error(`${label} enthält unbekannte Felder: ${extra.join(", ")}.`);
}
function string(value: unknown, label: string, max = 200, pattern?: RegExp): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || (pattern && !pattern.test(value))) throw new Error(`${label} ist ungültig.`);
}
function safeString(value: unknown, label: string, max = 2_000): asserts value is string {
  string(value, label, max);
  if (FORBIDDEN_CONTENT.test(value)) throw new Error(`${label} darf keine URL, CSS oder ausführbaren Code enthalten.`);
}
function finite(value: unknown, label: string, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label} liegt außerhalb der erlaubten Grenzen.`);
}
function integer(value: unknown, label: string, min: number, max: number) {
  finite(value, label, min, max);
  if (!Number.isInteger(value)) throw new Error(`${label} muss ganzzahlig sein.`);
}
function id(value: unknown, label: string): asserts value is string { string(value, label, 128, ID); }
function hash(value: unknown, label: string): asserts value is string { string(value, label, 64, HASH); }
function color(value: unknown, label: string): asserts value is string { string(value, label, 7, COLOR); }
function stringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${label} muss eine Textliste sein.`);
}
function unique(values: readonly string[], label: string) {
  if (new Set(values).size !== values.length) throw new Error(`${label} enthält Duplikate.`);
}

function validatePaint(value: unknown, label: string): asserts value is ArtboardPaint {
  const item = record(value, label);
  if (item.kind === "solid") { known(item, ["kind", "color"], label); color(item.color, `${label}.color`); return; }
  if (item.kind !== "linear-gradient") throw new Error(`${label}.kind ist ungültig.`);
  known(item, ["kind", "angle", "stops"], label); finite(item.angle, `${label}.angle`, -360, 360);
  if (!Array.isArray(item.stops) || item.stops.length !== 2) throw new Error(`${label}.stops braucht genau zwei Farbstopps.`);
  item.stops.forEach((value, index) => { const stop = record(value, `${label}.stops.${index}`); known(stop, ["color", "offset"], `${label}.stops.${index}`); color(stop.color, `${label}.stops.${index}.color`); finite(stop.offset, `${label}.stops.${index}.offset`, 0, 1); });
  if ((item.stops[0] as {offset:number}).offset > (item.stops[1] as {offset:number}).offset) throw new Error(`${label}.stops müssen aufsteigend sortiert sein.`);
}
function validateLayerStyle(value: unknown, label: string): asserts value is ArtboardLayerStyle {
  const item = record(value, label); known(item, ["opacity", "border", "borderRadius", "shadow"], label);
  if (item.opacity !== undefined) finite(item.opacity, `${label}.opacity`, 0, 1);
  if (item.borderRadius !== undefined) finite(item.borderRadius, `${label}.borderRadius`, 0, MAX_ARTBOARD_DIMENSION);
  if (item.border !== undefined) { const border = record(item.border, `${label}.border`); known(border, ["width", "color"], `${label}.border`); finite(border.width, `${label}.border.width`, 0, 256); color(border.color, `${label}.border.color`); }
  if (item.shadow !== undefined) { const shadow = record(item.shadow, `${label}.shadow`); known(shadow, ["x", "y", "blur", "color", "opacity"], `${label}.shadow`); finite(shadow.x, `${label}.shadow.x`, -2048, 2048); finite(shadow.y, `${label}.shadow.y`, -2048, 2048); finite(shadow.blur, `${label}.shadow.blur`, 0, 512); color(shadow.color, `${label}.shadow.color`); finite(shadow.opacity, `${label}.shadow.opacity`, 0, 1); }
}
function validateContainerLayout(value: unknown, label: string): asserts value is ArtboardContainerLayout {
  const item = record(value, label);
  if (item.mode === "free") { known(item, ["mode", "padding"], label); finite(item.padding, `${label}.padding`, 0, MAX_ARTBOARD_DIMENSION); return; }
  if (item.mode === "flex") { known(item, ["mode", "direction", "gap", "padding", "justify", "align"], label); if (item.direction !== "row" && item.direction !== "column") throw new Error(`${label}.direction ist ungültig.`); if (!(["start", "center", "end", "space-between"] as unknown[]).includes(item.justify)) throw new Error(`${label}.justify ist ungültig.`); }
  else if (item.mode === "grid") { known(item, ["mode", "columns", "gap", "padding", "align"], label); integer(item.columns, `${label}.columns`, 1, 12); }
  else throw new Error(`${label}.mode ist ungültig.`);
  finite(item.gap, `${label}.gap`, 0, MAX_ARTBOARD_DIMENSION); finite(item.padding, `${label}.padding`, 0, MAX_ARTBOARD_DIMENSION);
  if (!(["start", "center", "end", "stretch"] as unknown[]).includes(item.align)) throw new Error(`${label}.align ist ungültig.`);
}
function validateGeometry(value: unknown, format: ArtboardFormat, label: string): asserts value is ArtboardGeometry {
  const item = record(value, label); known(item, ["x", "y", "width", "height", "rotation"], label);
  finite(item.x, `${label}.x`, 0, format.width);
  finite(item.y, `${label}.y`, 0, format.height);
  finite(item.width, `${label}.width`, 1, format.width);
  finite(item.height, `${label}.height`, 1, format.height);
  finite(item.rotation, `${label}.rotation`, -360, 360);
  if ((item.x as number) + (item.width as number) > format.width || (item.y as number) + (item.height as number) > format.height) throw new Error(`${label} liegt außerhalb des Artboards.`);
}
function validateBinding(value: unknown, key: string, label: string): asserts value is InputBinding {
  const item = record(value, label); known(item, ["id", "source", "snapshot", "mode"], label); id(item.id, `${label}.id`);
  if (item.id !== key) throw new Error(`${label}.id stimmt nicht mit dem Schlüssel überein.`);
  const source = record(item.source, `${label}.source`); known(source, ["projectId", "nodeId", "portId", "resultId"], `${label}.source`);
  id(source.projectId, `${label}.source.projectId`); id(source.nodeId, `${label}.source.nodeId`); id(source.portId, `${label}.source.portId`); id(source.resultId, `${label}.source.resultId`);
  const snapshot = record(item.snapshot, `${label}.snapshot`);
  if (snapshot.kind === "cas") { known(snapshot, ["kind", "hash"], `${label}.snapshot`); hash(snapshot.hash, `${label}.snapshot.hash`); }
  else if (snapshot.kind === "artifact") { known(snapshot, ["kind", "artifactType", "artifactHash"], `${label}.snapshot`); id(snapshot.artifactType, `${label}.snapshot.artifactType`); hash(snapshot.artifactHash, `${label}.snapshot.artifactHash`); }
  else throw new Error(`${label}.snapshot.kind ist ungültig.`);
  if (item.mode !== "live" && item.mode !== "pinned") throw new Error(`${label}.mode ist ungültig.`);
}

export function validateArtboardDocument(value: unknown): asserts value is ArtboardDocument {
  const document = record(value, "ArtboardDocument");
  known(document, ["schemaVersion", "id", "name", "format", "paint", "rootLayerIds", "layers", "bindings", "tokenRefs"], "ArtboardDocument");
  if (document.schemaVersion !== ARTBOARD_DOCUMENT_VERSION) throw new Error("ArtboardDocument.schemaVersion ist ungültig.");
  id(document.id, "ArtboardDocument.id"); safeString(document.name, "ArtboardDocument.name", 160);
  const format = record(document.format, "ArtboardDocument.format"); known(format, ["preset", "width", "height"], "ArtboardDocument.format");
  if (typeof format.preset !== "string" || !(format.preset in ARTBOARD_FORMATS)) throw new Error("ArtboardDocument.format.preset ist ungültig.");
  const expected = ARTBOARD_FORMATS[format.preset as ArtboardPreset];
  integer(format.width, "ArtboardDocument.format.width", 1, MAX_ARTBOARD_DIMENSION); integer(format.height, "ArtboardDocument.format.height", 1, MAX_ARTBOARD_DIMENSION);
  if (format.width !== expected.width || format.height !== expected.height) throw new Error("ArtboardDocument.format passt nicht zum Preset.");
  validatePaint(document.paint, "ArtboardDocument.paint");
  stringArray(document.rootLayerIds, "ArtboardDocument.rootLayerIds"); unique(document.rootLayerIds, "ArtboardDocument.rootLayerIds");
  const layers = record(document.layers, "ArtboardDocument.layers");
  if (Object.keys(layers).length > MAX_ARTBOARD_LAYERS) throw new Error(`Artboards dürfen höchstens ${MAX_ARTBOARD_LAYERS} Ebenen enthalten.`);
  const bindings = record(document.bindings, "ArtboardDocument.bindings");
  for (const [bindingId, binding] of Object.entries(bindings)) validateBinding(binding, bindingId, `ArtboardDocument.bindings.${bindingId}`);
  const tokenRefs = record(document.tokenRefs, "ArtboardDocument.tokenRefs"); known(tokenRefs, ["palette", "fonts"], "ArtboardDocument.tokenRefs");
  for (const role of ["palette", "fonts"] as const) if (tokenRefs[role] !== undefined) {
    const ref = record(tokenRefs[role], `ArtboardDocument.tokenRefs.${role}`); known(ref, ["artifactId", "snapshotHash"], `ArtboardDocument.tokenRefs.${role}`);
    id(ref.artifactId, `ArtboardDocument.tokenRefs.${role}.artifactId`); hash(ref.snapshotHash, `ArtboardDocument.tokenRefs.${role}.snapshotHash`);
  }
  const parentCount = new Map<string, number>();
  for (const [layerId, rawLayer] of Object.entries(layers)) {
    id(layerId, `ArtboardDocument.layers.${layerId}`); const layer = record(rawLayer, `ArtboardDocument.layers.${layerId}`);
    const common = ["id", "type", "name", "locked", "visible", "version", "geometry", "style"];
    const typeKeys = layer.type === "group" ? ["childIds"] : layer.type === "container" ? ["childIds", "layout", "fill"] : layer.type === "text" ? ["text", "color", "fontRef", "fontFamily", "fontHash", "fontWeight", "fontStyle", "fontAxes", "fontSize", "align"] : layer.type === "image" ? ["bindingId", "casHash", "assetVersionId", "fit"] : layer.type === "shape" ? ["shape", "fill"] : [];
    if (!typeKeys.length) throw new Error(`ArtboardDocument.layers.${layerId}.type ist ungültig.`);
    known(layer, [...common, ...typeKeys], `ArtboardDocument.layers.${layerId}`); id(layer.id, `ArtboardDocument.layers.${layerId}.id`);
    if (layer.id !== layerId) throw new Error(`ArtboardDocument.layers.${layerId}.id stimmt nicht mit dem Schlüssel überein.`);
    safeString(layer.name, `ArtboardDocument.layers.${layerId}.name`, 160);
    if (typeof layer.locked !== "boolean" || typeof layer.visible !== "boolean") throw new Error(`ArtboardDocument.layers.${layerId} hat ungültige Statusfelder.`);
    integer(layer.version, `ArtboardDocument.layers.${layerId}.version`, 1, Number.MAX_SAFE_INTEGER); validateGeometry(layer.geometry, format as unknown as ArtboardFormat, `ArtboardDocument.layers.${layerId}.geometry`);
    if (layer.style !== undefined) validateLayerStyle(layer.style, `ArtboardDocument.layers.${layerId}.style`);
    if (layer.type === "group" || layer.type === "container") { stringArray(layer.childIds, `ArtboardDocument.layers.${layerId}.childIds`); unique(layer.childIds, `ArtboardDocument.layers.${layerId}.childIds`); for (const childId of layer.childIds) { id(childId, `ArtboardDocument.layers.${layerId}.childId`); parentCount.set(childId, (parentCount.get(childId) ?? 0) + 1); } }
    if (layer.type === "container") { validateContainerLayout(layer.layout, `ArtboardDocument.layers.${layerId}.layout`); validatePaint(layer.fill, `ArtboardDocument.layers.${layerId}.fill`); if (layer.layout.padding * 2 >= Math.min(layer.geometry.width, layer.geometry.height)) throw new Error(`ArtboardDocument.layers.${layerId}.layout.padding lässt keinen Inhaltsbereich übrig.`); }
    if (layer.type === "text") {
      safeString(layer.text, `ArtboardDocument.layers.${layerId}.text`, 20_000); color(layer.color, `ArtboardDocument.layers.${layerId}.color`);
      if (layer.fontRef !== undefined) id(layer.fontRef, `ArtboardDocument.layers.${layerId}.fontRef`);
      if (layer.fontFamily !== undefined) safeString(layer.fontFamily, `ArtboardDocument.layers.${layerId}.fontFamily`, 120);
      if (layer.fontHash !== undefined) hash(layer.fontHash, `ArtboardDocument.layers.${layerId}.fontHash`);
      if (layer.fontHash !== undefined && layer.fontFamily === undefined) throw new Error(`ArtboardDocument.layers.${layerId} braucht für einen CAS-Font eine Schriftfamilie.`);
      if (layer.fontWeight !== undefined) integer(layer.fontWeight, `ArtboardDocument.layers.${layerId}.fontWeight`, 1, 1_000);
      if (layer.fontStyle !== undefined && layer.fontStyle !== "normal" && layer.fontStyle !== "italic") throw new Error(`ArtboardDocument.layers.${layerId}.fontStyle ist ungültig.`);
      if (layer.fontAxes !== undefined) { const axes=record(layer.fontAxes,`ArtboardDocument.layers.${layerId}.fontAxes`); if(Object.keys(axes).length>16)throw new Error(`ArtboardDocument.layers.${layerId}.fontAxes enthält zu viele Achsen.`); for(const [tag,axisValue] of Object.entries(axes)){if(!/^[A-Za-z0-9]{4}$/.test(tag))throw new Error(`ArtboardDocument.layers.${layerId}.fontAxes.${tag} ist ungültig.`);finite(axisValue,`ArtboardDocument.layers.${layerId}.fontAxes.${tag}`,-100_000,100_000);} }
      finite(layer.fontSize, `ArtboardDocument.layers.${layerId}.fontSize`, 1, 2_000); if (!(["left", "center", "right"] as unknown[]).includes(layer.align)) throw new Error(`ArtboardDocument.layers.${layerId}.align ist ungültig.`);
    }
    if (layer.type === "image") { if (layer.bindingId === undefined && layer.casHash === undefined) throw new Error(`ArtboardDocument.layers.${layerId} braucht eine Bildreferenz.`); if (layer.bindingId !== undefined) { id(layer.bindingId, `ArtboardDocument.layers.${layerId}.bindingId`); if (!(layer.bindingId in bindings)) throw new Error(`ArtboardDocument.layers.${layerId}.bindingId ist unbekannt.`); } if (layer.casHash !== undefined) hash(layer.casHash, `ArtboardDocument.layers.${layerId}.casHash`); if (layer.assetVersionId !== undefined) { id(layer.assetVersionId, `ArtboardDocument.layers.${layerId}.assetVersionId`); if (layer.casHash === undefined) throw new Error(`ArtboardDocument.layers.${layerId}.assetVersionId braucht einen CAS-Hash.`); } if (!(["cover", "contain", "fill"] as unknown[]).includes(layer.fit)) throw new Error(`ArtboardDocument.layers.${layerId}.fit ist ungültig.`); }
    if (layer.type === "shape") { if (layer.shape !== "rectangle" && layer.shape !== "ellipse") throw new Error(`ArtboardDocument.layers.${layerId}.shape ist ungültig.`); validatePaint(layer.fill, `ArtboardDocument.layers.${layerId}.fill`); }
  }
  for (const rootId of document.rootLayerIds) if (!(rootId in layers)) throw new Error(`Unbekannte Root-Ebene ${rootId}.`);
  for (const [childId, count] of parentCount) { if (!(childId in layers)) throw new Error(`Unbekannte Kind-Ebene ${childId}.`); if (count > 1) throw new Error(`Ebene ${childId} besitzt mehrere Eltern.`); if (document.rootLayerIds.includes(childId)) throw new Error(`Artboard enthält einen Ebenenzyklus: ${childId} ist zugleich Root und Kind.`); }
  const visited = new Set<string>(); const stack = new Set<string>();
  const walk = (layerId: string, depth: number) => { if (depth > MAX_ARTBOARD_DEPTH) throw new Error(`Artboard überschreitet die maximale Ebenentiefe ${MAX_ARTBOARD_DEPTH}.`); if (stack.has(layerId)) throw new Error("Artboard enthält einen Ebenenzyklus."); if (visited.has(layerId)) return; stack.add(layerId); const layer = layers[layerId] as unknown as ArtboardLayer; if (layer.type === "group" || layer.type === "container") for (const childId of layer.childIds) walk(childId, depth + 1); stack.delete(layerId); visited.add(layerId); };
  for (const rootId of document.rootLayerIds) walk(rootId, 1);
  if (visited.size !== Object.keys(layers).length) throw new Error("Artboard enthält nicht erreichbare oder zyklische Ebenen.");
}

function validateInputSnapshot(value: unknown, label: string): asserts value is ArtboardInputSnapshot {
  const snapshot = record(value, label); known(snapshot, ["id", "createdAt", "source", "ignoredSignatures", "bindings"], label); id(snapshot.id, `${label}.id`); string(snapshot.createdAt, `${label}.createdAt`, 40); if (!Number.isFinite(Date.parse(snapshot.createdAt))) throw new Error(`${label}.createdAt ist ungültig.`);
  if(snapshot.ignoredSignatures!==undefined){stringArray(snapshot.ignoredSignatures,`${label}.ignoredSignatures`);unique(snapshot.ignoredSignatures,`${label}.ignoredSignatures`);if(snapshot.ignoredSignatures.length>32)throw new Error(`${label}.ignoredSignatures enthält zu viele Einträge.`);for(const signature of snapshot.ignoredSignatures)string(signature,`${label}.ignoredSignatures`,200_000);}
  if(snapshot.source!==undefined){const source=record(snapshot.source,`${label}.source`);known(source,["projectId","nodeId","signature"],`${label}.source`);id(source.projectId,`${label}.source.projectId`);id(source.nodeId,`${label}.source.nodeId`);string(source.signature,`${label}.source.signature`,200_000);}
  const bindings = record(snapshot.bindings, `${label}.bindings`); for (const [bindingId, binding] of Object.entries(bindings)) validateBinding(binding, bindingId, `${label}.bindings.${bindingId}`);
}
export function boardBounds(workspace: ArtboardWorkspace, boardId: string) {
  const board = workspace.boards[boardId]; const placement = workspace.placements[boardId];
  if (!board || !placement) throw new Error(`Board ${boardId} fehlt.`);
  return { x: placement.x, y: placement.y, width: board.document.format.width, height: board.document.format.height };
}
export function rectanglesOverlap(a: {x:number;y:number;width:number;height:number}, b: {x:number;y:number;width:number;height:number}, gap = 0) {
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
}
export function validateArtboardWorkspace(value: unknown): asserts value is ArtboardWorkspace {
  const workspace = record(value, "ArtboardWorkspace"); known(workspace, ["schemaVersion", "id", "name", "boards", "placements", "selectedBoardIds", "activeBoardId", "pasteboard"], "ArtboardWorkspace");
  if (workspace.schemaVersion !== ARTBOARD_WORKSPACE_VERSION) throw new Error("ArtboardWorkspace.schemaVersion ist ungültig."); id(workspace.id, "ArtboardWorkspace.id"); safeString(workspace.name, "ArtboardWorkspace.name", 160);
  const boards = record(workspace.boards, "ArtboardWorkspace.boards"); const placements = record(workspace.placements, "ArtboardWorkspace.placements"); if (!Object.keys(boards).length) throw new Error("Ein ArtboardWorkspace braucht mindestens ein Board.");
  const pasteboard = record(workspace.pasteboard, "ArtboardWorkspace.pasteboard"); known(pasteboard, ["margin", "gap", "grid"], "ArtboardWorkspace.pasteboard"); finite(pasteboard.margin, "ArtboardWorkspace.pasteboard.margin", 0, 10_000); finite(pasteboard.gap, "ArtboardWorkspace.pasteboard.gap", 0, 10_000); finite(pasteboard.grid, "ArtboardWorkspace.pasteboard.grid", 1, 1_000);
  for (const [boardId, rawBoard] of Object.entries(boards)) {
    id(boardId, `ArtboardWorkspace.boards.${boardId}`); const board = record(rawBoard, `ArtboardWorkspace.boards.${boardId}`); known(board, ["id", "name", "activeRevisionId", "document", "inputSnapshot", "ancestry", "createdAt"], `ArtboardWorkspace.boards.${boardId}`); id(board.id, `ArtboardWorkspace.boards.${boardId}.id`); if (board.id !== boardId) throw new Error(`Board-ID ${boardId} stimmt nicht mit dem Schlüssel überein.`); safeString(board.name, `ArtboardWorkspace.boards.${boardId}.name`, 160); id(board.activeRevisionId, `ArtboardWorkspace.boards.${boardId}.activeRevisionId`); validateArtboardDocument(board.document); validateInputSnapshot(board.inputSnapshot, `ArtboardWorkspace.boards.${boardId}.inputSnapshot`); string(board.createdAt, `ArtboardWorkspace.boards.${boardId}.createdAt`, 40); if (!Number.isFinite(Date.parse(board.createdAt))) throw new Error(`ArtboardWorkspace.boards.${boardId}.createdAt ist ungültig.`);
    const ancestry = record(board.ancestry, `ArtboardWorkspace.boards.${boardId}.ancestry`); known(ancestry, ["branchId", "parentBoardId", "sourceRevisionId"], `ArtboardWorkspace.boards.${boardId}.ancestry`); id(ancestry.branchId, `ArtboardWorkspace.boards.${boardId}.ancestry.branchId`); if (ancestry.parentBoardId !== undefined) id(ancestry.parentBoardId, `ArtboardWorkspace.boards.${boardId}.ancestry.parentBoardId`); if (ancestry.sourceRevisionId !== undefined) id(ancestry.sourceRevisionId, `ArtboardWorkspace.boards.${boardId}.ancestry.sourceRevisionId`);
    const placement = record(placements[boardId], `ArtboardWorkspace.placements.${boardId}`); known(placement, ["x", "y"], `ArtboardWorkspace.placements.${boardId}`); finite(placement.x, `ArtboardWorkspace.placements.${boardId}.x`, 0, MAX_PASTEBOARD_COORDINATE); finite(placement.y, `ArtboardWorkspace.placements.${boardId}.y`, 0, MAX_PASTEBOARD_COORDINATE);
  }
  if (Object.keys(placements).some((boardId) => !(boardId in boards))) throw new Error("ArtboardWorkspace.placements enthält ein unbekanntes Board.");
  stringArray(workspace.selectedBoardIds, "ArtboardWorkspace.selectedBoardIds"); unique(workspace.selectedBoardIds, "ArtboardWorkspace.selectedBoardIds"); for (const boardId of workspace.selectedBoardIds) if (!(boardId in boards)) throw new Error(`Ausgewähltes Board ${boardId} fehlt.`); id(workspace.activeBoardId, "ArtboardWorkspace.activeBoardId"); if (!(workspace.activeBoardId in boards)) throw new Error("Das aktive Board fehlt.");
  const ids = Object.keys(boards); for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) if (rectanglesOverlap(boardBounds(workspace as unknown as ArtboardWorkspace, ids[i]), boardBounds(workspace as unknown as ArtboardWorkspace, ids[j]))) throw new Error(`Boards ${ids[i]} und ${ids[j]} überlappen.`);
}

const snap = (value: number, grid: number) => Math.ceil(value / grid) * grid;
export function findBoardPlacement(workspace: ArtboardWorkspace, format: ArtboardFormat, sourceBoardId?: string): PasteboardPlacement {
  validateArtboardWorkspace(workspace); const { margin, gap, grid } = workspace.pasteboard; const occupied = Object.keys(workspace.boards).map((id) => boardBounds(workspace, id));
  const fits = (x: number, y: number) => x + format.width <= MAX_PASTEBOARD_COORDINATE && y + format.height <= MAX_PASTEBOARD_COORDINATE && occupied.every((rect) => !rectanglesOverlap({x,y,width:format.width,height:format.height}, rect));
  if (sourceBoardId && workspace.boards[sourceBoardId]) { const source = boardBounds(workspace, sourceBoardId); const candidate = {x:snap(source.x + source.width + gap, grid), y:snap(source.y, grid)}; if (fits(candidate.x, candidate.y)) return candidate; const nextRow = {x:snap(margin, grid),y:snap(Math.max(...occupied.map((item)=>item.y+item.height))+gap,grid)}; if (fits(nextRow.x,nextRow.y)) return nextRow; }
  const rowStep = snap(Math.max(format.height, ...occupied.map((item) => item.height), grid) + gap, grid); const columnStep = snap(format.width + gap, grid);
  for (let y = snap(margin, grid); y <= MAX_PASTEBOARD_COORDINATE - format.height; y += rowStep) for (let x = snap(margin, grid); x <= MAX_PASTEBOARD_COORDINATE - format.width; x += columnStep) if (fits(x, y)) return {x,y};
  throw new Error("Auf der Arbeitsfläche ist kein freier Platz für dieses Board.");
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
export function duplicateBoard(workspace: ArtboardWorkspace, sourceBoardId: string, ids: {boardId:string;documentId:string;snapshotId:string;revisionId?:string}, createdAt: string): ArtboardWorkspace {
  validateArtboardWorkspace(workspace); const source = workspace.boards[sourceBoardId]; if (!source) throw new Error(`Quell-Board ${sourceBoardId} fehlt.`); id(ids.boardId, "boardId"); id(ids.documentId, "documentId"); id(ids.snapshotId, "snapshotId"); if (ids.revisionId !== undefined) id(ids.revisionId, "revisionId"); if (workspace.boards[ids.boardId]) throw new Error(`Board ${ids.boardId} existiert bereits.`);
  const board = clone(source); board.id = ids.boardId; board.name = `${source.name} Kopie`; board.activeRevisionId = ids.revisionId ?? `${ids.boardId}-revision-1`; board.document.id = ids.documentId; board.inputSnapshot.id = ids.snapshotId; board.ancestry.parentBoardId = sourceBoardId; board.ancestry.sourceRevisionId=source.activeRevisionId; board.createdAt = createdAt;
  const next = clone(workspace); next.boards[board.id] = board; next.placements[board.id] = findBoardPlacement(workspace, board.document.format, sourceBoardId); next.activeBoardId = board.id; next.selectedBoardIds = [board.id]; validateArtboardWorkspace(next); return next;
}
export function createBoardFromInputs(workspace: ArtboardWorkspace, sourceBoardId: string, board: ArtboardBoard): ArtboardWorkspace {
  validateArtboardWorkspace(workspace); validateArtboardDocument(board.document); validateInputSnapshot(board.inputSnapshot, "board.inputSnapshot"); if (workspace.boards[board.id]) throw new Error(`Board ${board.id} existiert bereits.`); const next = clone(workspace); next.boards[board.id] = clone(board); next.placements[board.id] = findBoardPlacement(workspace, board.document.format, sourceBoardId); next.activeBoardId = board.id; next.selectedBoardIds = [board.id]; validateArtboardWorkspace(next); return next;
}
export function workspaceOutputs(workspace: ArtboardWorkspace, renderedImages: Record<string,string>) {
  validateArtboardWorkspace(workspace); const image = renderedImages[workspace.activeBoardId]; if (!image) throw new Error("Für das aktive Board fehlt das gerenderte Bild."); const selected = workspace.selectedBoardIds.map((id) => renderedImages[id]); if (selected.some((value) => !value)) throw new Error("Für mindestens ein ausgewähltes Board fehlt das gerenderte Bild.");
  return { activeBoard: workspace.boards[workspace.activeBoardId], image, selectedImages: selected };
}
export function deterministicArtboardManifest(workspace: ArtboardWorkspace) {
  validateArtboardWorkspace(workspace); const assetHashes = new Set<string>(); for (const board of Object.values(workspace.boards)) { for (const binding of Object.values(board.document.bindings)) assetHashes.add(binding.snapshot.kind === "cas" ? binding.snapshot.hash : binding.snapshot.artifactHash); for (const layer of Object.values(board.document.layers)) if (layer.type === "image" && layer.casHash) assetHashes.add(layer.casHash); }
  return { format: "flowz-artboard", version: 1 as const, workspace: clone(workspace), assetHashes: [...assetHashes].sort() };
}
export function serializeFlowzArtboard(workspace:ArtboardWorkspace):string{return canonicalStringify(deterministicArtboardManifest(workspace) as unknown as Record<string,unknown>);}
export function resolveUpstreamUpdate(update:UpstreamVersionAvailable,decision:UpstreamUpdateDecision):UpstreamUpdateIntent{
  if(decision==="keep-current")return{type:"none",boardId:update.boardId};
  if(decision==="update-current-board")return{type:"create-revision",boardId:update.boardId,snapshot:clone(update.availableSnapshot)};
  return{type:"create-board-variant",sourceBoardId:update.boardId,snapshot:clone(update.availableSnapshot)};
}
import { canonicalStringify } from "../../engine/fingerprint";
