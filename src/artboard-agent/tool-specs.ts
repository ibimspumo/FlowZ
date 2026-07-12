import { ARTBOARD_READ_TOOLS, ARTBOARD_WRITE_TOOLS, type ArtboardAgentToolName } from "./tool-contract";

export type AgentToolSpec = { name: ArtboardAgentToolName; description: string; inputSchema: Record<string, unknown> };

const id = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" };
const base = { workspaceId: id, branchId: id };
const write = { ...base, proposalId: id, operationId: id, expectedRevision: { type: "integer", minimum: 0 } };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const ids = { type: "array", items: id, maxItems: 20, uniqueItems: true };

const schemas: Record<ArtboardAgentToolName, Record<string, unknown>> = {
  get_workspace_info: object(base), get_selection: object(base),
  get_board: object({ ...base, boardId: id }), get_layer_tree: object({ ...base, boardId: id }),
  get_layers: object({ ...base, layerIds: ids }), get_bound_inputs: object({ ...base, bindingIds: ids }),
  render_preview: object({ ...base, boardId: id, width: { type: "number", minimum: 1, maximum: 2048 }, height: { type: "number", minimum: 1, maximum: 2048 } }),
  create_layers: object({ ...write, boardId: id, layers: { type: "array", minItems: 1, maxItems: 20, items: { type: "object" } } }),
  update_layers: object({ ...write, boardId: id, layers: { type: "array", minItems: 1, maxItems: 20, items: { type: "object" } } }),
  delete_layers: object({ ...write, boardId: id, layerIds: ids }), duplicate_layers: object({ ...write, boardId: id, layerIds: ids }), reorder_layers: object({ ...write, boardId: id, layerIds: ids }),
  set_board_properties: object({ ...write, boardId: id, name: { type: "string", maxLength: 160 }, width: { type: "number", minimum: 1, maximum: 32768 }, height: { type: "number", minimum: 1, maximum: 32768 }, backgroundColor: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" } }, ["workspaceId", "branchId", "proposalId", "operationId", "expectedRevision", "boardId"]),
  bind_layer_resource: object({ ...write, boardId: id, layerId: id, bindingId: id }),
  propose_image_generation: object({ ...write, boardId: id, prompt: { type: "string", minLength: 1, maxLength: 8000 }, role: { type: "string", minLength: 1, maxLength: 80 }, aspectRatio: { type: "string", pattern: "^\\d{1,2}:\\d{1,2}$" }, referenceBindingIds: ids }),
  finish_working: object(write),
};

export const ARTBOARD_AGENT_TOOL_SPECS: readonly AgentToolSpec[] = [...ARTBOARD_READ_TOOLS, ...ARTBOARD_WRITE_TOOLS].map((name) => ({
  name, description: ARTBOARD_WRITE_TOOLS.includes(name as never) ? "Create a validated proposal operation. Never applies it." : "Read bounded Artboard workspace state.", inputSchema: schemas[name],
}));
