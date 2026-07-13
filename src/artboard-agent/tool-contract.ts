export const ARTBOARD_AGENT_TOOL_CONTRACT_VERSION = "flowz-artboard-tools-v2";
export const MAX_TOOL_ARGUMENT_BYTES = 16 * 1024;
export const MAX_TOOLS_PER_TURN = 24;
export const MAX_MUTATIONS_PER_TURN = 80;
export const MAX_LAYERS_PER_CALL = 20;

export const ARTBOARD_READ_TOOLS = ["get_workspace_info", "get_selection", "get_board", "get_layer_tree", "get_layers", "get_bound_inputs", "render_preview"] as const;
export const ARTBOARD_WRITE_TOOLS = ["create_board", "duplicate_board_as_variant", "delete_board", "create_layers", "update_layers", "delete_layers", "duplicate_layers", "reorder_layers", "set_board_properties", "bind_layer_resource", "propose_image_generation", "finish_working"] as const;
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

function validatePaint(value:unknown,key:string){
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error(`${key} ist ungültig.`);const paint=value as Record<string,unknown>;
  if(paint.kind==="solid"){known(paint,["kind","color"]);if(typeof paint.color!=="string"||!COLOR.test(paint.color))throw new Error(`${key}.color ist ungültig.`);return;}
  known(paint,["kind","angle","stops"]);if(paint.kind!=="linear-gradient")throw new Error(`${key}.kind ist ungültig.`);finite(paint.angle,`${key}.angle`,-360,360);
  if(!Array.isArray(paint.stops)||paint.stops.length!==2)throw new Error(`${key}.stops ist ungültig.`);paint.stops.forEach((raw,index)=>{if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new Error(`${key}.stops.${index} ist ungültig.`);const stop=raw as Record<string,unknown>;known(stop,["color","offset"]);if(typeof stop.color!=="string"||!COLOR.test(stop.color))throw new Error(`${key}.stops.${index}.color ist ungültig.`);finite(stop.offset,`${key}.stops.${index}.offset`,0,1);});
  if((paint.stops[0] as {offset:number}).offset>(paint.stops[1] as {offset:number}).offset)throw new Error(`${key}.stops müssen sortiert sein.`);
}
function validateStyle(value:unknown){
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("style ist ungültig.");const style=value as Record<string,unknown>;known(style,["opacity","border","borderRadius","shadow"]);if(style.opacity!==undefined)finite(style.opacity,"style.opacity",0,1);if(style.borderRadius!==undefined)finite(style.borderRadius,"style.borderRadius",0,32768);
  if(style.border!==undefined){const border=style.border as Record<string,unknown>;if(!border||typeof border!=="object"||Array.isArray(border))throw new Error("style.border ist ungültig.");known(border,["width","color"]);finite(border.width,"style.border.width",0,256);if(typeof border.color!=="string"||!COLOR.test(border.color))throw new Error("style.border.color ist ungültig.");}
  if(style.shadow!==undefined){const shadow=style.shadow as Record<string,unknown>;if(!shadow||typeof shadow!=="object"||Array.isArray(shadow))throw new Error("style.shadow ist ungültig.");known(shadow,["x","y","blur","color","opacity"]);finite(shadow.x,"style.shadow.x",-2048,2048);finite(shadow.y,"style.shadow.y",-2048,2048);finite(shadow.blur,"style.shadow.blur",0,512);finite(shadow.opacity,"style.shadow.opacity",0,1);if(typeof shadow.color!=="string"||!COLOR.test(shadow.color))throw new Error("style.shadow.color ist ungültig.");}
}
function validateLayout(value:unknown){
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("layout ist ungültig.");const layout=value as Record<string,unknown>;
  if(layout.mode==="free"){known(layout,["mode","padding"]);finite(layout.padding,"layout.padding",0,32768);return;}
  if(layout.mode==="flex"){known(layout,["mode","direction","gap","padding","justify","align"]);if(!["row","column"].includes(String(layout.direction))||!["start","center","end","space-between"].includes(String(layout.justify)))throw new Error("Flex-Layout ist ungültig.");}
  else if(layout.mode==="grid"){known(layout,["mode","columns","gap","padding","align"]);finite(layout.columns,"layout.columns",1,12);if(!Number.isInteger(layout.columns))throw new Error("layout.columns ist ungültig.");}
  else throw new Error("layout.mode ist ungültig.");finite(layout.gap,"layout.gap",0,32768);finite(layout.padding,"layout.padding",0,32768);if(!["start","center","end","stretch"].includes(String(layout.align)))throw new Error("layout.align ist ungültig.");
}

function validateLayer(value: Record<string, unknown>) {
  requiredId(value, "id"); safeText(value.name, "name", 160); validateGeometry(value.geometry);
  if (typeof value.locked !== "boolean" || typeof value.visible !== "boolean") throw new Error("Layerstatus ist ungültig.");
  const common = ["id", "type", "name", "locked", "visible", "geometry", "style"];
  if(value.style!==undefined)validateStyle(value.style);
  if (value.type === "text") { known(value, [...common, "text", "color", "fontRef", "fontFamily", "fontHash", "fontWeight", "fontStyle", "fontAxes", "fontSize", "align"]); safeText(value.text, "text", 20000); if (typeof value.color !== "string" || !COLOR.test(value.color)) throw new Error("color ist ungültig."); if (value.fontRef !== undefined && (typeof value.fontRef !== "string" || !ID.test(value.fontRef))) throw new Error("fontRef ist ungültig.");if(value.fontFamily!==undefined)safeText(value.fontFamily,"fontFamily",120);if(value.fontHash!==undefined&&(typeof value.fontHash!=="string"||!HASH.test(value.fontHash)))throw new Error("fontHash ist ungültig.");if(value.fontHash!==undefined&&value.fontFamily===undefined)throw new Error("fontHash braucht fontFamily.");if(value.fontWeight!==undefined)finite(value.fontWeight,"fontWeight",1,1000);if(value.fontStyle!==undefined&&!["normal","italic"].includes(String(value.fontStyle)))throw new Error("fontStyle ist ungültig.");if(value.fontAxes!==undefined){if(!value.fontAxes||typeof value.fontAxes!=="object"||Array.isArray(value.fontAxes)||Object.keys(value.fontAxes as object).length>16)throw new Error("fontAxes ist ungültig.");for(const [tag,axis] of Object.entries(value.fontAxes as Record<string,unknown>)){if(!/^[A-Za-z0-9]{4}$/.test(tag))throw new Error("fontAxes enthält eine ungültige Achse.");finite(axis,`fontAxes.${tag}`,-100000,100000);}} finite(value.fontSize, "fontSize", 1, 2000); if (!["left", "center", "right"].includes(String(value.align))) throw new Error("align ist ungültig."); return; }
  if (value.type === "shape") { known(value, [...common, "shape", "fill", "color"]); if (!["rectangle", "ellipse"].includes(String(value.shape))) throw new Error("Form ist ungültig."); if(value.fill!==undefined)validatePaint(value.fill,"fill");else if(typeof value.color!=="string"||!COLOR.test(value.color))throw new Error("Formfarbe ist ungültig."); return; }
  if (value.type === "image") { known(value, [...common, "bindingId", "casHash", "assetVersionId", "fit"]); if (value.bindingId === undefined && value.casHash === undefined) throw new Error("Bildreferenz fehlt."); if (value.bindingId !== undefined && (typeof value.bindingId !== "string" || !ID.test(value.bindingId))) throw new Error("bindingId ist ungültig."); if (value.casHash !== undefined && (typeof value.casHash !== "string" || !HASH.test(value.casHash))) throw new Error("casHash ist ungültig.");if(value.assetVersionId!==undefined&&(typeof value.assetVersionId!=="string"||!ID.test(value.assetVersionId)||value.casHash===undefined))throw new Error("assetVersionId braucht einen gültigen CAS-Hash."); if (!["cover", "contain", "fill"].includes(String(value.fit))) throw new Error("fit ist ungültig."); return; }
  if (value.type === "group") { known(value, [...common, "childIds"]); idArray(value.childIds, "childIds", true); return; }
  if(value.type==="container"){known(value,[...common,"childIds","layout","fill"]);idArray(value.childIds,"childIds",true);validateLayout(value.layout);validatePaint(value.fill,"fill");return;}
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
  if (tool === "render_preview") { known(args, [...common, "boardId", "width", "height", "proposalId"]); requiredId(args, "boardId"); if (args.proposalId !== undefined) requiredId(args, "proposalId"); finite(args.width, "width", 1, 1024); finite(args.height, "height", 1, 1024); return 0; }
  validateWriteCommon(args);
  const writeCommon = [...common, "proposalId", "operationId", "expectedRevision"];
  if(tool==="create_board"){known(args,[...writeCommon,"name","width","height","sourceBoardId"]);safeText(args.name,"name",160);finite(args.width,"width",1,32768);finite(args.height,"height",1,32768);if(args.sourceBoardId!==undefined)requiredId(args,"sourceBoardId");return 1;}
  if(tool==="duplicate_board_as_variant"){known(args,[...writeCommon,"sourceBoardId","name","width","height"]);requiredId(args,"sourceBoardId");safeText(args.name,"name",160);finite(args.width,"width",1,32768);finite(args.height,"height",1,32768);return 1;}
  if(tool==="delete_board"){known(args,[...writeCommon,"boardId"]);requiredId(args,"boardId");return 1;}
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
