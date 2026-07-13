import type { GraphEdge, GraphNode, WorkflowGroup } from '../domain';
import { moduleForKind } from '../app/adapters';
import { registry } from '../registry';
import type { CanvasTemplate } from './types';
import { assertValidTemplate } from './validation';
import { localizeTemplateMeta } from '../i18n';
import { templateById } from './registry';
import { materializedTemplateEdgeOrders } from './edge-order';

export type MaterializedTemplate = { nodes: GraphNode[]; edges: GraphEdge[]; groups: WorkflowGroup[] };

export function materializeTemplate(template: CanvasTemplate, anchor: { x: number; y: number }, id: () => string = () => crypto.randomUUID()): MaterializedTemplate {
  const canonical=templateById(template.id)??template;template=localizeTemplateMeta(canonical);
  assertValidTemplate(canonical);
  const minX = Math.min(...template.nodes.map((node) => node.x));
  const minY = Math.min(...template.nodes.map((node) => node.y));
  const ids = new Map(template.nodes.map((node) => [node.id, `${node.kind}-${id()}`]));
  const nodes = template.nodes.map((node,index): GraphNode => {
    const canonicalNode=canonical.nodes[index]??node;
    const definition = registry[node.kind];
    const defaults = node.kind === 'textInput' ? { text: String(definition.defaults.value ?? '') } : definition.defaults;
    return {
      id: ids.get(node.id)!, moduleId: moduleForKind(node.kind), moduleVersion: 1,
      position: { x: anchor.x + node.x - minX, y: anchor.y + node.y - minY },
      label: canonicalNode.label ?? definition.label,labelId:`template:${canonical.id}:${canonicalNode.id}`,
      config: { ...defaults, ...node.config } as GraphNode['config'],
      updatePolicy: node.updatePolicy ?? 'manual',
    };
  });
  const edgeOrders = materializedTemplateEdgeOrders(template);
  const edges = template.edges.map((edge, index): GraphEdge => ({
    id: `edge-${id()}`, sourceNodeId: ids.get(edge.source)!, sourcePortId: edge.sourcePort,
    targetNodeId: ids.get(edge.target)!, targetPortId: edge.targetPort, order: edgeOrders[index],
  }));
  const groups = template.groups.map((group): WorkflowGroup => ({
    ...group, id: `group-${id()}`, nodeIds: group.nodeIds.map((nodeId) => ids.get(nodeId)!),
  }));
  return { nodes, edges, groups };
}
