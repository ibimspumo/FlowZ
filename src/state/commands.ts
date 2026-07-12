import type { GraphEdge, GraphNode, JsonValue, ProjectDocument, UpdatePolicy, WorkflowGroup } from '../domain/project';
import type { ProjectCommand } from './command-bus';

function withGraph(document: ProjectDocument, graph: ProjectDocument['graph']): ProjectDocument {
  return { ...document, graph };
}

function owned<T>(value: T): T { return structuredClone(value); }

export function addNode(node: GraphNode): ProjectCommand {
  const nodeSnapshot = owned(node);
  return {
    label: 'Node hinzufügen',
    apply: (document) => document.graph.nodes.some(({ id }) => id === nodeSnapshot.id)
      ? document
      : withGraph(document, { ...document.graph, nodes: [...document.graph.nodes, nodeSnapshot] }),
  };
}

export function deleteNode(nodeId: string): ProjectCommand {
  return {
    label: 'Node löschen',
    apply(document) {
      if (!document.graph.nodes.some(({ id }) => id === nodeId)) return document;
      return withGraph(document, {
        nodes: document.graph.nodes.filter(({ id }) => id !== nodeId),
        edges: document.graph.edges.filter((edge) => edge.sourceNodeId !== nodeId && edge.targetNodeId !== nodeId),
        groups: document.graph.groups.map((group) => ({ ...group, nodeIds: group.nodeIds.filter((id) => id !== nodeId) })).filter((group) => group.nodeIds.length > 0),
      });
    },
  };
}

export function moveNode(nodeId: string, position: GraphNode['position']): ProjectCommand {
  const positionSnapshot = owned(position);
  return {
    label: 'Node verschieben',
    coalesceKey: `move-node:${nodeId}`,
    apply(document) {
      const found = document.graph.nodes.find(({ id }) => id === nodeId);
      if (!found || (found.position.x === positionSnapshot.x && found.position.y === positionSnapshot.y)) return document;
      return withGraph(document, {
        ...document.graph,
        nodes: document.graph.nodes.map((node) => node.id === nodeId ? { ...node, position: positionSnapshot } : node),
      });
    },
  };
}

export type ConfigEditCoalescing = { field?: string; sessionId?: string };

export function updateNodeConfig(
  nodeId: string,
  patch: Readonly<Record<string, JsonValue>>,
  coalescing: ConfigEditCoalescing = {},
): ProjectCommand {
  const patchSnapshot = owned(patch);
  const fields = coalescing.field ?? Object.keys(patchSnapshot).sort().join('+');
  const session = coalescing.sessionId ?? 'default';
  return {
    label: 'Node bearbeiten',
    coalesceKey: `node-config:${nodeId}:${fields}:${session}`,
    apply(document) {
      const found = document.graph.nodes.find(({ id }) => id === nodeId);
      if (!found) return document;
      const config = { ...found.config, ...patchSnapshot };
      if (Object.keys(patchSnapshot).every((key) => Object.is(found.config[key], config[key]))) return document;
      return withGraph(document, {
        ...document.graph,
        nodes: document.graph.nodes.map((node) => node.id === nodeId ? { ...node, config } : node),
      });
    },
  };
}

export function updateNodePolicy(nodeId: string, updatePolicy: UpdatePolicy): ProjectCommand {
  return {
    label: 'Aktualisierungsmodus ändern',
    apply(document) {
      const found = document.graph.nodes.find(({ id }) => id === nodeId);
      if (!found || found.updatePolicy === updatePolicy) return document;
      return withGraph(document, { ...document.graph, nodes: document.graph.nodes.map((node) => node.id === nodeId ? { ...node, updatePolicy } : node) });
    },
  };
}

export function replaceNodeDefinition(
  nodeId: string,
  replacement: Pick<GraphNode, 'moduleId' | 'moduleVersion' | 'label' | 'labelId' | 'config'>,
): ProjectCommand {
  const snapshot = owned(replacement);
  return {
    label: 'Node-Inhalt ersetzen',
    apply(document) {
      const found = document.graph.nodes.find(({ id }) => id === nodeId);
      if (!found) return document;
      if (found.moduleId === snapshot.moduleId && found.moduleVersion === snapshot.moduleVersion
        && found.label === snapshot.label && found.labelId===snapshot.labelId && JSON.stringify(found.config) === JSON.stringify(snapshot.config)) return document;
      return withGraph(document, {
        ...document.graph,
        nodes: document.graph.nodes.map((node) => node.id === nodeId ? { ...node, ...snapshot } : node),
      });
    },
  };
}

export function connect(edge: GraphEdge): ProjectCommand {
  const edgeSnapshot = owned(edge);
  return {
    label: 'Verbindung herstellen',
    apply: (document) => document.graph.edges.some(({ id }) => id === edgeSnapshot.id)
      ? document
      : withGraph(document, { ...document.graph, edges: [...document.graph.edges, edgeSnapshot] }),
  };
}

export function disconnect(edgeId: string): ProjectCommand {
  return {
    label: 'Verbindung trennen',
    apply(document) {
      if (!document.graph.edges.some(({ id }) => id === edgeId)) return document;
      return withGraph(document, { ...document.graph, edges: document.graph.edges.filter(({ id }) => id !== edgeId) });
    },
  };
}

export function addGroup(group: WorkflowGroup): ProjectCommand {
  const groupSnapshot = owned(group);
  return {
    label: 'Gruppe hinzufügen',
    apply: (document) => document.graph.groups.some(({ id }) => id === groupSnapshot.id)
      ? document
      : withGraph(document, { ...document.graph, groups: [...document.graph.groups, groupSnapshot] }),
  };
}

export function deleteGroup(groupId: string): ProjectCommand {
  return {
    label: 'Gruppe löschen',
    apply(document) {
      if (!document.graph.groups.some(({ id }) => id === groupId)) return document;
      return withGraph(document, { ...document.graph, groups: document.graph.groups.filter(({ id }) => id !== groupId) });
    },
  };
}

export function updateGroup(groupId: string, patch: Partial<Omit<WorkflowGroup, 'id'>>): ProjectCommand {
  const patchSnapshot = owned(patch);
  return {
    label: 'Gruppe bearbeiten',
    coalesceKey: `group:${groupId}`,
    apply(document) {
      if (!document.graph.groups.some(({ id }) => id === groupId)) return document;
      return withGraph(document, {
        ...document.graph,
        groups: document.graph.groups.map((group) => group.id === groupId ? { ...group, ...patchSnapshot, id: group.id } : group),
      });
    },
  };
}

export function assignNodesToGroup(groupId: string, nodeIds: readonly string[]): ProjectCommand {
  return updateGroup(groupId, { nodeIds: [...nodeIds] });
}
