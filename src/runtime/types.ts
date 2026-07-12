import type { JsonValue, MicroUnitAmount } from '../domain/project';
import type { RuntimeValue } from '../domain/values';

export type NodeRuntimeStatus = 'idle' | 'queued' | 'running' | 'success' | 'error' | 'cancelled';

export type RuntimeError = {
  code: string;
  message: string;
  retryable: boolean;
  details?: Readonly<Record<string, JsonValue>>;
};

export type RetryMetadata = {
  attempt: number;
  retryOfRunId?: string;
};

export type CostProvenance = 'estimated' | 'actual';

export type RuntimeCost = Readonly<{
  amountMicros: MicroUnitAmount;
  currency: string;
  provenance: CostProvenance;
}>;

export type RunRecord = Readonly<{
  id: string;
  nodeId: string;
  fingerprintSnapshot: string;
  generation: number;
  selectionRevisionSnapshot: number;
  /** Shared by runs scheduled from one coalesced group/auto-update session. */
  updateSessionId?: string;
  status: Exclude<NodeRuntimeStatus, 'idle'>;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  progress: number;
  progressMessage?: string;
  cost: RuntimeCost;
  retry: Readonly<RetryMetadata>;
  error?: Readonly<RuntimeError>;
  resultIds: readonly string[];
}>;

export type ResultRecord = Readonly<{
  id: string;
  runId: string;
  nodeId: string;
  fingerprintSnapshot: string;
  createdAt: string;
  outputs: Readonly<Record<string, RuntimeValue>>;
  metadata?: Readonly<Record<string, JsonValue>>;
}>;

export type NodeRuntimeState = Readonly<{
  status: NodeRuntimeStatus;
  activeRunId?: string;
  activeResultId?: string;
  latestRunGeneration: number;
}>;

export type ResultFreshness = 'missing' | 'fresh' | 'stale';
