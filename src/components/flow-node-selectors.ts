import type { FlowEdge, FlowNode } from "../types";

export const selectLocalEdges = (edges: FlowEdge[], nodeId: string) =>
  edges.filter((edge) => edge.source === nodeId || edge.target === nodeId);

export const selectInputSources = (
  nodes: FlowNode[],
  edges: FlowEdge[],
  nodeId: string,
) => {
  const sourceIds = new Set(
    edges.filter((edge) => edge.target === nodeId).map((edge) => edge.source),
  );
  return nodes.filter((node) => sourceIds.has(node.id));
};
