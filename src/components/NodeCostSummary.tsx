import type { FlowNodeData, HistoryItem } from "../types";
import { useI18n } from "../i18n";
import { formatCost } from "./cost-format";

export function lifetimeNodeCost(history: readonly HistoryItem[] | undefined): number | undefined {
  if (!history?.length) return undefined;
  const runs = new Map<string, number>();
  for (const item of history) {
    if (typeof item.cost !== "number" || !Number.isFinite(item.cost) || item.cost < 0) continue;
    const identity = item.costRunId ?? item.runId ?? item.id;
    if (!runs.has(identity)) runs.set(identity, item.cost);
  }
  return runs.size ? [...runs.values()].reduce((sum, value) => sum + value, 0) : undefined;
}

export function NodeCostSummary({ data }: { data: FlowNodeData }) {
  const { t } = useI18n(); const total = lifetimeNodeCost(data.history);
  const hasLast = typeof data.cost === "number" || data.costProvenance === "unknown";
  if (!hasLast && total === undefined) return null;
  const provenance = data.costProvenance ?? "actual";
  return <span className="node-costs" aria-label={`${t('pricing.lastRun')}: ${formatCost(typeof data.cost === "number" ? data.cost : undefined, provenance)}. ${t('pricing.nodeTotal')}: ${formatCost(total, total === undefined ? "unknown" : "actual")}`}>
    <b>{formatCost(typeof data.cost === "number" ? data.cost : undefined, provenance)}</b>
    <small>{t('pricing.lastRun')} · {t('pricing.nodeTotal')} {formatCost(total, total === undefined ? "unknown" : "actual")}</small>
  </span>;
}
