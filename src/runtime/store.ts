import { microUnits, type JsonValue, type MicroUnitAmount } from '../domain/project';
import { isRuntimeValue, type RuntimeValue } from '../domain/values';
import type {
  NodeRuntimeState, ResultFreshness, ResultRecord, RetryMetadata, RunRecord,
  RuntimeCost, RuntimeError,
} from './types';

export type StartRunInput = {
  id: string;
  nodeId: string;
  fingerprintSnapshot: string;
  createdAt: string;
  startedAt?: string;
  updateSessionId?: string;
  retry?: Partial<RetryMetadata>;
};

export type RetryRunInput = Omit<StartRunInput, 'retry' | 'nodeId'> & { nodeId?: string };

export type CostInput = {
  amountMicros: MicroUnitAmount;
  currency: string;
  provenance: 'estimated' | 'actual';
};

export type CompleteRunInput = {
  resultId: string;
  completedAt: string;
  outputs: Readonly<Record<string, RuntimeValue>>;
  metadata?: Readonly<Record<string, JsonValue>>;
  cost?: CostInput;
  /** Fingerprint recomputed from the current document at completion time. */
  currentFingerprint: string;
};

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested, seen);
  }
  return value;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null)
    && Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function assertJsonRecord(value: unknown, label: string): asserts value is Readonly<Record<string, JsonValue>> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !isJsonValue(value)) {
    throw new TypeError(`${label} must contain JSON values only`);
  }
}

function assertOutputs(outputs: Readonly<Record<string, RuntimeValue>>): void {
  if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(outputs))) throw new TypeError('Outputs must be a plain object');
  for (const [portId, output] of Object.entries(outputs)) {
    if (!portId.trim()) throw new TypeError('Output port ids must not be empty');
    if (!isRuntimeValue(output)) throw new TypeError(`Invalid runtime value for output ${portId}`);
  }
}

function assertRuntimeError(error: RuntimeError): void {
  if (!error || typeof error !== 'object' || Array.isArray(error)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(error))) throw new TypeError('Runtime error must be a plain object');
  if (typeof error.code !== 'string' || !error.code.trim()) throw new TypeError('Runtime error code must not be empty');
  if (typeof error.message !== 'string' || !error.message.trim()) throw new TypeError('Runtime error message must not be empty');
  if (typeof error.retryable !== 'boolean') throw new TypeError('Runtime error retryable must be boolean');
  if (error.details !== undefined) assertJsonRecord(error.details, 'Runtime error details');
}

/** Clone before freezing so callers retain ownership of their input objects. */
function snapshot<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function validProgress(progress: number): number {
  if (!Number.isFinite(progress)) throw new TypeError('Progress must be finite');
  return Math.min(1, Math.max(0, progress));
}

function validCost(cost?: CostInput): RuntimeCost {
  const candidate = cost ?? { amountMicros: microUnits(0), currency: 'USD', provenance: 'estimated' as const };
  if (!Number.isSafeInteger(candidate.amountMicros) || candidate.amountMicros < 0) {
    throw new TypeError('Cost must use non-negative safe integer micro-units');
  }
  const currency = candidate.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new TypeError('Cost currency must be a three-letter ISO code');
  if (candidate.provenance !== 'estimated' && candidate.provenance !== 'actual') {
    throw new TypeError('Cost provenance must be estimated or actual');
  }
  return snapshot({ amountMicros: microUnits(candidate.amountMicros), currency, provenance: candidate.provenance });
}

/** Ephemeral execution state, deliberately outside project serialization and undo/redo. */
export class RuntimeStore {
  private readonly runRecords = new Map<string, RunRecord>();
  private readonly resultRecords = new Map<string, ResultRecord>();
  private readonly nodeStates = new Map<string, NodeRuntimeState>();
  private readonly cancellation = new Map<string, AbortController>();
  private readonly selectionRevisions = new Map<string, number>();
  private nextGeneration = 1;

  /** Snapshot maps cannot mutate store membership; their values are deeply immutable. */
  get runs(): ReadonlyMap<string, RunRecord> { return new Map(this.runRecords); }
  get results(): ReadonlyMap<string, ResultRecord> { return new Map(this.resultRecords); }
  get nodes(): ReadonlyMap<string, NodeRuntimeState> { return new Map(this.nodeStates); }

  queueRun(input: StartRunInput): AbortSignal {
    if (this.runRecords.has(input.id)) throw new Error(`Run already exists: ${input.id}`);
    const attempt = input.retry?.attempt ?? 1;
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw new TypeError('Retry attempt must be a positive integer');
    if (input.retry?.retryOfRunId) {
      const parent = this.runRecords.get(input.retry.retryOfRunId);
      if (!parent || parent.nodeId !== input.nodeId) throw new Error('Retry parent must exist and belong to the same node');
      if (parent.status !== 'error' && parent.status !== 'cancelled') throw new Error('Retry parent must be failed or cancelled');
      if (parent.status === 'error' && parent.error?.retryable !== true) throw new Error('Retry parent is not retryable');
      if (attempt !== parent.retry.attempt + 1) throw new Error('Retry attempt must increment its parent attempt');
    } else if (attempt !== 1) {
      throw new Error('A run without a retry parent must use attempt 1');
    }
    if (input.updateSessionId !== undefined && !input.updateSessionId.trim()) {
      throw new TypeError('Update session id must not be empty');
    }

    const controller = new AbortController();
    const generation = this.nextGeneration++;
    const run = snapshot<RunRecord>({
      id: input.id,
      nodeId: input.nodeId,
      fingerprintSnapshot: input.fingerprintSnapshot,
      generation,
      selectionRevisionSnapshot: this.selectionRevisions.get(input.nodeId) ?? 0,
      ...(input.updateSessionId ? { updateSessionId: input.updateSessionId } : {}),
      status: input.startedAt ? 'running' : 'queued',
      createdAt: input.createdAt,
      ...(input.startedAt ? { startedAt: input.startedAt } : {}),
      progress: 0,
      cost: validCost(),
      retry: {
        attempt,
        ...(input.retry?.retryOfRunId ? { retryOfRunId: input.retry.retryOfRunId } : {}),
      },
      resultIds: [],
    });
    this.runRecords.set(run.id, run);
    this.cancellation.set(run.id, controller);
    const previous = this.nodeStates.get(run.nodeId);
    this.nodeStates.set(run.nodeId, snapshot({
      status: run.status,
      activeRunId: run.id,
      latestRunGeneration: generation,
      ...(previous?.activeResultId ? { activeResultId: previous.activeResultId } : {}),
    }));
    return controller.signal;
  }

  retryRun(parentRunId: string, input: RetryRunInput): AbortSignal {
    const parent = this.requireRun(parentRunId);
    if (parent.status !== 'error' && parent.status !== 'cancelled') {
      throw new Error('Only failed or cancelled runs can be retried');
    }
    if (parent.status === 'error' && parent.error?.retryable !== true) throw new Error('Run error is not retryable');
    if (input.nodeId && input.nodeId !== parent.nodeId) throw new Error('Retry cannot change its parent node');
    return this.queueRun({
      ...input,
      nodeId: parent.nodeId,
      retry: { attempt: parent.retry.attempt + 1, retryOfRunId: parent.id },
    });
  }

  startRun(runId: string, startedAt: string): void {
    const run = this.requireRun(runId);
    if (run.status !== 'queued') throw new Error(`Cannot start run in ${run.status} state`);
    this.replaceRun(runId, { ...run, status: 'running', startedAt });
    const node = this.nodeStates.get(run.nodeId);
    if (node?.latestRunGeneration === run.generation) {
      this.nodeStates.set(run.nodeId, snapshot({ ...node, status: 'running', activeRunId: runId }));
    }
  }

  reportProgress(runId: string, progress: number, progressMessage?: string): void {
    const run = this.requireRun(runId);
    if (run.status !== 'running') return;
    this.replaceRun(runId, { ...run, progress: validProgress(progress), ...(progressMessage === undefined ? {} : { progressMessage }) });
  }

  completeRun(runId: string, input: CompleteRunInput): ResultRecord {
    const run = this.requireRun(runId);
    if (run.status !== 'running' && run.status !== 'queued') throw new Error(`Cannot complete run in ${run.status} state`);
    if (this.resultRecords.has(input.resultId)) throw new Error(`Result already exists: ${input.resultId}`);
    assertOutputs(input.outputs);
    if (input.metadata !== undefined) assertJsonRecord(input.metadata, 'Result metadata');
    const cost = validCost(input.cost);
    const result = snapshot<ResultRecord>({
      id: input.resultId,
      runId,
      nodeId: run.nodeId,
      fingerprintSnapshot: run.fingerprintSnapshot,
      createdAt: input.completedAt,
      outputs: input.outputs,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
    this.resultRecords.set(result.id, result);
    this.replaceRun(runId, { ...run, status: 'success', completedAt: input.completedAt, progress: 1, cost, resultIds: [...run.resultIds, result.id] });
    this.cancellation.delete(runId);

    const previous = this.nodeStates.get(run.nodeId);
    const isLatest = previous?.latestRunGeneration === run.generation;
    const selectionUnchanged = (this.selectionRevisions.get(run.nodeId) ?? 0) === run.selectionRevisionSnapshot;
    const mayActivate = isLatest && selectionUnchanged && input.currentFingerprint === run.fingerprintSnapshot;
    if (isLatest && previous) {
      this.nodeStates.set(run.nodeId, snapshot({
        status: 'success',
        latestRunGeneration: previous.latestRunGeneration,
        ...(mayActivate ? { activeResultId: result.id } : previous.activeResultId ? { activeResultId: previous.activeResultId } : {}),
      }));
    }
    return result;
  }

  failRun(runId: string, error: RuntimeError, completedAt: string, cost?: CostInput): void {
    const run = this.requireRun(runId);
    if (run.status !== 'running' && run.status !== 'queued') return;
    assertRuntimeError(error);
    this.replaceRun(runId, { ...run, status: 'error', completedAt, cost: validCost(cost), error: snapshot(error) });
    this.cancellation.delete(runId);
    const node = this.nodeStates.get(run.nodeId);
    if (node?.latestRunGeneration === run.generation) {
      this.nodeStates.set(run.nodeId, snapshot({
        status: 'error', latestRunGeneration: node.latestRunGeneration,
        ...(node.activeResultId ? { activeResultId: node.activeResultId } : {}),
      }));
    }
  }

  cancelRun(runId: string, completedAt: string): boolean {
    const run = this.requireRun(runId);
    if (run.status !== 'queued' && run.status !== 'running') return false;
    this.cancellation.get(runId)?.abort();
    this.cancellation.delete(runId);
    this.replaceRun(runId, { ...run, status: 'cancelled', completedAt });
    const node = this.nodeStates.get(run.nodeId);
    if (node?.latestRunGeneration === run.generation) {
      this.nodeStates.set(run.nodeId, snapshot({
        status: 'cancelled', latestRunGeneration: node.latestRunGeneration,
        ...(node.activeResultId ? { activeResultId: node.activeResultId } : {}),
      }));
    }
    return true;
  }

  getSignal(runId: string): AbortSignal | undefined { return this.cancellation.get(runId)?.signal; }

  getActiveResult(nodeId: string): ResultRecord | undefined {
    const id = this.nodeStates.get(nodeId)?.activeResultId;
    return id ? this.resultRecords.get(id) : undefined;
  }

  activateResult(nodeId: string, resultId: string): void {
    const result = this.resultRecords.get(resultId);
    if (!result || result.nodeId !== nodeId) throw new Error(`Result ${resultId} does not belong to node ${nodeId}`);
    this.selectionRevisions.set(nodeId, (this.selectionRevisions.get(nodeId) ?? 0) + 1);
    const previous = this.nodeStates.get(nodeId);
    this.nodeStates.set(nodeId, snapshot({
      status: previous?.status ?? 'success',
      latestRunGeneration: previous?.latestRunGeneration ?? 0,
      ...(previous?.activeRunId ? { activeRunId: previous.activeRunId } : {}),
      activeResultId: resultId,
    }));
  }

  freshness(nodeId: string, currentFingerprint: string): ResultFreshness {
    const result = this.getActiveResult(nodeId);
    if (!result) return 'missing';
    return result.fingerprintSnapshot === currentFingerprint ? 'fresh' : 'stale';
  }

  isStale(nodeId: string, currentFingerprint: string): boolean {
    return this.freshness(nodeId, currentFingerprint) === 'stale';
  }

  private requireRun(runId: string): RunRecord {
    const run = this.runRecords.get(runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    return run;
  }

  private replaceRun(runId: string, run: RunRecord): void { this.runRecords.set(runId, snapshot(run)); }
}
