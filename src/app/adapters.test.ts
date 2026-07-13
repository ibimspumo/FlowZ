import { describe, expect, it } from 'vitest';
import type { GraphNode, ProjectDocument } from '../domain';
import { configPatchFor, connectionCreatesCycle, edgeToFlow, flowEdgeToGraph, nextInputOrder, nodeToFlow } from './adapters';

const document: ProjectDocument = {
  schemaVersion: 2, id: '00000000-0000-4000-8000-000000000001', name: 'Adapter',
  createdAt: '2026-07-11T00:00:00.000Z', updatedAt: '2026-07-11T00:00:00.000Z',
  graph: {
    nodes: [
      { id: 'a', moduleId: 'core.text-input', moduleVersion: 1, position: { x: 1, y: 2 }, config: { text: 'Hallo' }, updatePolicy: 'manual' },
      { id: 'b', moduleId: 'ai.text-generation', moduleVersion: 1, position: { x: 3, y: 4 }, config: {}, updatePolicy: 'manual' },
    ],
    edges: [{ id: 'e1', sourceNodeId: 'a', sourcePortId: 'text', targetNodeId: 'b', targetPortId: 'prompt', order: 0 }], groups: [],
  }, canvas: { viewport: { x: 8, y: 9, zoom: 1.2 } },
};

describe('React Flow adapters', () => {
  it('maps the hidden immutable video collection and keeps its typed output', () => {
    const node: GraphNode = { id: 'vc', moduleId: 'core.video-collection', moduleVersion: 1, position: { x: 0, y: 0 }, config: { collectionResultIds: ['result'] }, updatePolicy: 'frozen' };
    expect(nodeToFlow(node).data.kind).toBe('videoCollection');
    expect(edgeToFlow({ id: 'list', sourceNodeId: 'vc', sourcePortId: 'videos', targetNodeId: 'b', targetPortId: 'videoLists', order: 0 }, [...document.graph.nodes, node]).data?.dataType).toBe('videoList');
    expect(edgeToFlow({ id: 'one', sourceNodeId: 'vc', sourcePortId: 'variant:result', targetNodeId: 'b', targetPortId: 'video', order: 0 }, [...document.graph.nodes, node]).data?.dataType).toBe('video');
  });
  it('keeps document config and ordered many-inputs on their real canonical handle', () => {
    expect(nodeToFlow(document.graph.nodes[0]).data.value).toBe('Hallo');
    const flow = edgeToFlow(document.graph.edges[0], document.graph.nodes);
    expect(flow.targetHandle).toBe('prompt');
    expect(flowEdgeToGraph(flow, 2)).toMatchObject({ targetPortId: 'prompt', order: 2 });
    expect(nextInputOrder(document, 'b', 'prompt')).toBe(1);
  });

  it('rejects a reconnect that closes a cycle', () => {
    const reverse = { id: 'reverse', sourceNodeId: 'b', sourcePortId: 'text', targetNodeId: 'a', targetPortId: 'input', order: 0 };
    expect(connectionCreatesCycle(document, reverse)).toBe(true);
  });

  it('bridges persisted media hashes without embedding media bytes', () => {
    const hash = 'a'.repeat(64);
    const video = nodeToFlow({ id: 'v', moduleId: 'core.video-input', moduleVersion: 1, position: { x: 0, y: 0 }, config: { blobHash: hash, fileName: 'clip.mp4', mediaType: 'video/mp4', mediaMetadata: { kind: 'video', container: 'mov,mp4', codecs: ['h264'], durationSeconds: 2, width: 1920, height: 1080, fps: 25, playable: true } }, updatePolicy: 'manual' });
    expect(video.data.kind).toBe('videoInput');
    expect(video.data.value).toBeUndefined();
    expect(video.data.status).toBe('idle');
    expect(JSON.stringify(video.data)).not.toContain('data:video');
  });

  it('restores dynamic variant edges as image edges', () => {
    const nodes: GraphNode[] = [
      { id: 'source', moduleId: 'ai.image-generation', moduleVersion: 1, position: { x: 0, y: 0 }, config: { fanOutResultIds: ['result'] }, updatePolicy: 'manual' as const },
      { id: 'target', moduleId: 'ai.image-analysis', moduleVersion: 1, position: { x: 1, y: 0 }, config: {}, updatePolicy: 'manual' as const },
    ];
    const edge = edgeToFlow({ id: 'variant-edge', sourceNodeId: 'source', sourcePortId: 'variant:result', targetNodeId: 'target', targetPortId: 'image', order: 0 }, nodes);
    expect(edge.data?.dataType).toBe('image');
  });

  it('persists deliberate variant and list processing settings', () => {
    expect(configPatchFor('textGeneration', { variantCount: 4, listProcessingMode: 'map' })).toEqual({ variantCount: 4, listProcessingMode: 'map' });
    expect(configPatchFor('imageAnalysis', { listProcessingMode: 'aggregate' })).toEqual({ listProcessingMode: 'aggregate' });
  });

  it('marks typed list cables visually without changing their semantic type', () => {
    const nodes: GraphNode[] = [
      { id: 'v', moduleId: 'ai.image-generation', moduleVersion: 1, position: { x: 0, y: 0 }, config: {}, updatePolicy: 'manual' },
      { id: 'e', moduleId: 'ai.image-analysis', moduleVersion: 1, position: { x: 1, y: 0 }, config: {}, updatePolicy: 'manual' },
    ];
    const flow = edgeToFlow({ id: 'images', sourceNodeId: 'v', sourcePortId: 'images', targetNodeId: 'e', targetPortId: 'imageLists', order: 0 }, nodes);
    expect(flow.data?.dataType).toBe('imageList'); expect(flow.className).toBe('edge-list');
  });

  it('keeps export settings on result-producing nodes without reviving an export node', () => {
    expect(configPatchFor('imageGeneration', {
      exportFolderGrant: 'grant-1',
      exportNameTemplate: '{project}_{node}_{index}',
      exportOverwrite: 'rename',
      exportedFiles: ['result.png'],
    })).toMatchObject({
      exportFolderGrant: 'grant-1',
      exportNameTemplate: '{project}_{node}_{index}',
      exportOverwrite: 'rename',
      exportedFiles: ['result.png'],
    });
  });

  it('maps removed module ids to the normal fail-closed unsupported node', () => {
    for (const moduleId of ['context.prompt-template', 'context.text-combine', 'system.output-export']) {
      const flow = nodeToFlow({
        id: moduleId,
        moduleId,
        moduleVersion: 1,
        position: { x: 0, y: 0 },
        config: {
          // Unknown persisted config must never be able to revive removed
          // behavior or impersonate an executable node.
          kind: 'textGeneration',
          unsupportedModuleId: 'ai.text-generation',
          status: 'fresh',
          prompt: 'run me',
        },
        updatePolicy: 'manual',
      });
      expect(flow.data).toMatchObject({ kind: 'unsupported', unsupportedModuleId: moduleId });
      expect(flow.data.status).toBe('idle');
      expect(configPatchFor('unsupported', { prompt: 'still blocked' })).toEqual({});
    }
  });
});
