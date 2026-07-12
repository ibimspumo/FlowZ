import type { GraphEdge, GraphNode, WorkflowGroup } from '../domain/project';

export type DirectedGraph = { nodes: readonly GraphNode[]; edges: readonly GraphEdge[] };

export type GraphValidationIssue = {
  code: 'duplicate-node' | 'duplicate-edge' | 'dangling-source' | 'dangling-target' | 'invalid-edge-order'
    | 'duplicate-edge-order' | 'duplicate-group' | 'unknown-group-node' | 'duplicate-group-member' | 'multiple-group-membership';
  id: string;
  message: string;
};

export type ValidatableGraph = DirectedGraph & { groups?: readonly WorkflowGroup[] };

export function validateGraph(graph: ValidatableGraph): GraphValidationIssue[] {
  const issues: GraphValidationIssue[] = [];
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  const groupIds = new Set<string>();
  const memberships = new Map<string, string>();
  const orders = new Set<string>();
  for (const node of graph.nodes) {
    if (nodeIds.has(node.id)) issues.push({ code: 'duplicate-node', id: node.id, message: `Duplicate node: ${node.id}` });
    nodeIds.add(node.id);
  }
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) issues.push({ code: 'duplicate-edge', id: edge.id, message: `Duplicate edge: ${edge.id}` });
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.sourceNodeId)) issues.push({ code: 'dangling-source', id: edge.id, message: `Unknown source node: ${edge.sourceNodeId}` });
    if (!nodeIds.has(edge.targetNodeId)) issues.push({ code: 'dangling-target', id: edge.id, message: `Unknown target node: ${edge.targetNodeId}` });
    if (!Number.isSafeInteger(edge.order) || edge.order < 0) issues.push({ code: 'invalid-edge-order', id: edge.id, message: `Invalid edge order: ${edge.order}` });
    const orderKey = `${edge.targetNodeId}\0${edge.targetPortId}\0${edge.order}`;
    if (orders.has(orderKey)) issues.push({ code: 'duplicate-edge-order', id: edge.id, message: `Duplicate order ${edge.order} at ${edge.targetPortId}` });
    orders.add(orderKey);
  }
  for (const group of graph.groups ?? []) {
    if (groupIds.has(group.id)) issues.push({ code: 'duplicate-group', id: group.id, message: `Duplicate group: ${group.id}` });
    groupIds.add(group.id);
    const groupMembers = new Set<string>();
    for (const nodeId of group.nodeIds) {
      if (!nodeIds.has(nodeId)) issues.push({ code: 'unknown-group-node', id: group.id, message: `Unknown grouped node: ${nodeId}` });
      if (groupMembers.has(nodeId)) issues.push({ code: 'duplicate-group-member', id: nodeId, message: `Node occurs more than once in group ${group.id}` });
      groupMembers.add(nodeId);
      const existing = memberships.get(nodeId);
      if (existing && existing !== group.id) issues.push({ code: 'multiple-group-membership', id: nodeId, message: `Node belongs to groups ${existing} and ${group.id}` });
      memberships.set(nodeId, group.id);
    }
  }
  return issues;
}

export function findCycle(graph: DirectedGraph): string[] | null {
  const outgoing = new Map<string, string[]>();
  for (const node of graph.nodes) outgoing.set(node.id, []);
  for (const edge of graph.edges) outgoing.get(edge.sourceNodeId)?.push(edge.targetNodeId);

  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    state.set(id, 1);
    stack.push(id);
    for (const target of outgoing.get(id) ?? []) {
      if (state.get(target) === 1) {
        const start = stack.indexOf(target);
        return [...stack.slice(start), target];
      }
      if (!state.get(target)) {
        const cycle = visit(target);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };

  for (const node of graph.nodes) {
    if (!state.get(node.id)) {
      const cycle = visit(node.id);
      if (cycle) return cycle;
    }
  }
  return null;
}

export function wouldCreateCycle(graph: DirectedGraph, edge: GraphEdge): boolean {
  return findCycle({ nodes: graph.nodes, edges: [...graph.edges, edge] }) !== null;
}
