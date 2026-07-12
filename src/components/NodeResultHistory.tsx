import { Check, ChevronLeft, ChevronRight, Expand, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { DeferredMarkdown } from "./DeferredMarkdown";
import { formatCost } from "./cost-format";
import { formatDate, useI18n } from "../i18n";
import { mediaUrl } from "../persistence/media";
import { loadLibraryResultPage, type LibraryResult } from "../persistence/library";
import { isDesktopRuntime } from "../persistence/projects";
import { useFlowStore } from "../store";
import type { HistoryItem } from "../types";
import "./NodeResultHistory.css";

const PAGE_SIZE = 12;
const boundedText = (value: unknown, max = 8_000) => { const text = String(value ?? ""); return text.length > max ? `${text.slice(0,max)}…` : text; };
const promptText = (item: HistoryItem) => boundedText(item.prompt || item.parameters?.prompt || item.parameters?.instruction);
const endpointText = (item: HistoryItem) => String(item.parameters?.endpoint ?? item.parameters?.model ?? item.model ?? "—");
const mediaKind = (item: HistoryItem) => item.mediaType?.startsWith("image/") ? "image" : item.mediaType?.startsWith("video/") ? "video" : "text";
const preview = (item: HistoryItem) => item.blobHash ? mediaUrl(item.blobHash) : item.value;

function ResultPreview({ item, large = false }: { item: HistoryItem; large?: boolean }) {
  const kind = mediaKind(item), source = preview(item);
  if (kind === "image") return <img className={large ? "history-large-media" : "history-thumb"} src={source} alt="" loading="lazy"/>;
  if (kind === "video") return <video className={large ? "history-large-media" : "history-thumb"} src={source} controls={large} preload="metadata"/>;
  return <div className={large ? "history-large-text" : "history-text-preview"}><DeferredMarkdown value={boundedText(item.value, large ? 100_000 : 2_000)}/></div>;
}

export function NodeResultHistory({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
  const data = useFlowStore((state) => state.nodes.find((node) => node.id === nodeId)?.data),
    projectId = useFlowStore((state) => state.document?.id),
    activate = useFlowStore((state) => state.activateHistoryResult),
    remove = useFlowStore((state) => state.deleteHistoryResult),
    addImages = useFlowStore((state) => state.addImageCollection), addVideos = useFlowStore((state) => state.addVideoCollection),
    { t } = useI18n(), panel = useRef<HTMLElement>(null),largeTrigger=useRef<HTMLButtonElement|undefined>(undefined), [page, setPage] = useState(0),
    [selected, setSelected] = useState<Set<string>>(new Set()), [large, setLarge] = useState<HistoryItem>(), [busy, setBusy] = useState<string>(), [error, setError] = useState<string>(),
    [remote, setRemote] = useState<{items:LibraryResult[];total:number}>();
  const history = useMemo(() => [...(data?.history ?? [])].sort((a,b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)), [data?.history]);
  const pages = Math.max(1, Math.ceil((remote?.total ?? history.length) / PAGE_SIZE));
  const remoteHistory = (remote?.items ?? []).map((item) => history.find((local) => local.id === item.resultId) ?? ({ id:item.resultId,runId:item.runId,createdAt:item.createdAt,value:item.textValue ?? "",blobHash:item.blobHash,assetId:item.assetId,mediaType:item.mediaType,model:item.model,prompt:item.prompt,parameters:item.parameters as HistoryItem["parameters"],cost:item.costMicrounits == null ? undefined : item.costMicrounits/1_000_000,persisted:true,active:item.active } satisfies HistoryItem));
  const visible = remote ? remoteHistory : history.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  useEffect(() => { panel.current?.focus(); }, []);
  useEffect(() => {
    let current=true;
    if(!projectId||!isDesktopRuntime()){setRemote(undefined);return;}
    void loadLibraryResultPage({projectId,nodeId,page,pageSize:PAGE_SIZE}).then((result)=>{if(current)setRemote({items:result.items,total:result.total});}).catch((reason)=>{if(current)setError(reason instanceof Error?reason.message:String(reason));});
    return()=>{current=false};
  },[projectId,nodeId,page,data?.history]);
  useEffect(() => { setPage((value) => Math.min(value, pages - 1)); setSelected((value) => new Set([...value].filter((id) => history.some((item) => item.id === id)))); }, [history, pages]);
  const chosen = history.filter((item) => selected.has(item.id));
  const toggle = (id: string) => setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const run = async (id: string, operation: () => Promise<boolean>) => { setBusy(id); setError(undefined); try { await operation(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(undefined); } };
  const curate = () => { const kind = chosen[0] && mediaKind(chosen[0]); if (chosen.length < 2 || chosen.some((item) => mediaKind(item) !== kind)) return; if (kind === "image") addImages(nodeId, chosen); if (kind === "video") addVideos(nodeId, chosen); setSelected(new Set()); };
  const compare = chosen.length === 2 && chosen.every((item) => mediaKind(item) === "text");
  const closeLarge=()=>{setLarge(undefined);queueMicrotask(()=>largeTrigger.current?.focus());};
  return <section ref={panel} tabIndex={-1} className="node-result-history nodrag nowheel nopan" aria-label={t("common.savedResults")} onWheelCapture={(event) => event.stopPropagation()} onKeyDown={(event) => {
    if (event.key === "Escape") { if (large) closeLarge(); else onClose(); event.stopPropagation(); }
    if (event.key === "ArrowLeft" && page > 0) setPage(page - 1);
    if (event.key === "ArrowRight" && page + 1 < pages) setPage(page + 1);
  }}>
    <header><div><strong>{t("common.savedResults")}</strong><span>{history.length} · {data?.label}</span></div><button className="icon-button" onClick={onClose} aria-label={t("common.close")}><X size={14}/></button></header>
    {error ? <div className="node-error" role="alert">{error}</div> : null}
    {chosen.length ? <div className="history-selection"><span>{t("history.selected",{count:chosen.length})}</span>{chosen.length >= 2 && chosen.every((item) => ["image","video"].includes(mediaKind(item))) ? <button className="secondary" onClick={curate}>{t("history.createCollection")}</button> : null}<button className="secondary" onClick={() => setSelected(new Set())}>{t("history.clearSelection")}</button></div> : null}
    {compare ? <div className="history-compare">{chosen.map((item) => <article key={item.id}><strong>{formatDate(item.createdAt,{dateStyle:"medium",timeStyle:"short"})}</strong><DeferredMarkdown value={item.value}/></article>)}</div> : null}
    <div className="history-grid">{visible.map((item) => { const kind = mediaKind(item), prompt = promptText(item), provenance = item.costProvenance ?? String(item.parameters?.costProvenance ?? "unknown"); return <article key={item.id} className={item.active ? "is-active" : ""}>
      <button type="button" className="history-preview-button" onClick={(event) => {if(kind==="text")toggle(item.id);else{largeTrigger.current=event.currentTarget;setLarge(item);}}} aria-label={kind === "text" ? t("history.compare") : t("common.openLarge")}><ResultPreview item={item}/>{kind !== "text" ? <Expand size={12}/> : null}</button>
      <div className="history-card-head"><label><input type="checkbox" checked={selected.has(item.id)} onChange={() => toggle(item.id)}/><span className="visually-hidden">{t("history.select")}</span></label><strong>{item.active ? <><Check size={11}/>{t("history.active")}</> : formatDate(item.createdAt,{dateStyle:"medium",timeStyle:"short"})}</strong></div>
      <dl><div><dt>{t("history.modelEndpoint")}</dt><dd title={endpointText(item)}>{endpointText(item)}</dd></div><div><dt>{t("history.cost")}</dt><dd>{item.cost == null ? (provenance === "unknown" ? t("data.unknown") : "—") : formatCost(item.cost, provenance === "estimated" ? "estimated" : "actual")}</dd></div></dl>
      {prompt ? <details><summary>{t("history.instruction")}</summary><p>{prompt}</p></details> : null}
      {item.parameters ? <details><summary>{t("history.parameters")}</summary><code>{Object.entries(item.parameters).filter(([key]) => !/prompt|url|path|token|key/i.test(key)).slice(0,12).map(([key,value]) => `${key}: ${String(value)}`).join("\n")}</code></details> : null}
      <footer>{!item.active ? <button className="secondary" disabled={Boolean(busy) || data?.status === "running"} onClick={() => void run(item.id, () => activate(nodeId,item.id))}>{t("history.activate")}</button> : null}<button className="icon-button danger" disabled={item.active || Boolean(busy)} aria-label={t("data.deleteVariant",{name:data?.label ?? "Node"})} onClick={() => void run(item.id, () => remove(nodeId,item.id))}><Trash2 size={12}/></button></footer>
    </article>; })}</div>
    <footer className="history-pagination"><button className="icon-button" disabled={page === 0} onClick={() => setPage(page - 1)} aria-label={t("data.previous")}><ChevronLeft size={14}/></button><span>{page + 1} / {pages}</span><button className="icon-button" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)} aria-label={t("data.next")}><ChevronRight size={14}/></button></footer>
    {large ? <div className="history-lightbox" role="dialog" aria-modal="true" aria-label={t("common.openLarge")} onClick={closeLarge}><button className="icon-button" autoFocus aria-label={t("common.closeLarge")} onClick={closeLarge}><X size={16}/></button><div onClick={(event) => event.stopPropagation()}><ResultPreview item={large} large/></div></div> : null}
  </section>;
}
