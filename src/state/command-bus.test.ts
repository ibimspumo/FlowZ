import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION, type GraphNode, type ProjectDocument } from '../domain/project';
import { RuntimeStore } from '../runtime/store';
import { CommandBus } from './command-bus';
import { addGroup, addNode, assignNodesToGroup, connect, deleteGroup, deleteNode, disconnect, moveNode, updateGroup, updateNodeConfig, updateNodePolicy } from './commands';

const node = (id: string): GraphNode => ({
  id, moduleId: 'core.text-input', moduleVersion: 1, position: { x: 0, y: 0 }, config: { text: '' }, updatePolicy: 'manual',
});

const project = (): ProjectDocument => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  id: 'project', name: 'Project', createdAt: 't0', updatedAt: 't0',
  graph: { nodes: [node('a'), node('b')], edges: [], groups: [] },
  canvas: { viewport: { x: 0, y: 0, zoom: 1 } },
});

describe('CommandBus', () => {
  it('undoes and redoes graph commands', () => {
    const bus = new CommandBus(project());
    bus.execute(addNode(node('c')));
    expect(bus.current.graph.nodes.map(({ id }) => id)).toEqual(['a', 'b', 'c']);
    bus.undo();
    expect(bus.current.graph.nodes.map(({ id }) => id)).toEqual(['a', 'b']);
    bus.redo();
    expect(bus.current.graph.nodes.map(({ id }) => id)).toEqual(['a', 'b', 'c']);
  });

  it('restores a deleted node with edges and group membership exactly', () => {
    const bus = new CommandBus(project());
    bus.runTransaction('Prepare', () => {
      bus.execute(connect({ id: 'edge', sourceNodeId: 'a', sourcePortId: 'out', targetNodeId: 'b', targetPortId: 'in', order: 0 }));
      bus.execute(addGroup({ id: 'group', name: 'Flow', nodeIds: ['a', 'b'] }));
    });
    const prepared = bus.current;
    bus.execute(deleteNode('a'));
    expect(bus.current.graph.nodes.map(({ id }) => id)).toEqual(['b']);
    expect(bus.current.graph.edges).toEqual([]);
    expect(bus.current.graph.groups[0].nodeIds).toEqual(['b']);
    bus.undo();
    expect(bus.current).toBe(prepared);
  });

  it('groups a transaction into one history entry', () => {
    const bus = new CommandBus(project());
    bus.runTransaction('Build group', () => {
      bus.execute(addGroup({ id: 'g', name: 'Group', nodeIds: [] }));
      bus.execute(assignNodesToGroup('g', ['a', 'b']));
      bus.execute(disconnect('missing'));
    });
    expect(bus.undoDepth).toBe(1);
    expect(bus.current.graph.groups[0].nodeIds).toEqual(['a', 'b']);
    bus.undo();
    expect(bus.current.graph.groups).toEqual([]);
  });

  it('persists rename, ungroup and update policies through undo/redo', () => {
    const bus = new CommandBus(project());
    bus.execute(addGroup({ id: 'g', name: 'Erster Name', nodeIds: ['a', 'b'] }));
    bus.execute(updateGroup('g', { name: 'Marken-Workflow' }));
    bus.execute(updateNodePolicy('b', 'auto'));
    expect(bus.current.graph.groups[0].name).toBe('Marken-Workflow');
    expect(bus.current.graph.nodes[1].updatePolicy).toBe('auto');
    bus.execute(deleteGroup('g')); expect(bus.current.graph.groups).toEqual([]);
    bus.undo(); expect(bus.current.graph.groups[0].name).toBe('Marken-Workflow');
    bus.undo(); expect(bus.current.graph.nodes[1].updatePolicy).toBe('manual');
    bus.redo(); expect(bus.current.graph.nodes[1].updatePolicy).toBe('auto');
  });

  it('rolls back a failed transaction without creating history', () => {
    const bus = new CommandBus(project());
    expect(() => bus.runTransaction('Fail', () => {
      bus.execute(addNode(node('c')));
      throw new Error('stop');
    })).toThrow('stop');
    expect(bus.current.graph.nodes.map(({ id }) => id)).toEqual(['a', 'b']);
    expect(bus.undoDepth).toBe(0);
  });

  it('coalesces continuous moves and text edits independently', () => {
    const bus = new CommandBus(project());
    bus.execute(moveNode('a', { x: 10, y: 10 }));
    bus.execute(moveNode('a', { x: 20, y: 30 }));
    expect(bus.undoDepth).toBe(1);
    bus.execute(updateNodeConfig('a', { text: 'H' }));
    bus.execute(updateNodeConfig('a', { text: 'Hi' }));
    expect(bus.undoDepth).toBe(2);
    bus.undo();
    expect(bus.current.graph.nodes[0].config.text).toBe('');
    expect(bus.current.graph.nodes[0].position).toEqual({ x: 20, y: 30 });
    bus.undo();
    expect(bus.current.graph.nodes[0].position).toEqual({ x: 0, y: 0 });
  });

  it('starts a new undo step after the gesture coalescing boundary', () => {
    const bus = new CommandBus(project());
    bus.execute(moveNode('a', { x: 1, y: 1 }));
    bus.endCoalescing();
    bus.execute(moveNode('a', { x: 2, y: 2 }));
    expect(bus.undoDepth).toBe(2);
    bus.undo();
    expect(bus.current.graph.nodes[0].position).toEqual({ x: 1, y: 1 });
  });

  it('never includes runtime executions or results in structural undo', () => {
    const initial = project();
    const bus = new CommandBus(initial);
    const runtime = new RuntimeStore();
    runtime.queueRun({ id: 'run', nodeId: 'a', fingerprintSnapshot: 'fp', createdAt: 't0', startedAt: 't1' });
    runtime.completeRun('run', {
      resultId: 'result', completedAt: 't2', currentFingerprint: 'fp',
      outputs: { text: { kind: 'scalar', value: { type: 'text', value: 'kept' } } },
    });
    bus.execute(moveNode('a', { x: 1, y: 1 }));
    bus.undo();

    expect(bus.current).toEqual(initial);
    expect(runtime.getActiveResult('a')?.id).toBe('result');
    expect(runtime.results.size).toBe(1);
  });

  it('enforces a bounded history', () => {
    const bus = new CommandBus(project(), 2);
    bus.execute(addNode(node('c')));
    bus.execute(addNode(node('d')));
    bus.execute(addNode(node('e')));
    expect(bus.undoDepth).toBe(2);
    bus.undo();
    bus.undo();
    expect(bus.current.graph.nodes.map(({ id }) => id)).toEqual(['a', 'b', 'c']);
    expect(bus.canUndo).toBe(false);
  });

  it('keeps current documents immutable and updates timestamps through an injected clock', () => {
    const source = project();
    const bus = new CommandBus(source, 100, () => 't1');
    bus.execute(moveNode('a', { x: 4, y: 5 }));
    expect(bus.current.updatedAt).toBe('t1');
    expect(Object.isFrozen(bus.current)).toBe(true);
    expect(Object.isFrozen(bus.current.graph.nodes)).toBe(true);
    source.graph.nodes[0].position.x = 999;
    expect(bus.current.graph.nodes[0].position.x).toBe(4);
    expect(Object.isFrozen(bus.undoHistory)).toBe(true);
  });

  it('coalesces config edits only within the same field and edit session', () => {
    const bus = new CommandBus(project());
    bus.execute(updateNodeConfig('a', { text: 'A' }, { field: 'text', sessionId: 'focus-1' }));
    bus.execute(updateNodeConfig('a', { text: 'AB' }, { field: 'text', sessionId: 'focus-1' }));
    bus.execute(updateNodeConfig('a', { text: 'ABC' }, { field: 'text', sessionId: 'focus-2' }));
    bus.execute(updateNodeConfig('a', { placeholder: 'Hint' }, { field: 'placeholder', sessionId: 'focus-2' }));
    expect(bus.undoDepth).toBe(3);
  });

  it('closes coalescing even when a transaction fails', () => {
    const bus = new CommandBus(project());
    bus.execute(moveNode('a', { x: 1, y: 1 }));
    expect(() => bus.runTransaction('fail', () => {
      bus.execute(moveNode('a', { x: 2, y: 2 }));
      throw new Error('stop');
    })).toThrow();
    bus.execute(moveNode('a', { x: 3, y: 3 }));
    expect(bus.undoDepth).toBe(2);
  });
});
