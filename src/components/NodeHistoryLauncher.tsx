import { History } from "lucide-react";
import { lazy, Suspense, useRef, useState } from "react";
import type { FlowNodeData } from "../types";
import { useI18n } from "../i18n";

const LazyNodeResultHistory = lazy(() => import("./NodeResultHistory").then((module) => ({ default: module.NodeResultHistory })));

export function NodeHistoryLauncher({ nodeId, data }: { nodeId: string; data: FlowNodeData }) {
  const [open, setOpen] = useState(false),trigger=useRef<HTMLButtonElement>(null), { t } = useI18n(), count = data.history?.length ?? 0;
  const close=()=>{setOpen(false);queueMicrotask(()=>trigger.current?.focus());};
  if (!count) return null;
  return <>
    <button ref={trigger} type="button" className="node-history-trigger secondary" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <History size={12}/><span>{t("common.savedResults")}</span><b>{count}</b>
    </button>
    {open ? <Suspense fallback={<div className="history-loading" role="status">…</div>}><LazyNodeResultHistory nodeId={nodeId} onClose={close}/></Suspense> : null}
  </>;
}
