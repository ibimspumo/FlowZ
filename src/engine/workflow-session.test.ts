import { describe, expect, it, vi } from 'vitest';
import { leaseNodeExecution, registerNodeExecution, summarizeExecutionCosts } from './node-execution-bridge';
import { createWorkflowRunSession } from './workflow-session';

describe('project-bound workflow sessions', () => {
  it('never leases a same-id handler across projects and retains cancellation after unmount', async () => {
    const cancelA = vi.fn(); const cancelB = vi.fn();
    const releaseA = registerNodeExecution('project-a', 'same', { execute: async () => undefined, cancel: cancelA, cost: { paid: true, estimateMicrounits: 18_000 } });
    const releaseB = registerNodeExecution('project-b', 'same', { execute: async () => undefined, cancel: cancelB, cost: { paid: true } });
    const lease = leaseNodeExecution('project-a', 'same')!; releaseA();
    expect(leaseNodeExecution('project-a', 'same')).toBeUndefined(); expect(leaseNodeExecution('project-b', 'same')).toBeDefined();
    await lease.cancel(); expect(cancelA).toHaveBeenCalledOnce(); expect(cancelB).not.toHaveBeenCalled(); releaseB();
  });

  it('creates an immutable generation with exact plan, leases and cost preflight', () => {
    const release = registerNodeExecution('p', 'n', { execute: async () => undefined, cancel: () => undefined, cost: { paid: true, estimateMicrounits: 5_000 } });
    const lease = leaseNodeExecution('p', 'n')!; const plan = { orderedNodeIds: ['n'], parallelStages: [['n']] };
    const session = createWorkflowRunSession('p', plan, new Map([['n', lease]]));
    expect(Object.isFrozen(session)).toBe(true); expect(session.projectId).toBe('p'); expect(session.plan.orderedNodeIds).toEqual(['n']);
    expect(summarizeExecutionCosts(session.leases.values())).toEqual({ paid: 1, estimateMicrounits: 5_000, unknown: 0 }); release();
  });
});
