import type { GraphEdge, GraphNode } from '../domain/project';
import { findCycle, validateGraph, type DirectedGraph, type GraphValidationIssue } from './graph';

export class CycleError extends Error {
  constructor(readonly cycle: string[]) {
    super(`Workflow contains a cycle: ${cycle.join(' -> ')}`);
    this.name = 'CycleError';
  }
}

export class GraphValidationError extends Error {
  constructor(readonly issues: GraphValidationIssue[]) {
    super(`Workflow graph is invalid: ${issues.map((issue) => issue.message).join('; ')}`);
    this.name = 'GraphValidationError';
  }
}

export type ExecutionPlan = {
  orderedNodeIds: string[];
  parallelStages: string[][];
};

function ancestorsOf(targetIds: ReadonlySet<string>, edges: readonly GraphEdge[]): Set<string> {
  const result = new Set(targetIds);
  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
    const list = incoming.get(edge.targetNodeId) ?? [];
    list.push(edge.sourceNodeId);
    incoming.set(edge.targetNodeId, list);
  }
  const queue = [...targetIds];
  while (queue.length) {
    for (const source of incoming.get(queue.shift()!) ?? []) {
      if (!result.has(source)) { result.add(source); queue.push(source); }
    }
  }
  return result;
}

export function createExecutionPlan(
  graph: DirectedGraph,
  options: { targetNodeIds?: readonly string[] } = {},
): ExecutionPlan {
  const issues = validateGraph(graph);
  if (issues.length) throw new GraphValidationError(issues);
  if (options.targetNodeIds) {
    const known = new Set(graph.nodes.map((node) => node.id));
    const unknown = options.targetNodeIds.filter((id) => !known.has(id));
    if (unknown.length) throw new GraphValidationError(unknown.map((id) => ({ code: 'dangling-target', id, message: `Unknown target node: ${id}` })));
  }
  const cycle = findCycle(graph);
  if (cycle) throw new CycleError(cycle);

  const known = new Set(graph.nodes.map((node) => node.id));
  const selected = options.targetNodeIds
    ? ancestorsOf(new Set(options.targetNodeIds), graph.edges)
    : known;
  const nodes = graph.nodes.filter((node) => selected.has(node.id));
  const edges = graph.edges.filter((edge) => selected.has(edge.sourceNodeId) && selected.has(edge.targetNodeId));
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) {
    indegree.set(edge.targetNodeId, (indegree.get(edge.targetNodeId) ?? 0) + 1);
    outgoing.get(edge.sourceNodeId)?.push(edge.targetNodeId);
  }

  const position = new Map(nodes.map((node, index) => [node.id, index]));
  let ready = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  const parallelStages: string[][] = [];
  while (ready.length) {
    const stage = ready.sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));
    parallelStages.push(stage);
    const next = new Set<string>();
    for (const id of stage) {
      for (const target of outgoing.get(id) ?? []) {
        const remaining = (indegree.get(target) ?? 0) - 1;
        indegree.set(target, remaining);
        if (remaining === 0) next.add(target);
      }
    }
    ready = [...next];
  }
  return { parallelStages, orderedNodeIds: parallelStages.flat() };
}

export function dependenciesFor(nodeId: string, edges: readonly GraphEdge[]): string[] {
  return [...new Set(edges.filter((edge) => edge.targetNodeId === nodeId)
    .sort((a, b) => a.targetPortId.localeCompare(b.targetPortId) || a.order - b.order || a.id.localeCompare(b.id))
    .map((edge) => edge.sourceNodeId))];
}

export type PlannableGraph = { nodes: readonly GraphNode[]; edges: readonly GraphEdge[] };
