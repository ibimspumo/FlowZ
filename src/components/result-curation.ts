import type { FlowNodeData, HistoryItem } from '../types';

export function activeHistoryIndex(history: readonly HistoryItem[], activeValue?: string): number {
  const explicit = history.findIndex((item) => item.active);
  if (explicit >= 0) return explicit;
  const matching = activeValue ? history.findIndex((item) => item.value === activeValue || item.blobHash === activeValue) : -1;
  return matching >= 0 ? matching : history.length ? 0 : -1;
}

/** A missing legacy run id deliberately means a one-result run, never one huge legacy batch. */
export function variantsForActiveRun(history: readonly HistoryItem[], activeIndex: number): HistoryItem[] {
  const active = history[activeIndex];
  if (!active) return [];
  return active.runId ? history.filter((item) => item.runId === active.runId) : [active];
}

type VariantOrderItem = {
  id?: string;
  resultId?: string;
  createdAt: string;
  parameters?: Record<string, unknown>;
};

/** Provider result order is immutable metadata, never database row order. */
export function compareVariantOrder(
  left: VariantOrderItem,
  right: VariantOrderItem,
): number {
  const index = (item: VariantOrderItem) => {
    const value = Number(item.parameters?.listIndex ?? item.parameters?.variantIndex);
    return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
  };
  return (
    index(left) - index(right) ||
    left.createdAt.localeCompare(right.createdAt) ||
    String(left.id ?? left.resultId ?? "").localeCompare(
      String(right.id ?? right.resultId ?? ""),
    )
  );
}

export function orderedVariantsForActiveRun(
  history: readonly HistoryItem[],
  activeIndex: number,
): HistoryItem[] {
  return [...variantsForActiveRun(history, activeIndex)].sort(
    compareVariantOrder,
  );
}

/**
 * Text only becomes a batch when the active result has at least one genuine
 * sibling from the same run. A one-item array is deliberately still scalar
 * text and must not surface a second, list-shaped concept in the UI.
 */
export function activeTextVariants(
  data: Pick<FlowNodeData, 'history' | 'value' | 'outputValues'>,
): string[] {
  const history = data.history ?? [];
  const run = variantsForActiveRun(
    history,
    activeHistoryIndex(history, data.value),
  );
  const materialized = data.outputValues?.texts;
  if (run.length < 2 || !Array.isArray(materialized) || materialized.length < 2)
    return [];
  return materialized;
}

/** Rebuild scalar + optional batch outputs when a sibling is activated. */
export function activatedTextOutputs(
  history: readonly HistoryItem[],
  activeId: string,
): Record<string, string | string[]> {
  const activeIndex = history.findIndex((item) => item.id === activeId);
  const active = history[activeIndex];
  if (!active) return {};
  const run = orderedVariantsForActiveRun(history, activeIndex);
  return {
    text: active.value,
    ...(run.length > 1 ? { texts: run.map((item) => item.value) } : {}),
  };
}

export function selectableImages(history: readonly HistoryItem[]): HistoryItem[] {
  return history.filter((item) => item.persisted && (item.value.startsWith('data:image/') || item.mediaType?.startsWith('image/')));
}

export function selectableVideos(history: readonly HistoryItem[]): HistoryItem[] {
  return history.filter((item) => item.persisted && Boolean(item.blobHash) && item.mediaType?.startsWith('video/'));
}

export function fanOutValues(items: readonly HistoryItem[]): Record<string, string | string[]> {
  const ready = items.flatMap((item) => item.value.startsWith('data:image/') ? [{ item, output: item.value }] : item.blobHash && item.mediaType?.startsWith('image/') ? [{ item, output: `flowz-cas:${item.blobHash}` }] : []);
  const values: Record<string, string | string[]> = { images: ready.map(({ output }) => output) };
  for (const { item, output } of ready) values[`variant:${item.id}`] = output;
  return values;
}

export function activatedImageOutputs(
  history: readonly HistoryItem[],
  activeId: string,
  configuredFanOutIds: readonly string[] = [],
): Record<string, string | string[]> {
  const activeIndex = history.findIndex((item) => item.id === activeId);
  const active = history[activeIndex];
  if (!active?.blobHash || !active.mediaType?.startsWith('image/')) return {};
  const run = orderedVariantsForActiveRun(history, activeIndex);
  const configured = history.filter((item) => configuredFanOutIds.includes(item.id));
  const individual = fanOutValues(configured); delete individual.images;
  return {
    image: `flowz-cas:${active.blobHash}`,
    ...(run.length > 1 ? fanOutValues(run) : {}),
    ...individual,
  };
}

export function fanOutVideoValues(items: readonly HistoryItem[]): Record<string, string | string[]> {
  const ready = [...items].sort(compareVariantOrder).flatMap((item) => item.blobHash && item.mediaType?.startsWith('video/') ? [{ item, output: `flowz-cas:${item.blobHash}` }] : []);
  const values: Record<string, string | string[]> = { videos: ready.map(({ output }) => output) };
  for (const { item, output } of ready) values[`variant:${item.id}`] = output;
  return values;
}

export function activatedVideoOutputs(
  history: readonly HistoryItem[],
  activeId: string,
  configuredFanOutIds: readonly string[] = [],
): Record<string, string | string[]> {
  const activeIndex = history.findIndex((item) => item.id === activeId);
  const active = history[activeIndex];
  if (!active?.blobHash || !active.mediaType?.startsWith('video/')) return {};
  const run = orderedVariantsForActiveRun(history, activeIndex);
  const configured = [...history]
    .filter((item) => configuredFanOutIds.includes(item.id))
    .sort(compareVariantOrder);
  const individual = fanOutVideoValues(configured);
  delete individual.videos;
  const startFrameHash = typeof active.parameters?.startFrameHash === 'string' ? active.parameters.startFrameHash : undefined;
  const endFrameHash = typeof active.parameters?.endFrameHash === 'string' ? active.parameters.endFrameHash : undefined;
  return {
    video: `flowz-cas:${active.blobHash}`,
    ...(run.length > 1 ? fanOutVideoValues(run) : {}),
    ...individual,
    ...(startFrameHash ? { startFrame: `flowz-cas:${startFrameHash}` } : {}),
    ...(endFrameHash ? { endFrame: `flowz-cas:${endFrameHash}` } : {}),
  };
}

export type CostSummary = { actual: number; estimated: number; actualRuns: number; estimatedRuns: number; unknownRuns: number };

/** Summarizes immutable persisted billing rows once per provider run, never per result variant. */
export function summarizeHistoryCosts(items: readonly HistoryItem[]): CostSummary {
  const summary: CostSummary = { actual: 0, estimated: 0, actualRuns: 0, estimatedRuns: 0, unknownRuns: 0 };
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.persisted) continue;
    const identity = item.costRunId ?? item.runId ?? item.id;
    const provenance = item.costProvenance ?? (item.parameters?.costProvenance as 'actual' | 'estimated' | 'unknown' | undefined);
    // No billing fields means a non-billable/local result, not an invented zero
    // and not an invented provider failure. Paid adapters persist `unknown`.
    if (item.cost == null && provenance == null) continue;
    if (item.cost === 0 && provenance == null) continue;
    if (seen.has(identity)) continue;
    seen.add(identity);
    if (provenance === 'unknown') { summary.unknownRuns += 1; continue; }
    if (item.cost == null || provenance == null) { summary.unknownRuns += 1; continue; }
    if (provenance === 'estimated') { summary.estimated += item.cost; summary.estimatedRuns += 1; }
    else { summary.actual += item.cost; summary.actualRuns += 1; }
  }
  return summary;
}
