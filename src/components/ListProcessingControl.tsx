import type { FlowNodeData } from "../types";
import { useFlowStore } from "../store";
import { useI18n } from "../i18n";

export function hasConnectedListInput(nodeId: string, edges: ReturnType<typeof useFlowStore.getState>["edges"]) {
  return edges.some((edge) => edge.target === nodeId && (edge.data?.dataType === "list" || String(edge.data?.dataType ?? "").endsWith("List")));
}

export function ListProcessingControl({ nodeId, data }: { nodeId: string; data: FlowNodeData }) {
  const { t } = useI18n(); const edges = useFlowStore((state) => state.edges); const update = useFlowStore((state) => state.updateNode);
  if (!data.listProcessingMode || !hasConnectedListInput(nodeId, edges)) return null;
  return <fieldset className="list-processing-control"><legend>{t('list.mode')}</legend>
    <button type="button" className={data.listProcessingMode === "map" ? "is-active" : ""} aria-pressed={data.listProcessingMode === "map"} onClick={() => update(nodeId, { listProcessingMode: "map" })}>{t('list.map')}</button>
    <button type="button" className={data.listProcessingMode === "aggregate" ? "is-active" : ""} aria-pressed={data.listProcessingMode === "aggregate"} onClick={() => update(nodeId, { listProcessingMode: "aggregate" })}>{t('list.aggregate')}</button>
  </fieldset>;
}
