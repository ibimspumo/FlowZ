import { describe, expect, it, vi } from 'vitest';
import type { RuntimeValue } from '../domain/values';
import { executeListProcessing, hasConnectedListInput, orderedListContentIdentities, validateListProcessing } from './list-execution';

const texts = (...items: string[]): RuntimeValue => ({ kind: 'list', itemType: 'text', items: items.map((value) => ({ type: 'text', value })) });
const input = (value: RuntimeValue) => ({ prompt: [value] }); const outputTypes = { text: 'text' as const };
describe('visible list execution semantics', () => {
  it('maps with bounded concurrency while preserving order and summed cost', async () => {
    let active = 0; let peak = 0;
    const result = await executeListProcessing({ mode: 'map', inputs: input(texts('slow', 'fast', 'mid')), outputTypes, signal: new AbortController().signal, concurrency: 2,
      execute: async (values, { index }) => { active++; peak = Math.max(peak, active); const value = (values.prompt[0] as { kind: 'scalar'; value: { type: 'text'; value: string } }).value.value; await new Promise((resolve) => setTimeout(resolve, value === 'slow' ? 15 : 1)); active--; return { outputs: { text: { type: 'text', value: `${index}:${value}` } }, costMicrounits: 7, resultId: `r${index}` }; } });
    expect(peak).toBe(2); expect(result.outputs.text).toEqual(texts('0:slow', '1:fast', '2:mid')); expect(result.costMicrounits).toBe(21);
  });
  it('does not call a provider for an empty map list', async () => {
    const execute = vi.fn(); const result = await executeListProcessing({ mode: 'map', inputs: input(texts()), outputTypes, signal: new AbortController().signal, execute });
    expect(execute).not.toHaveBeenCalled(); expect(result.outputs.text).toEqual(texts()); expect(result.state).toBe('completed');
  });
  it('passes all items once in aggregate and blocks unsupported list types', async () => {
    const execute = vi.fn(async () => ({ outputs: { text: { type: 'text' as const, value: 'Vergleich' } }, costMicrounits: 5 }));
    const result = await executeListProcessing({ mode: 'aggregate', inputs: input(texts('a', 'b')), outputTypes, aggregateSupportedTypes: new Set(['text']), signal: new AbortController().signal, execute });
    expect(execute).toHaveBeenCalledTimes(1); expect(result.outputs.text).toEqual({ kind: 'scalar', value: { type: 'text', value: 'Vergleich' } });
    expect(validateListProcessing({ mode: 'aggregate', inputs: input(texts('a')), aggregateSupportedTypes: new Set(['image']) })).toHaveLength(1);
  });
  it('preserves paid successes and retries only missing children', async () => {
    const first = await executeListProcessing({ mode: 'map', inputs: input(texts('a', 'b', 'c')), outputTypes, signal: new AbortController().signal,
      execute: async (_, { index = -1 }) => { if (index === 1) throw new Error('quota'); return { outputs: { text: { type: 'text', value: `ok${index}` } }, costMicrounits: 11, resultId: `paid${index}` }; }, onFailure: () => 'skip' });
    expect(first.state).toBe('partial'); expect(first.costMicrounits).toBe(22); const seen: number[] = [];
    const second = await executeListProcessing({ mode: 'map', inputs: input(texts('a', 'b', 'c')), outputTypes, signal: new AbortController().signal, previous: { children: first.children, skippedIndices: [] },
      execute: async (_, { index = -1 }) => { seen.push(index); return { outputs: { text: { type: 'text', value: `ok${index}` } }, costMicrounits: 13, resultId: `paid${index}` }; } });
    expect(seen).toEqual([1]); expect(second.outputs.text).toEqual(texts('ok0', 'ok1', 'ok2')); expect(second.costMicrounits).toBe(35);
  });
  it('rejects mismatched zips and keeps ordered identities', () => {
    expect(hasConnectedListInput(input(texts('a')))).toBe(true);
    expect(validateListProcessing({ mode: 'map', inputs: { a: [texts('a')], b: [texts('b', 'c')] } })).toHaveLength(1);
    expect(orderedListContentIdentities(texts('a', 'b'), (value) => value.type === 'text' ? value.value : JSON.stringify(value))).toEqual(['a', 'b']);
  });

  it('keeps video variants ordered and propagates one shared cancellation signal', async () => {
    const controller = new AbortController(); const observed: AbortSignal[] = [];
    const pending = executeListProcessing({ mode: 'map', inputs: { variants: [{ kind: 'list', itemType: 'json', items: [0, 1].map((value) => ({ type: 'json', value })) }] }, outputTypes: { video: 'video' }, signal: controller.signal, concurrency: 2,
      execute: async (_, { index = 0, signal }) => { observed.push(signal); await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })); return { outputs: { video: { type: 'video', assetId: `hash-${index}` } }, costMicrounits: 9 }; } });
    await Promise.resolve(); controller.abort(); const result = await pending;
    expect(observed).toEqual([controller.signal, controller.signal]); expect(result.state).toBe('cancelled');
    expect(result.outputs.video).toEqual({ kind: 'list', itemType: 'video', items: [{ type: 'video', assetId: 'hash-0' }, { type: 'video', assetId: 'hash-1' }] });
  });
});
