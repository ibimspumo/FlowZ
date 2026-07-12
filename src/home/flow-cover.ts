export type FlowCoverNode = { id: string; x: number; y: number; width: number; height: number; color: string };
export type FlowCoverEdge = { sourceId: string; targetId: string; color: string };
export type FlowCoverGroup = { x: number; y: number; width: number; height: number; color: string };
export type FlowCoverInput = { nodes: FlowCoverNode[]; edges: FlowCoverEdge[]; groups: FlowCoverGroup[] };
export type FlowCoverModel = FlowCoverInput & { viewBox: { x: number; y: number; width: number; height: number }; fingerprint: string };

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value);
};

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function createFlowCoverModel(input: FlowCoverInput): FlowCoverModel {
  const nodes = input.nodes.slice().sort((a, b) => a.id.localeCompare(b.id));
  const ids = new Set(nodes.map((node) => node.id));
  const edges = input.edges.filter((edge) => ids.has(edge.sourceId) && ids.has(edge.targetId)).slice().sort((a, b) => `${a.sourceId}:${a.targetId}:${a.color}`.localeCompare(`${b.sourceId}:${b.targetId}:${b.color}`));
  const groups = input.groups.slice().sort((a, b) => a.x - b.x || a.y - b.y || a.width - b.width || a.height - b.height || a.color.localeCompare(b.color));
  const boxes = [...nodes, ...groups];
  const minX = boxes.length ? Math.min(...boxes.map((box) => box.x)) : 0;
  const minY = boxes.length ? Math.min(...boxes.map((box) => box.y)) : 0;
  const maxX = boxes.length ? Math.max(...boxes.map((box) => box.x + box.width)) : 512;
  const maxY = boxes.length ? Math.max(...boxes.map((box) => box.y + box.height)) : 320;
  const padding = 32;
  const viewBox = { x: minX - padding, y: minY - padding, width: Math.max(1, maxX - minX + padding * 2), height: Math.max(1, maxY - minY + padding * 2) };
  const payload = { nodes, edges, groups, viewBox };
  return { ...payload, fingerprint: `flow-cover-v1-${hashString(stable(payload))}` };
}

export class LatestCoverJob {
  private generation = 0;
  begin(): { generation: number; isCurrent: () => boolean } {
    const generation = ++this.generation;
    return { generation, isCurrent: () => generation === this.generation };
  }
  cancel() { this.generation += 1; }
}
