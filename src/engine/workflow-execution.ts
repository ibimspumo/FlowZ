import type { GraphEdge, GraphNode } from '../domain/project';
import { createExecutionPlan, type ExecutionPlan } from './planner';

export type WorkflowNodeSnapshot = Pick<GraphNode, 'id' | 'updatePolicy'> & {
  status: 'idle' | 'stale' | 'running' | 'fresh' | 'temporary' | 'error';
  executable: boolean;
};

export function eligibleAutomaticTargets(nodes: readonly WorkflowNodeSnapshot[], edges: readonly GraphEdge[]): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, string[]>();
  for (const edge of edges) incoming.set(edge.targetNodeId, [...(incoming.get(edge.targetNodeId) ?? []), edge.sourceNodeId]);
  const ready = (id: string, seen = new Set<string>()): boolean => {
    if (seen.has(id)) return false; seen.add(id);
    return (incoming.get(id) ?? []).every((sourceId) => {
      const source = byId.get(sourceId); if (!source) return false;
      if (!source.executable) return source.status !== 'running' && source.status !== 'error';
      if (source.updatePolicy === 'frozen') return true;
      return source.status === 'fresh' && ready(sourceId, new Set(seen));
    });
  };
  return nodes.filter((node) => node.executable && node.updatePolicy === 'auto' && node.status === 'stale' && ready(node.id)).map((node) => node.id);
}
export type FailureDecision = 'retry' | 'skip' | 'abort';
export type WorkflowFailure = { nodeId: string; message: string };
export type WorkflowRunResult = {
  state: 'completed' | 'cancelled' | 'aborted';
  executed: string[];
  skipped: string[];
  failed: WorkflowFailure[];
};

export type WorkflowExecutionOptions = {
  nodes: readonly WorkflowNodeSnapshot[];
  graphNodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  targetNodeIds?: readonly string[];
  signal: AbortSignal;
  execute: (nodeId: string) => Promise<void>;
  cancel: (nodeId: string) => Promise<void> | void;
  onFailure: (failure: WorkflowFailure) => Promise<FailureDecision>;
  onProgress?: (completed: number, total: number, nodeId: string) => void;
  plan?: ExecutionPlan;
  revalidate?: (nodeId: string) => Promise<'run' | 'fresh' | 'blocked'>;
};

function descendantsOf(rootId: string, edges: readonly GraphEdge[]): Set<string> {
  const descendants = new Set<string>(); const queue = [rootId];
  while (queue.length) {
    const current = queue.shift()!;
    for (const edge of edges) if (edge.sourceNodeId === current && !descendants.has(edge.targetNodeId)) {
      descendants.add(edge.targetNodeId); queue.push(edge.targetNodeId);
    }
  }
  return descendants;
}

/**
 * Runs the real mounted node handlers according to a deterministic DAG plan.
 * Fresh, frozen and source-only nodes are intentionally never paid/re-run.
 */
export async function executeWorkflow(options: WorkflowExecutionOptions): Promise<WorkflowRunResult> {
  const plan = options.plan ?? createExecutionPlan({ nodes: options.graphNodes, edges: options.edges }, { targetNodeIds: options.targetNodeIds });
  const snapshots = new Map(options.nodes.map((node) => [node.id, node]));
  const candidates = new Set(plan.orderedNodeIds.filter((id) => {
    const node = snapshots.get(id);
    return Boolean(node?.executable && node.updatePolicy !== 'frozen' && node.status !== 'fresh' && node.status !== 'running');
  }));
  const total = candidates.size; const executed: string[] = []; const skipped = new Set<string>(); const failed: WorkflowFailure[] = [];
  const running = new Set<string>(); let completed = 0;
  const abortRunning = async () => { await Promise.all([...running].map((id) => Promise.resolve(options.cancel(id)).catch(() => undefined))); };
  let abortPromise = Promise.resolve();
  options.signal.addEventListener('abort', () => { abortPromise = abortRunning(); }, { once: true });

  for (const stage of plan.parallelStages) {
    if (options.signal.aborted) { await abortPromise; await abortRunning(); return { state: 'cancelled', executed, skipped: [...skipped], failed }; }
    const runnable: string[] = [];
    for (const id of stage.filter((candidate) => candidates.has(candidate) && !skipped.has(candidate))) {
      const validation = await options.revalidate?.(id) ?? 'run';
      if (validation === 'run') { runnable.push(id); continue; }
      if (validation === 'fresh') { candidates.delete(id); completed += 1; options.onProgress?.(completed, total, id); continue; }
      const newlyBlocked = [id, ...descendantsOf(id, options.edges)].filter((candidate) => candidates.has(candidate) && !skipped.has(candidate));
      newlyBlocked.forEach((candidate) => skipped.add(candidate)); completed += newlyBlocked.length;
      options.onProgress?.(completed, total, id);
    }
    const outcomes = await Promise.all(runnable.map(async (nodeId) => {
      running.add(nodeId);
      try { await options.execute(nodeId); return { nodeId } as const; }
      catch (error) { return { nodeId, error: error instanceof Error ? error.message : String(error) } as const; }
      finally { running.delete(nodeId); }
    }));
    for (const outcome of outcomes) {
      if (options.signal.aborted) { await abortPromise; await abortRunning(); return { state: 'cancelled', executed, skipped: [...skipped], failed }; }
      if (!('error' in outcome)) {
        executed.push(outcome.nodeId); completed += 1; options.onProgress?.(completed, total, outcome.nodeId); continue;
      }
      let failure: WorkflowFailure = { nodeId: outcome.nodeId, message: outcome.error ?? 'Unbekannter Ausführungsfehler' };
      failed.push(failure);
      while (true) {
        const decision = await options.onFailure(failure);
        if (decision === 'abort') { await abortRunning(); return { state: 'aborted', executed, skipped: [...skipped], failed }; }
        if (decision === 'skip') {
          const newlySkipped = [outcome.nodeId, ...descendantsOf(outcome.nodeId, options.edges)].filter((candidate) => candidates.has(candidate) && !skipped.has(candidate));
          newlySkipped.forEach((candidate) => skipped.add(candidate)); completed += newlySkipped.length;
          options.onProgress?.(completed, total, outcome.nodeId); break;
        }
        if (options.signal.aborted) return { state: 'cancelled', executed, skipped: [...skipped], failed };
        try {
          await options.execute(outcome.nodeId); executed.push(outcome.nodeId); completed += 1;
          options.onProgress?.(completed, total, outcome.nodeId); break;
        } catch (error) {
          failure = { nodeId: outcome.nodeId, message: error instanceof Error ? error.message : String(error) };
          failed.push(failure);
        }
      }
    }
  }
  return { state: options.signal.aborted ? 'cancelled' : 'completed', executed, skipped: [...skipped], failed };
}
