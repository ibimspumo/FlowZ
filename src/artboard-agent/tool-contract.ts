export const ARTBOARD_AGENT_TOOL_CONTRACT_VERSION = "flowz-artboard-tools-v1";
export const MAX_TOOL_ARGUMENT_BYTES = 16 * 1024;
export const MAX_TOOLS_PER_TURN = 24;
export const MAX_MUTATIONS_PER_TURN = 80;
export const MAX_LAYERS_PER_CALL = 20;

export const ARTBOARD_READ_TOOLS = ["get_workspace_info", "get_selection", "get_board", "get_layer_tree", "get_layers", "get_bound_inputs", "render_preview"] as const;
export const ARTBOARD_WRITE_TOOLS = ["create_layers", "update_layers", "delete_layers", "duplicate_layers", "reorder_layers", "set_board_properties", "bind_layer_resource", "propose_image_generation", "finish_working"] as const;
export type ArtboardAgentToolName = typeof ARTBOARD_READ_TOOLS[number] | typeof ARTBOARD_WRITE_TOOLS[number];

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const COLOR = /^#[0-9A-Fa-f]{6}$/;
const FORBIDDEN_CONTENT = /(?:\b(?:https?|file|data|javascript):|url\s*\(|<\/?(?:script|style|iframe)\b|@import\b|(?:^|[\s;{}])(?:position|display|background|font-family)\s*:)/i;

export type ToolInvocation = {
  tool: ArtboardAgentToolName;
  arguments: Record<string, unknown>;
};

export type ToolBudget = { calls: number; mutations: number };

export function isArtboardAgentTool(value: string): value is ArtboardAgentToolName {
  return (ARTBOARD_READ_TOOLS as readonly string[]).includes(value) || (ARTBOARD_WRITE_TOOLS as readonly string[]).includes(value);
}

function requiredId(argumentsValue: Record<string, unknown>, key: string) {
  const value = argumentsValue[key];
  if (typeof value !== "string" || !ID.test(value)) throw new Error(`${key} ist ungültig.`);
}

function known(value: Record<string, unknown>, keys: readonly string[]) {
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  if (extra.length) throw new Error(`Unbekannte Werkzeugargumente: ${extra.join(", ")}.`);
}

function finite(value: unknown, key: string, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${key} ist ungültig.`);
}

function idArray(value: unknown, key: string, allowEmpty = false): asserts value is string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > MAX_LAYERS_PER_CALL || value.some((item) => typeof item !== "string" || !ID.test(item)) || new Set(value).size !== value.length) throw new Error(`${key} ist ungültig.`);
}

function objectArray(value: unknown, key: string): asserts value is Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LAYERS_PER_CALL || value.some((item) => !item || typeof item !== "object" || Array.isArray(item))) throw new Error(`${key} ist ungültig.`);
}

function safeText(value: unknown, key: string, max: number) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new Error(`${key} ist ungültig.`);
  if (FORBIDDEN_CONTENT.test(value)) throw new Error(`${key} darf keine URLs, CSS oder ausführbaren Code enthalten.`);
}

function validateGeometry(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("geometry ist ungültig.");
  const geometry = value as Record<string, unknown>; known(geometry, ["x", "y", "width", "height", "rotation"]);
  finite(geometry.x, "geometry.x", 0, 32768); finite(geometry.y, "geometry.y", 0, 32768); finite(geometry.width, "geometry.width", 1, 32768); finite(geometry.height, "geometry.height", 1, 32768); finite(geometry.rotation, "geometry.rotation", -360, 360);
}

function validateLayer(value: Record<string, unknown>) {
  requiredId(value, "id"); safeText(value.name, "name", 160); validateGeometry(value.geometry);
  if (typeof value.locked !== "boolean" || typeof value.visible !== "boolean") throw new Error("Layerstatus ist ungültig.");
  const common = ["id", "type", "name", "locked", "visible", "geometry"];
  if (value.type === "text") { known(value, [...common, "text", "color", "fontRef", "fontSize", "align"]); safeText(value.text, "text", 20000); if (typeof value.color !== "string" || !COLOR.test(value.color)) throw new Error("color ist ungültig."); if (value.fontRef !== undefined && (typeof value.fontRef !== "string" || !ID.test(value.fontRef))) throw new Error("fontRef ist ungültig."); finite(value.fontSize, "fontSize", 1, 2000); if (!["left", "center", "right"].includes(String(value.align))) throw new Error("align ist ungültig."); return; }
  if (value.type === "shape") { known(value, [...common, "shape", "color"]); if (!["rectangle", "ellipse"].includes(String(value.shape)) || typeof value.color !== "string" || !COLOR.test(value.color)) throw new Error("Form ist ungültig."); return; }
  if (value.type === "image") { known(value, [...common, "bindingId", "casHash", "fit"]); if (value.bindingId === undefined && value.casHash === undefined) throw new Error("Bildreferenz fehlt."); if (value.bindingId !== undefined && (typeof value.bindingId !== "string" || !ID.test(value.bindingId))) throw new Error("bindingId ist ungültig."); if (value.casHash !== undefined && (typeof value.casHash !== "string" || !HASH.test(value.casHash))) throw new Error("casHash ist ungültig."); if (!["cover", "contain", "fill"].includes(String(value.fit))) throw new Error("fit ist ungültig."); return; }
  if (value.type === "group") { known(value, [...common, "childIds"]); idArray(value.childIds, "childIds", true); return; }
  throw new Error("Layertyp ist ungültig.");
}

function validateWriteCommon(args: Record<string, unknown>) {
  for (const key of ["workspaceId", "branchId", "proposalId", "operationId"]) requiredId(args, key);
  if (!Number.isInteger(args.expectedRevision) || (args.expectedRevision as number) < 0) throw new Error("expectedRevision ist ungültig.");
}

function validateInvocationShape(tool: ArtboardAgentToolName, args: Record<string, unknown>): number {
  const common = ["workspaceId", "branchId"];
  for (const key of common) requiredId(args, key);
  if (tool === "get_workspace_info" || tool === "get_selection") { known(args, common); return 0; }
  if (["get_board", "get_layer_tree"].includes(tool)) { known(args, [...common, "boardId"]); requiredId(args, "boardId"); return 0; }
  if (tool === "get_layers") { known(args, [...common, "layerIds"]); idArray(args.layerIds, "layerIds"); return 0; }
  if (tool === "get_bound_inputs") { known(args, [...common, "bindingIds"]); idArray(args.bindingIds, "bindingIds", true); return 0; }
  if (tool === "render_preview") { known(args, [...common, "boardId", "width", "height"]); requiredId(args, "boardId"); finite(args.width, "width", 1, 2048); finite(args.height, "height", 1, 2048); return 0; }
  validateWriteCommon(args);
  const writeCommon = [...common, "proposalId", "operationId", "expectedRevision"];
  if (tool === "create_layers") { known(args, [...writeCommon, "boardId", "layers"]); requiredId(args, "boardId"); objectArray(args.layers, "layers"); args.layers.forEach(validateLayer); return args.layers.length; }
  if (tool === "update_layers") { known(args, [...writeCommon, "boardId", "layers"]); requiredId(args, "boardId"); objectArray(args.layers, "layers"); args.layers.forEach(validateLayer); return args.layers.length; }
  if (["delete_layers", "duplicate_layers", "reorder_layers"].includes(tool)) { known(args, [...writeCommon, "boardId", "layerIds"]); requiredId(args, "boardId"); idArray(args.layerIds, "layerIds"); return args.layerIds.length; }
  if (tool === "set_board_properties") { known(args, [...writeCommon, "boardId", "name", "width", "height", "backgroundColor"]); requiredId(args, "boardId"); if (args.name !== undefined) safeText(args.name, "name", 160); if (args.width !== undefined) finite(args.width, "width", 1, 32768); if (args.height !== undefined) finite(args.height, "height", 1, 32768); if (args.backgroundColor !== undefined && (typeof args.backgroundColor !== "string" || !COLOR.test(args.backgroundColor))) throw new Error("backgroundColor ist ungültig."); if ([args.name, args.width, args.height, args.backgroundColor].every((item) => item === undefined)) throw new Error("Boardänderung fehlt."); return 1; }
  if (tool === "bind_layer_resource") { known(args, [...writeCommon, "boardId", "layerId", "bindingId"]); requiredId(args, "boardId"); requiredId(args, "layerId"); requiredId(args, "bindingId"); return 1; }
  if (tool === "propose_image_generation") { known(args, [...writeCommon, "boardId", "prompt", "role", "aspectRatio", "referenceBindingIds"]); requiredId(args, "boardId"); safeText(args.prompt, "prompt", 8000); safeText(args.role, "role", 80); if (typeof args.aspectRatio !== "string" || !/^\d{1,2}:\d{1,2}$/.test(args.aspectRatio)) throw new Error("aspectRatio ist ungültig."); idArray(args.referenceBindingIds, "referenceBindingIds", true); return 1; }
  known(args, writeCommon);
  return 0;
}

export function validateToolInvocation(invocation: { tool: string; arguments: unknown }, budget: ToolBudget): { invocation: ToolInvocation; nextBudget: ToolBudget } {
  if (!isArtboardAgentTool(invocation.tool)) throw new Error("Unbekanntes Artboard-Werkzeug.");
  if (!invocation.arguments || typeof invocation.arguments !== "object" || Array.isArray(invocation.arguments)) throw new Error("Werkzeugargumente müssen ein Objekt sein.");
  const args = invocation.arguments as Record<string, unknown>;
  const serialized = JSON.stringify(args);
  if (new TextEncoder().encode(serialized).byteLength > MAX_TOOL_ARGUMENT_BYTES) throw new Error("Werkzeugargumente sind zu groß.");
  const mutations = validateInvocationShape(invocation.tool, args);
  const nextBudget = { calls: budget.calls + 1, mutations: budget.mutations + mutations };
  if (nextBudget.calls > MAX_TOOLS_PER_TURN || nextBudget.mutations > MAX_MUTATIONS_PER_TURN) throw new Error("Das Werkzeugbudget dieses Agentenlaufs ist ausgeschöpft.");
  return { invocation: { tool: invocation.tool, arguments: args }, nextBudget };
}
