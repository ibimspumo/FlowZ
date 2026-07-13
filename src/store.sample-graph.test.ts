import { beforeEach, describe, expect, it } from 'vitest';
import { kindForModule, portType } from './app/adapters';
import { registry } from './registry';
import { sampleGraph, useFlowStore } from './store';

describe('bundled example flow', () => {
  beforeEach(async () => {
    await useFlowStore.getState().initialize();
    useFlowStore.getState().reset();
  });

  it('ships meaningful, drawable, type-safe connections against canonical ports', () => {
    const graph = sampleGraph();
    expect(graph.edges.map((edge) => `${edge.sourceNodeId}.${edge.sourcePortId}->${edge.targetNodeId}.${edge.targetPortId}`)).toEqual([
      'prompt.text->generate.prompt',
      'upload.image->generate.reference',
      'generate.image->analyse.image',
    ]);

    for (const edge of graph.edges) {
      const source = graph.nodes.find((node) => node.id === edge.sourceNodeId);
      const target = graph.nodes.find((node) => node.id === edge.targetNodeId);
      expect(source, edge.id).toBeDefined();
      expect(target, edge.id).toBeDefined();
      const sourceKind = kindForModule(source!.moduleId)!;
      const targetKind = kindForModule(target!.moduleId)!;
      const output = registry[sourceKind].outputs.find((port) => port.id === edge.sourcePortId);
      const input = registry[targetKind].inputs.find((port) => port.id === edge.targetPortId);
      expect(output, `${edge.id}: source port`).toBeDefined();
      expect(input, `${edge.id}: target port`).toBeDefined();
      expect(portType(sourceKind, 'output', edge.sourcePortId)).toBe(portType(targetKind, 'input', edge.targetPortId));
    }

    const state = useFlowStore.getState();
    expect(state.document?.graph.edges).toEqual(graph.edges);
    expect(state.edges).toHaveLength(graph.edges.length);
    for (const edge of state.edges) {
      const target = state.nodes.find((node) => node.id === edge.target)!;
      const renderedPortIds = registry[target.data.kind].inputs.map((port) => port.id);
      expect(renderedPortIds, `${edge.id}: drawable target handle`).toContain(edge.targetHandle);
    }
  });
});
