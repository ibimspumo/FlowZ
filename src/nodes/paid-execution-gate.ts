export class PaidExecutionConflictError extends Error {
  readonly code = "paid-run-in-flight";
}

type Lease = Readonly<{ contract: string; promise: Promise<void> }>;
const leases = new Map<string, Lease>();

const leaseKey = (projectId: string, nodeId: string) => `${projectId}\0${nodeId}`;

/**
 * Acquires a synchronous per-node lease before the paid executor can allocate
 * a provider run ID. Identical callers (for example a same-tick button and
 * group run) share the one operation. A changed contract is rejected until
 * the current operation settles; a later deliberate run is never retained.
 */
export function runPaidNodeOnce(request: {
  projectId: string;
  nodeId: string;
  contract: string;
  operation: () => Promise<void>;
}): Promise<void> {
  const key = leaseKey(request.projectId, request.nodeId);
  const existing = leases.get(key);
  if (existing) {
    if (existing.contract === request.contract) return existing.promise;
    return Promise.reject(new PaidExecutionConflictError("A paid run for an earlier input contract is still active."));
  }

  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  const lease: Lease = Object.freeze({ contract: request.contract, promise });
  leases.set(key, lease);
  queueMicrotask(() => {
    Promise.resolve().then(request.operation).then(
      () => { if (leases.get(key) === lease) leases.delete(key); resolve(); },
      (reason) => { if (leases.get(key) === lease) leases.delete(key); reject(reason); },
    );
  });
  return promise;
}

export function hasPaidNodeLease(projectId: string, nodeId: string): boolean {
  return leases.has(leaseKey(projectId, nodeId));
}

export function pendingPaidRunState(phase: string): "unknown" | "cancel-requested" | "in-flight" {
  const normalized = phase.toLowerCase();
  if (normalized.includes("submit_unknown") || normalized.includes("submitunknown")) return "unknown";
  if (normalized.includes("cancel_requested") || normalized.includes("cancelrequested")) return "cancel-requested";
  return "in-flight";
}
