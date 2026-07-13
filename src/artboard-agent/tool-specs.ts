import { ARTBOARD_READ_TOOLS, ARTBOARD_WRITE_TOOLS, type ArtboardAgentToolName } from "./tool-contract";

export type AgentToolSpec = { name: ArtboardAgentToolName; description: string; inputSchema: Record<string, unknown> };

const id = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" };
const base = { workspaceId: id, branchId: id };
const write = { ...base, proposalId: id, operationId: id, expectedRevision: { type: "integer", minimum: 0 } };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const ids = { type: "array", items: id, maxItems: 20, uniqueItems: true };
const color={type:"string",pattern:"^#[0-9A-Fa-f]{6}$"};
const geometry=object({x:{type:"number",minimum:0,maximum:32768},y:{type:"number",minimum:0,maximum:32768},width:{type:"number",minimum:1,maximum:32768},height:{type:"number",minimum:1,maximum:32768},rotation:{type:"number",minimum:-360,maximum:360}});
const paint={oneOf:[object({kind:{const:"solid"},color}),object({kind:{const:"linear-gradient"},angle:{type:"number",minimum:-360,maximum:360},stops:{type:"array",minItems:2,maxItems:2,items:object({color,offset:{type:"number",minimum:0,maximum:1}})}})]};
const style=object({opacity:{type:"number",minimum:0,maximum:1},border:{oneOf:[object({width:{type:"number",minimum:0,maximum:256},color})]},borderRadius:{type:"number",minimum:0,maximum:32768},shadow:{oneOf:[object({x:{type:"number",minimum:-2048,maximum:2048},y:{type:"number",minimum:-2048,maximum:2048},blur:{type:"number",minimum:0,maximum:512},color,opacity:{type:"number",minimum:0,maximum:1}})]}},[]);
const common={id,type:{type:"string"},name:{type:"string",minLength:1,maxLength:160},locked:{type:"boolean"},visible:{type:"boolean"},geometry,style};
const layer={oneOf:[
  object({...common,type:{const:"text"},text:{type:"string",minLength:1,maxLength:20000},color,fontRef:id,fontFamily:{type:"string",minLength:1,maxLength:120},fontHash:{type:"string",pattern:"^[a-f0-9]{64}$"},fontWeight:{type:"integer",minimum:1,maximum:1000},fontStyle:{enum:["normal","italic"]},fontAxes:{type:"object",maxProperties:16,additionalProperties:{type:"number",minimum:-100000,maximum:100000}},fontSize:{type:"number",minimum:1,maximum:2000},align:{enum:["left","center","right"]}},["id","type","name","locked","visible","geometry","text","color","fontSize","align"]),
  object({...common,type:{const:"shape"},shape:{enum:["rectangle","ellipse"]},fill:paint},["id","type","name","locked","visible","geometry","shape","fill"]),
  object({...common,type:{const:"image"},bindingId:id,casHash:{type:"string",pattern:"^[a-f0-9]{64}$"},assetVersionId:id,fit:{enum:["cover","contain","fill"]}},["id","type","name","locked","visible","geometry","fit"]),
  object({...common,type:{const:"group"},childIds:ids},["id","type","name","locked","visible","geometry","childIds"]),
  object({...common,type:{const:"container"},childIds:ids,layout:{oneOf:[object({mode:{const:"free"},padding:{type:"number",minimum:0,maximum:32768}}),object({mode:{const:"flex"},direction:{enum:["row","column"]},gap:{type:"number",minimum:0,maximum:32768},padding:{type:"number",minimum:0,maximum:32768},justify:{enum:["start","center","end","space-between"]},align:{enum:["start","center","end","stretch"]}}),object({mode:{const:"grid"},columns:{type:"integer",minimum:1,maximum:12},gap:{type:"number",minimum:0,maximum:32768},padding:{type:"number",minimum:0,maximum:32768},align:{enum:["start","center","end","stretch"]}})]},fill:paint},["id","type","name","locked","visible","geometry","childIds","layout","fill"]),
]};

const schemas: Record<ArtboardAgentToolName, Record<string, unknown>> = {
  get_workspace_info: object(base), get_selection: object(base),
  get_board: object({ ...base, boardId: id }), get_layer_tree: object({ ...base, boardId: id }),
  get_layers: object({ ...base, layerIds: ids }), get_bound_inputs: object({ ...base, bindingIds: ids }),
  render_preview: object({ ...base, boardId: id, width: { type: "number", minimum: 1, maximum: 1024 }, height: { type: "number", minimum: 1, maximum: 1024 }, proposalId: id }, ["workspaceId", "branchId", "boardId", "width", "height"]),
  create_board:object({...write,name:{type:"string",minLength:1,maxLength:160},width:{type:"number",minimum:1,maximum:32768},height:{type:"number",minimum:1,maximum:32768},sourceBoardId:id},["workspaceId","branchId","proposalId","operationId","expectedRevision","name","width","height"]),
  duplicate_board_as_variant:object({...write,sourceBoardId:id,name:{type:"string",minLength:1,maxLength:160},width:{type:"number",minimum:1,maximum:32768},height:{type:"number",minimum:1,maximum:32768}}),
  delete_board: object({ ...write, boardId: id }),
  create_layers: object({ ...write, boardId: id, layers: { type: "array", minItems: 1, maxItems: 20, items: layer } }),
  update_layers: object({ ...write, boardId: id, layers: { type: "array", minItems: 1, maxItems: 20, items: layer } }),
  delete_layers: object({ ...write, boardId: id, layerIds: ids }), duplicate_layers: object({ ...write, boardId: id, layerIds: ids }), reorder_layers: object({ ...write, boardId: id, layerIds: ids }),
  set_board_properties: object({ ...write, boardId: id, name: { type: "string", maxLength: 160 }, width: { type: "number", minimum: 1, maximum: 32768 }, height: { type: "number", minimum: 1, maximum: 32768 }, backgroundColor: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" } }, ["workspaceId", "branchId", "proposalId", "operationId", "expectedRevision", "boardId"]),
  bind_layer_resource: object({ ...write, boardId: id, layerId: id, bindingId: id }),
  propose_image_generation: object({ ...write, boardId: id, prompt: { type: "string", minLength: 1, maxLength: 8000 }, role: { type: "string", minLength: 1, maxLength: 80 }, aspectRatio: { type: "string", pattern: "^\\d{1,2}:\\d{1,2}$" }, referenceBindingIds: ids }),
  finish_working: object(write),
};

export const ARTBOARD_AGENT_TOOL_SPECS: readonly AgentToolSpec[] = [...ARTBOARD_READ_TOOLS, ...ARTBOARD_WRITE_TOOLS].map((name) => ({
  name, description: name === "render_preview" ? "Render bounded structured and visual PNG evidence. Pass proposalId to inspect the current proposal draft." : name === "delete_board" ? "Propose removing one Artboard only when the user explicitly asks to remove that whole Artboard. Never applies it and never removes the final Artboard." : name === "create_layers" || name === "update_layers" ? "Create a validated proposal operation. Never applies it. For system fonts such as Georgia set fontFamily and omit fontHash. Only reuse an imported Google/CAS fontHash already present in workspace state, together with fontFamily; never invent hashes." : ARTBOARD_WRITE_TOOLS.includes(name as never) ? "Create a validated proposal operation. Never applies it." : "Read bounded Artboard workspace state.", inputSchema: schemas[name],
}));
