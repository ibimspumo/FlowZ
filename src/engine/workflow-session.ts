import type { ExecutionPlan } from './planner';
import type { NodeExecutionLease } from './node-execution-bridge';

export type WorkflowRunSession = Readonly<{
  projectId: string; generation: number; plan: ExecutionPlan;
  leases: ReadonlyMap<string, NodeExecutionLease>; controller: AbortController;
}>;
let generation = 0;
export function createWorkflowRunSession(projectId: string, plan: ExecutionPlan, leases: ReadonlyMap<string, NodeExecutionLease>): WorkflowRunSession {
  return Object.freeze({ projectId, generation: ++generation, plan: Object.freeze({ orderedNodeIds: Object.freeze([...plan.orderedNodeIds]), parallelStages: Object.freeze(plan.parallelStages.map((stage) => Object.freeze([...stage]))) }) as ExecutionPlan, leases: new Map(leases), controller: new AbortController() });
}
