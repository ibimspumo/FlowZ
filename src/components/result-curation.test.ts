import { describe, expect, it } from 'vitest';
import { activatedImageOutputs, activatedTextOutputs, activatedVideoOutputs, fanOutVideoValues, summarizeHistoryCosts } from './result-curation';
import type { HistoryItem } from '../types';

const item = (patch: Partial<HistoryItem>): HistoryItem => ({ id: crypto.randomUUID(), createdAt: '2026-01-01T00:00:00Z', value: '', persisted: true, ...patch });

describe('video curation and honest node costs', () => {
  it('keeps one image scalar and exposes a list only for genuine siblings', () => {
    const hash = (character: string) => character.repeat(64);
    const single = [item({ id:'one',runId:'run-1',blobHash:hash('a'),mediaType:'image/png' })];
    expect(activatedImageOutputs(single,'one')).toEqual({image:`flowz-cas:${hash('a')}`});
    expect(activatedImageOutputs([...single,item({id:'two',runId:'run-1',blobHash:hash('b'),mediaType:'image/png'})],'one')).toMatchObject({images:[`flowz-cas:${hash('a')}`,`flowz-cas:${hash('b')}`]});
  });
  it('exposes immutable video variants without scalar fallback', () => {
    expect(fanOutVideoValues([item({ id: 'v', blobHash: 'a'.repeat(64), mediaType: 'video/mp4' })])).toEqual({ videos: [`flowz-cas:${'a'.repeat(64)}`], 'variant:v': `flowz-cas:${'a'.repeat(64)}` });
  });
  it('restores the activated variant frames and orders its run and fan-out deterministically', () => {
    const hash = (character: string) => character.repeat(64);
    const history = [
      item({ id: 'later-b', runId: 'run', blobHash: hash('b'), mediaType: 'video/mp4', createdAt: '2026-01-02T00:00:00Z', parameters: { listIndex: 1, startFrameHash: hash('c'), endFrameHash: hash('d') } }),
      item({ id: 'first', runId: 'run', blobHash: hash('a'), mediaType: 'video/mp4', createdAt: '2026-01-01T00:00:00Z', parameters: { listIndex: 0 } }),
      item({ id: 'later-a', runId: 'run', blobHash: hash('e'), mediaType: 'video/mp4', createdAt: '2026-01-01T00:00:00Z', parameters: { listIndex: 1 } }),
    ];
    expect(activatedVideoOutputs(history, 'later-b', ['later-b', 'first'])).toEqual({
      video: `flowz-cas:${hash('b')}`,
      videos: [`flowz-cas:${hash('a')}`, `flowz-cas:${hash('e')}`, `flowz-cas:${hash('b')}`],
      'variant:first': `flowz-cas:${hash('a')}`,
      'variant:later-a': `flowz-cas:${hash('e')}`,
      'variant:later-b': `flowz-cas:${hash('b')}`,
      startFrame: `flowz-cas:${hash('c')}`,
      endFrame: `flowz-cas:${hash('d')}`,
    });
  });
  it('deduplicates shared provider costs and keeps provenance separate', () => {
    const summary = summarizeHistoryCosts([
      item({ id: 'a', runId: 'group', costRunId: 'paid-1', cost: .02, costProvenance: 'actual' }),
      item({ id: 'b', runId: 'group', costRunId: 'paid-1', cost: .02, costProvenance: 'actual' }),
      item({ id: 'c', costRunId: 'paid-2', cost: .03, costProvenance: 'estimated' }),
      item({ id: 'd', costRunId: 'paid-3', costProvenance: 'unknown' }),
      item({ id: 'temporary', persisted: false, cost: 99, costProvenance: 'actual' }),
    ]);
    expect(summary).toEqual({ actual: .02, estimated: .03, actualRuns: 1, estimatedRuns: 1, unknownRuns: 1 });
  });
  it('does not invent provider provenance for local zero-cost history', () => {
    expect(summarizeHistoryCosts([
      item({ id: 'local', cost: 0 }),
      item({ id: 'legacy-provider', cost: .01 }),
    ])).toEqual({ actual: 0, estimated: 0, actualRuns: 0, estimatedRuns: 0, unknownRuns: 1 });
  });
});

describe('stable text variant order', () => {
  it('uses immutable list indices after active-first reload ordering', () => {
    const history = [
      item({ id: 'two', value: 'Zwei', runId: 'run', active: true, parameters: { listIndex: 1 } }),
      item({ id: 'three', value: 'Drei', runId: 'run', parameters: { listIndex: 2 } }),
      item({ id: 'one', value: 'Eins', runId: 'run', parameters: { listIndex: 0 } }),
    ];
    expect(activatedTextOutputs(history, 'two')).toEqual({
      text: 'Zwei',
      texts: ['Eins', 'Zwei', 'Drei'],
    });
  });
});
