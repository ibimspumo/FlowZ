import { describe, expect, it } from 'vitest';
import { microUnits } from '../domain/project';
import { RuntimeStore } from './store';

const output = (value: string) => ({
  text: { kind: 'scalar' as const, value: { type: 'text' as const, value } },
});

describe('RuntimeStore', () => {
  it('keeps immutable result history and activates a matching completion', () => {
    const store = new RuntimeStore();
    store.queueRun({ id: 'run-1', nodeId: 'node', fingerprintSnapshot: 'fp-a', createdAt: 't0', startedAt: 't1' });
    const result = store.completeRun('run-1', {
      resultId: 'result-1', completedAt: 't2', outputs: output('first'), currentFingerprint: 'fp-a',
      cost: { amountMicros: microUnits(1200), currency: 'usd', provenance: 'actual' },
    });

    expect(store.getActiveResult('node')).toBe(result);
    expect(store.runs.get('run-1')).toMatchObject({
      status: 'success', cost: { amountMicros: 1200, currency: 'USD', provenance: 'actual' }, resultIds: ['result-1'],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.outputs)).toBe(true);
    expect(store.isStale('node', 'fp-a')).toBe(false);
    expect(store.isStale('node', 'fp-b')).toBe(true);
    expect(store.freshness('missing', 'fp')).toBe('missing');
  });

  it('records edit-during-run output but does not make it active', () => {
    const store = new RuntimeStore();
    store.queueRun({ id: 'old', nodeId: 'node', fingerprintSnapshot: 'fp-old', createdAt: 't0', startedAt: 't1' });
    store.completeRun('old', {
      resultId: 'historical', completedAt: 't2', outputs: output('old snapshot'), currentFingerprint: 'fp-edited',
    });

    expect(store.results.get('historical')?.outputs).toEqual(output('old snapshot'));
    expect(store.getActiveResult('node')).toBeUndefined();
    expect(store.runs.get('old')?.status).toBe('success');
  });

  it('does not let an older race completion replace the newer active run', () => {
    const store = new RuntimeStore();
    store.queueRun({ id: 'old', nodeId: 'node', fingerprintSnapshot: 'same', createdAt: 't0', startedAt: 't1' });
    store.queueRun({ id: 'new', nodeId: 'node', fingerprintSnapshot: 'same', createdAt: 't2', startedAt: 't3' });
    store.completeRun('old', { resultId: 'old-result', completedAt: 't4', outputs: output('old'), currentFingerprint: 'same' });

    expect(store.results.has('old-result')).toBe(true);
    expect(store.getActiveResult('node')).toBeUndefined();
    expect(store.nodes.get('node')).toMatchObject({ status: 'running', activeRunId: 'new' });
  });

  it('does not let an older queued run become current by starting late', () => {
    const store = new RuntimeStore();
    store.queueRun({ id: 'old', nodeId: 'node', fingerprintSnapshot: 'same', createdAt: 't0' });
    store.queueRun({ id: 'new', nodeId: 'node', fingerprintSnapshot: 'same', createdAt: 't1', startedAt: 't2' });
    store.startRun('old', 't3');
    expect(store.nodes.get('node')).toMatchObject({ status: 'running', activeRunId: 'new' });
    store.completeRun('old', { resultId: 'old-result', completedAt: 't4', outputs: output('old'), currentFingerprint: 'same' });
    expect(store.getActiveResult('node')).toBeUndefined();
  });

  it('does not overwrite a manual result selection made after run start', () => {
    const store = new RuntimeStore();
    store.queueRun({ id: 'seed', nodeId: 'node', fingerprintSnapshot: 'seed', createdAt: 't0', startedAt: 't1' });
    store.completeRun('seed', { resultId: 'selected', completedAt: 't2', outputs: output('selected'), currentFingerprint: 'seed' });
    store.queueRun({ id: 'next', nodeId: 'node', fingerprintSnapshot: 'next', createdAt: 't3', startedAt: 't4' });
    store.activateResult('node', 'selected');
    store.completeRun('next', { resultId: 'new-result', completedAt: 't5', outputs: output('new'), currentFingerprint: 'next' });
    expect(store.getActiveResult('node')?.id).toBe('selected');
    expect(store.results.has('new-result')).toBe(true);
  });

  it('owns one cancellable signal per run and retains retry metadata', () => {
    const store = new RuntimeStore();
    store.queueRun({ id: 'original', nodeId: 'node', fingerprintSnapshot: 'fp', createdAt: 't0', startedAt: 't1' });
    store.failRun('original', { code: 'timeout', message: 'Timeout', retryable: true }, 't2');
    const signal = store.retryRun('original', {
      id: 'retry', nodeId: 'node', fingerprintSnapshot: 'fp', createdAt: 't3',
    });
    expect(signal.aborted).toBe(false);
    expect(store.getSignal('retry')).toBe(signal);
    expect(store.cancelRun('retry', 't1')).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(store.getSignal('retry')).toBeUndefined();
    expect(store.runs.get('retry')).toMatchObject({ status: 'cancelled', retry: { attempt: 2, retryOfRunId: 'original' } });
    expect(store.cancelRun('retry', 't2')).toBe(false);
    expect(() => store.retryRun('original', {
      id: 'wrong', nodeId: 'other', fingerprintSnapshot: 'fp', createdAt: 't4',
    })).toThrow('cannot change');
  });

  it('rejects retries for explicitly non-retryable failures', () => {
    const store = new RuntimeStore();
    store.queueRun({ id: 'original', nodeId: 'node', fingerprintSnapshot: 'fp', createdAt: 't0' });
    store.failRun('original', { code: 'invalid_request', message: 'Fix the request', retryable: false }, 't1');
    expect(() => store.retryRun('original', {
      id: 'retry', fingerprintSnapshot: 'fp', createdAt: 't2',
    })).toThrow(/not retryable/);
    expect(() => store.queueRun({
      id: 'direct-retry', nodeId: 'node', fingerprintSnapshot: 'fp', createdAt: 't2',
      retry: { attempt: 2, retryOfRunId: 'original' },
    })).toThrow(/not retryable/);
  });

  it('requires a retry parent after attempt one and retains a coalesced update session', () => {
    const store = new RuntimeStore();
    expect(() => store.queueRun({
      id: 'orphan-retry', nodeId: 'node', fingerprintSnapshot: 'fp', createdAt: 't0', retry: { attempt: 2 },
    })).toThrow(/without a retry parent/);
    expect(() => store.queueRun({
      id: 'empty-session', nodeId: 'node', fingerprintSnapshot: 'fp', createdAt: 't0', updateSessionId: ' ',
    })).toThrow(/session id/);
    store.queueRun({
      id: 'group-run', nodeId: 'node', fingerprintSnapshot: 'fp', createdAt: 't0', updateSessionId: 'group-update-1',
    });
    expect(store.runs.get('group-run')).toMatchObject({ retry: { attempt: 1 }, updateSessionId: 'group-update-1' });
  });

  it('tracks clamped progress and structured failures', () => {
    const store = new RuntimeStore();
    store.queueRun({ id: 'run', nodeId: 'node', fingerprintSnapshot: 'fp', createdAt: 't0' });
    store.startRun('run', 't1');
    store.reportProgress('run', 4, 'Almost');
    expect(store.runs.get('run')).toMatchObject({ progress: 1, progressMessage: 'Almost' });
    store.failRun('run', { code: 'quota', message: 'Limit', retryable: false }, 't2', {
      amountMicros: microUnits(9), currency: 'EUR', provenance: 'estimated',
    });
    expect(store.runs.get('run')).toMatchObject({
      status: 'error', cost: { amountMicros: 9, currency: 'EUR', provenance: 'estimated' }, error: { code: 'quota' },
    });
  });

  it('rejects negative costs and protects snapshots from external mutation', () => {
    const store = new RuntimeStore();
    const outputs = output('owned by caller');
    store.queueRun({ id: 'run', nodeId: 'node', fingerprintSnapshot: 'fp', createdAt: 't0', startedAt: 't1' });
    expect(() => store.completeRun('run', {
      resultId: 'bad', completedAt: 't2', outputs, currentFingerprint: 'fp',
      cost: { amountMicros: microUnits(-1), currency: 'USD', provenance: 'actual' },
    })).toThrow('non-negative');
    expect(Object.isFrozen(outputs)).toBe(false);

    store.completeRun('run', { resultId: 'good', completedAt: 't3', outputs, currentFingerprint: 'fp' });
    outputs.text.value.value = 'mutated';
    expect(store.results.get('good')?.outputs).toEqual(output('owned by caller'));
    const exposed = store.results as Map<string, never>;
    exposed.clear();
    expect(store.results.has('good')).toBe(true);
  });

  it('rejects non-JSON metadata/errors and non-runtime outputs before snapshotting', () => {
    const makeStore = (id: string) => {
      const store = new RuntimeStore();
      store.queueRun({ id, nodeId: 'node', fingerprintSnapshot: 'fp', createdAt: 't0' });
      return store;
    };
    expect(() => makeStore('bigint').completeRun('bigint', {
      resultId: 'r1', completedAt: 't1', currentFingerprint: 'fp',
      outputs: { value: { kind: 'scalar', value: { type: 'json', value: 1n } } } as never,
    })).toThrow(/runtime value/);
    expect(() => makeStore('date').completeRun('date', {
      resultId: 'r2', completedAt: 't1', currentFingerprint: 'fp', outputs: output('ok'),
      metadata: { created: new Date() } as never,
    })).toThrow(/JSON values/);
    expect(() => makeStore('map').completeRun('map', {
      resultId: 'r3', completedAt: 't1', currentFingerprint: 'fp', outputs: new Map() as never,
    })).toThrow(/plain object/);
    expect(() => makeStore('error').failRun('error', {
      code: 'bad', message: 'Bad', retryable: false, details: { map: new Map() } as never,
    }, 't1')).toThrow(/JSON values/);
  });
});
