import { describe, expect, it } from 'vitest';
import type { GraphEdge, GraphNode } from '../domain/project';
import { eligibleAutomaticTargets, executeWorkflow } from './workflow-execution';

const node = (id: string, updatePolicy: GraphNode['updatePolicy'] = 'manual'): GraphNode => ({ id, moduleId: 'test', moduleVersion: 1, position: { x: 0, y: 0 }, config: {}, updatePolicy });
const edge = (sourceNodeId: string, targetNodeId: string, order = 0): GraphEdge => ({ id: `${sourceNodeId}-${targetNodeId}`, sourceNodeId, sourcePortId: 'out', targetNodeId, targetPortId: 'in', order });

describe('workflow execution', () => {
  it('runs ready branches in parallel, dependencies first, and never reruns fresh/frozen nodes', async () => {
    const graphNodes = ['source','a','b','join','frozen'].map((id) => node(id, id === 'frozen' ? 'frozen' : 'manual'));
    const edges = [edge('source','a'), edge('source','b'), edge('a','join'), edge('b','join', 1), edge('join','frozen')];
    const events: string[] = []; let active = 0; let maxActive = 0;
    const result = await executeWorkflow({ graphNodes, edges, signal: new AbortController().signal,
      nodes: graphNodes.map((item) => ({ id: item.id, updatePolicy: item.updatePolicy, status: item.id === 'source' ? 'fresh' : 'stale', executable: item.id !== 'source' })),
      execute: async (id) => { active += 1; maxActive = Math.max(maxActive, active); events.push(`start:${id}`); await Promise.resolve(); active -= 1; events.push(`end:${id}`); },
      cancel: () => undefined, onFailure: async () => 'abort',
    });
    expect(result.state).toBe('completed'); expect(maxActive).toBe(2);
    expect(events.indexOf('end:a')).toBeLessThan(events.indexOf('start:join'));
    expect(events.indexOf('end:b')).toBeLessThan(events.indexOf('start:join'));
    expect(events.some((event) => event.includes('source'))).toBe(false);
    expect(events.some((event) => event.includes('frozen'))).toBe(false);
  });

  it('limits a group run to group targets plus dependencies', async () => {
    const graphNodes = ['source','grouped','outside'].map((id) => node(id)); const edges = [edge('source','grouped')]; const ran: string[] = [];
    await executeWorkflow({ graphNodes, edges, targetNodeIds: ['grouped'], signal: new AbortController().signal,
      nodes: graphNodes.map((item) => ({ id: item.id, updatePolicy: item.updatePolicy, status: 'stale', executable: item.id !== 'source' })),
      execute: async (id) => { ran.push(id); }, cancel: () => undefined, onFailure: async () => 'abort' });
    expect(ran).toEqual(['grouped']);
  });

  it('retries, skips failed descendants, continues independent branches, and cancels active work', async () => {
    const graphNodes = ['bad','blocked','good'].map((id) => node(id)); const edges = [edge('bad','blocked')]; let attempts = 0; const ran: string[] = [];
    const skipped = await executeWorkflow({ graphNodes, edges, signal: new AbortController().signal,
      nodes: graphNodes.map((item) => ({ id: item.id, updatePolicy: item.updatePolicy, status: 'stale', executable: true })),
      execute: async (id) => { ran.push(id); if (id === 'bad') throw new Error('kaputt'); }, cancel: () => undefined,
      onFailure: async () => attempts++ === 0 ? 'retry' : 'skip' });
    expect(ran.filter((id) => id === 'bad')).toHaveLength(2); expect(ran).toContain('good'); expect(ran).not.toContain('blocked');
    expect(skipped.skipped).toEqual(expect.arrayContaining(['bad','blocked']));

    const controller = new AbortController(); let cancelled = false;
    const pending = executeWorkflow({ graphNodes: [node('slow')], edges: [], signal: controller.signal,
      nodes: [{ id: 'slow', updatePolicy: 'manual', status: 'stale', executable: true }],
      execute: () => new Promise((resolve) => setTimeout(resolve, 15)), cancel: () => { cancelled = true; }, onFailure: async () => 'abort' });
    await Promise.resolve(); await Promise.resolve(); controller.abort(); expect((await pending).state).toBe('cancelled'); expect(cancelled).toBe(true);
  });

  it('auto never pulls stale manual or running predecessors into a paid run', () => {
    const edges = [edge('manual','auto')];
    const snapshots = [
      { id: 'manual', updatePolicy: 'manual' as const, status: 'stale' as const, executable: true },
      { id: 'auto', updatePolicy: 'auto' as const, status: 'stale' as const, executable: true },
    ];
    expect(eligibleAutomaticTargets(snapshots, edges)).toEqual([]);
    expect(eligibleAutomaticTargets([{ ...snapshots[0], status: 'running' }, snapshots[1]], edges)).toEqual([]);
    expect(eligibleAutomaticTargets([{ ...snapshots[0], status: 'fresh' }, snapshots[1]], edges)).toEqual(['auto']);
    expect(eligibleAutomaticTargets([{ ...snapshots[0], updatePolicy: 'frozen' }, snapshots[1]], edges)).toEqual(['auto']);
  });

  it('blocks a changed/deleted node at stage revalidation without executing descendants', async () => {
    const graphNodes = [node('a'), node('b')]; const edges = [edge('a','b')]; const ran: string[] = []; const progress: number[] = [];
    const result = await executeWorkflow({ graphNodes, edges, signal: new AbortController().signal,
      nodes: graphNodes.map((item) => ({ id: item.id, updatePolicy: item.updatePolicy, status: 'stale', executable: true })),
      execute: async (id) => { ran.push(id); }, cancel: () => undefined, onFailure: async () => 'abort',
      revalidate: async (id) => id === 'a' ? 'blocked' : 'run', onProgress: (done) => progress.push(done),
    });
    expect(ran).toEqual([]); expect(result.skipped).toEqual(expect.arrayContaining(['a','b'])); expect(progress.at(-1)).toBe(2);
  });
});
