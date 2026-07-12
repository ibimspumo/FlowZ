export type ExecutionCost = { paid: boolean; estimateMicrounits?: number };
export type NodeExecutionHandler = { execute: () => Promise<void>; cancel: () => Promise<void> | void; cost: ExecutionCost };
export type NodeExecutionLease = Readonly<NodeExecutionHandler & { projectId: string; nodeId: string; generation: number }>;

const handlers = new Map<string, NodeExecutionLease>(); let generation = 0;
const key = (projectId: string, nodeId: string) => `${projectId}\0${nodeId}`;

export function registerNodeExecution(projectId: string, nodeId: string, handler: NodeExecutionHandler): () => void {
  const lease = Object.freeze({ ...handler, projectId, nodeId, generation: ++generation });
  handlers.set(key(projectId, nodeId), lease);
  return () => { if (handlers.get(key(projectId, nodeId)) === lease) handlers.delete(key(projectId, nodeId)); };
}

export function leaseNodeExecution(projectId: string, nodeId: string): NodeExecutionLease | undefined { return handlers.get(key(projectId, nodeId)); }
export function hasNodeExecution(projectId: string, nodeId: string): boolean { return handlers.has(key(projectId, nodeId)); }
export function summarizeExecutionCosts(leases: Iterable<NodeExecutionLease>) {
  const paid = [...leases].filter((lease) => lease.cost.paid);
  return { paid: paid.length, estimateMicrounits: paid.reduce((sum, lease) => sum + (lease.cost.estimateMicrounits ?? 0), 0), unknown: paid.filter((lease) => lease.cost.estimateMicrounits == null).length };
}
