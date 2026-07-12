import type { ScalarValue, ScalarValueType, RuntimeValue } from '../domain/values';
import { listValue } from '../domain/values';

export type ListProcessingMode = 'map' | 'aggregate';
export type ListFailureDecision = 'retry' | 'skip' | 'abort';
export type ListChildResult = { outputs: Readonly<Record<string, ScalarValue>>; costMicrounits?: number; resultId?: string };
export type ListChildFailure = { index: number; message: string; attempts: number };
export type ListMapResult = {
  state: 'completed' | 'partial' | 'cancelled' | 'aborted'; outputs: Readonly<Record<string, RuntimeValue>>;
  children: ReadonlyArray<ListChildResult | undefined>; failures: readonly ListChildFailure[];
  skippedIndices: readonly number[]; costMicrounits: number;
};
export type ListExecutionOptions = {
  mode: ListProcessingMode; inputs: Readonly<Record<string, readonly RuntimeValue[]>>;
  outputTypes: Readonly<Record<string, ScalarValueType>>; signal: AbortSignal; concurrency?: number;
  aggregateSupportedTypes?: ReadonlySet<ScalarValueType>;
  execute: (inputs: Readonly<Record<string, readonly RuntimeValue[]>>, context: { index?: number; signal: AbortSignal }) => Promise<ListChildResult>;
  onFailure?: (failure: ListChildFailure) => Promise<ListFailureDecision> | ListFailureDecision;
  /** Successful paid children from a preceding partial run are never repeated. */
  previous?: Pick<ListMapResult, 'children' | 'skippedIndices'>;
};

function listInputs(inputs: ListExecutionOptions['inputs']) {
  return Object.entries(inputs).flatMap(([portId, values]) => values.flatMap((value, valueIndex) =>
    value.kind === 'list' ? [{ portId, valueIndex, value }] : []));
}
export function hasConnectedListInput(inputs: ListExecutionOptions['inputs']): boolean { return listInputs(inputs).length > 0; }
export function validateListProcessing(options: Pick<ListExecutionOptions, 'mode' | 'inputs' | 'aggregateSupportedTypes'>): string[] {
  const lists = listInputs(options.inputs); if (!lists.length) return [];
  if (options.mode === 'aggregate') return lists.filter(({ value }) => !options.aggregateSupportedTypes?.has(value.itemType))
    .map(({ value }) => `Dieses Modell kann ${value.itemType}-Listen nicht gemeinsam verarbeiten.`);
  return new Set(lists.map(({ value }) => value.items.length)).size > 1 ? ['Map benötigt bei mehreren Listen gleich viele Elemente.'] : [];
}
function mappedInputs(inputs: ListExecutionOptions['inputs'], index: number): ListExecutionOptions['inputs'] {
  return Object.fromEntries(Object.entries(inputs).map(([portId, values]) => [portId, values.map((value) =>
    value.kind === 'list' ? { kind: 'scalar', value: value.items[index] } satisfies RuntimeValue : value)]));
}
function collectOutputs(children: ReadonlyArray<ListChildResult | undefined>, outputTypes: ListExecutionOptions['outputTypes']): Record<string, RuntimeValue> {
  return Object.fromEntries(Object.entries(outputTypes).map(([portId, itemType]) => [portId,
    listValue(itemType, children.flatMap((child) => child?.outputs[portId] ? [child.outputs[portId]] : []))]));
}
function assertChildOutputs(result: ListChildResult, outputTypes: ListExecutionOptions['outputTypes']) {
  for (const [portId, expected] of Object.entries(outputTypes)) if (result.outputs[portId]?.type !== expected) throw new TypeError(`Ausgang ${portId} muss ${expected} liefern.`);
  if (result.costMicrounits != null && (!Number.isSafeInteger(result.costMicrounits) || result.costMicrounits < 0)) throw new TypeError('Kosten müssen als positive Integer-Mikroeinheiten vorliegen.');
}
export async function executeListProcessing(options: ListExecutionOptions): Promise<ListMapResult> {
  const validation = validateListProcessing(options); if (validation.length) throw new Error(validation.join(' '));
  const lists = listInputs(options.inputs);
  if (options.mode === 'aggregate' || !lists.length) {
    if (options.signal.aborted) return { state: 'cancelled', outputs: {}, children: [], failures: [], skippedIndices: [], costMicrounits: 0 };
    const child = await options.execute(options.inputs, { signal: options.signal }); assertChildOutputs(child, options.outputTypes);
    const outputs = Object.fromEntries(Object.entries(child.outputs).map(([portId, value]) => [portId, { kind: 'scalar', value } satisfies RuntimeValue]));
    return { state: 'completed', outputs, children: [child], failures: [], skippedIndices: [], costMicrounits: child.costMicrounits ?? 0 };
  }
  const count = lists[0].value.items.length;
  const children = Array.from({ length: count }, (_, index) => options.previous?.children[index]);
  const skipped = new Set(options.previous?.skippedIndices ?? []); const failures: ListChildFailure[] = [];
  const concurrency = Math.max(1, Math.min(8, Math.floor(options.concurrency ?? 3))); let cursor = 0; let aborted = false;
  const nextIndex = () => { while (cursor < count && (children[cursor] || skipped.has(cursor))) cursor += 1; return cursor < count ? cursor++ : undefined; };
  const worker = async () => {
    while (!options.signal.aborted && !aborted) {
      const index = nextIndex(); if (index == null) return; let attempts = 0;
      while (!options.signal.aborted && !aborted) {
        attempts += 1;
        try { const child = await options.execute(mappedInputs(options.inputs, index), { index, signal: options.signal }); assertChildOutputs(child, options.outputTypes); children[index] = child; break; }
        catch (error) {
          const failure = { index, attempts, message: error instanceof Error ? error.message : String(error) }; failures.push(failure);
          const decision = await options.onFailure?.(failure) ?? 'abort';
          if (decision === 'retry') continue; if (decision === 'skip') { skipped.add(index); break; } aborted = true; break;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(count, 1)) }, worker));
  const costMicrounits = children.reduce((sum, child) => sum + (child?.costMicrounits ?? 0), 0);
  const state = options.signal.aborted ? 'cancelled' : aborted ? 'aborted' : skipped.size || children.some((item) => !item) ? 'partial' : 'completed';
  return { state, outputs: collectOutputs(children, options.outputTypes), children, failures, skippedIndices: [...skipped].sort((a, b) => a - b), costMicrounits };
}
export function orderedListContentIdentities(value: RuntimeValue, identityFor: (value: ScalarValue) => string): readonly string[] {
  return value.kind === 'list' ? value.items.map(identityFor) : [identityFor(value.value)];
}
