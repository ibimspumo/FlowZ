import { Archive, Check, ChevronLeft, ChevronRight, Download, Expand, FolderOpen, Trash2, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { pickExportFolder, revealExport, writeExport } from "../api";
import { DeferredMarkdown } from "./DeferredMarkdown";
import { formatCost } from "./cost-format";
import { formatDate, useI18n } from "../i18n";
import { mediaUrl } from "../persistence/media";
import { loadLibraryResultData, loadLibraryResultPage, type LibraryResult } from "../persistence/library";
import { isDesktopRuntime } from "../persistence/projects";
import { useFlowStore } from "../store";
import type { HistoryItem } from "../types";
import { resultExportItems, resultExportLabel, resultExportRun } from "./result-export";
import { SaveAssetDialog, type SaveAssetDraft } from "./SaveAssetDialog";
import "./NodeResultHistory.css";

const PAGE_SIZE = 12;
const boundedText = (value: unknown, max = 8_000) => { const text = String(value ?? ""); return text.length > max ? `${text.slice(0,max)}…` : text; };
export const historyPreviewText = (value: unknown, large: boolean) =>
  large ? String(value ?? "") : boundedText(value, 2_000);
const promptText = (item: HistoryItem) => boundedText(item.prompt || item.parameters?.prompt || item.parameters?.instruction);
const endpointText = (item: HistoryItem) => String(item.parameters?.endpoint ?? item.parameters?.model ?? item.model ?? "—");
const mediaKind = (item: HistoryItem) => item.mediaType?.startsWith("image/") ? "image" : item.mediaType?.startsWith("video/") ? "video" : "text";
const preview = (item: HistoryItem) => item.blobHash ? mediaUrl(item.blobHash) : item.value;
const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, video[controls], [tabindex]:not([tabindex="-1"])';

export function trapDialogFocus(event: ReactKeyboardEvent, container: HTMLElement | null) {
  if (event.key !== "Tab" || !container) return;
  const focusable = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
  if (!focusable.length) { event.preventDefault(); container.focus(); return; }
  const first = focusable[0], last = focusable[focusable.length - 1], active = document.activeElement;
  if (event.shiftKey && (active === first || !container.contains(active))) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
}

function ResultPreview({ item, large = false }: { item: HistoryItem; large?: boolean }) {
  const kind = mediaKind(item), source = preview(item);
  if (kind === "image") return <img className={large ? "history-large-media" : "history-thumb"} src={source} alt="" loading="lazy"/>;
  if (kind === "video") return <video className={large ? "history-large-media" : "history-thumb"} src={source} controls={large} preload="metadata"/>;
  return <div className={large ? "history-large-text" : "history-text-preview"}><DeferredMarkdown value={historyPreviewText(item.value, large)}/></div>;
}

export function NodeResultHistory({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
  const data = useFlowStore((state) => state.nodes.find((node) => node.id === nodeId)?.data),
    project = useFlowStore((state) => state.document), projectId = project?.id,
    activate = useFlowStore((state) => state.activateHistoryResult),
    remove = useFlowStore((state) => state.deleteHistoryResult),
    addImages = useFlowStore((state) => state.addImageCollection), addVideos = useFlowStore((state) => state.addVideoCollection), exposeOutputs = useFlowStore((state) => state.setFanOutResults),
    { t } = useI18n(), titleId = useId(), panel = useRef<HTMLElement>(null), closeButton = useRef<HTMLButtonElement>(null), lightbox = useRef<HTMLDivElement>(null), largeTrigger=useRef<HTMLButtonElement|undefined>(undefined), [page, setPage] = useState(0),
    [selected, setSelected] = useState<Set<string>>(new Set()), [large, setLarge] = useState<HistoryItem>(), [busy, setBusy] = useState<string>(), [error, setError] = useState<string>(), [exported, setExported] = useState<{grantId:string;path:string;count:number}>(), [assetDraft,setAssetDraft]=useState<SaveAssetDraft>(),
    [remote, setRemote] = useState<{items:LibraryResult[];total:number}>();
  const history = useMemo(() => [...(data?.history ?? [])].sort((a,b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)), [data?.history]);
  const pages = Math.max(1, Math.ceil((remote?.total ?? history.length) / PAGE_SIZE));
  const remoteHistory = (remote?.items ?? []).map((item) => history.find((local) => local.id === item.resultId) ?? ({ id:item.resultId,runId:item.runId,createdAt:item.createdAt,value:item.textValue ?? "",blobHash:item.blobHash,assetId:item.assetId,mediaType:item.mediaType,model:item.model,prompt:item.prompt,parameters:item.parameters as HistoryItem["parameters"],cost:item.costMicrounits == null ? undefined : item.costMicrounits/1_000_000,persisted:true,active:item.active } satisfies HistoryItem));
  const visible = remote ? remoteHistory : history.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const frame = requestAnimationFrame(() => (closeButton.current ?? panel.current)?.focus());
    return () => {
      cancelAnimationFrame(frame);
      if (previousFocus?.isConnected) queueMicrotask(() => previousFocus.focus());
    };
  }, []);
  useEffect(() => {
    if (!large) return;
    const frame = requestAnimationFrame(() => lightbox.current?.querySelector<HTMLElement>("[data-history-lightbox-close]")?.focus());
    return () => cancelAnimationFrame(frame);
  }, [large]);
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
  const exportResults = async (items: HistoryItem[]) => {
    if (!projectId || !project || !data || !items.length) return;
    setBusy("export"); setError(undefined); setExported(undefined);
    try {
      const folder = await pickExportFolder(projectId); if (!folder) return;
      const result = await writeExport({ projectId, grantId:folder.grantId, project:project.name, node:data.label, run:resultExportRun(items), nameTemplate:"{project}-{node}-{index}", overwrite:"rename", items:resultExportItems(items) });
      if (result.files[0]) setExported({grantId:folder.grantId,path:result.files[0],count:result.files.length});
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(undefined); }
  };
  const saveAsAsset = async (item: HistoryItem) => {
    if (!projectId || !data) return; setBusy(`asset:${item.id}`); setError(undefined);
    try { const kind=mediaKind(item); const value=kind==='image' ? await loadLibraryResultData(projectId,item.id) : item.value; if(!value) throw new Error(t('assets.contentUnavailable')); setAssetDraft({value,kind:kind==='image'?'image':'text',name:`${data.label} · ${formatDate(item.createdAt,{dateStyle:'medium'})}`,sourceProjectId:projectId,sourceNodeId:nodeId,sourceResultId:item.id}); }
    catch(reason){setError(reason instanceof Error?reason.message:String(reason));} finally{setBusy(undefined);}
  };
  const compare = chosen.length === 2 && chosen.every((item) => mediaKind(item) === "text");
  const closeLarge=()=>{setLarge(undefined);queueMicrotask(()=>largeTrigger.current?.focus());};
  const content = <div className="node-result-history-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
  <section ref={panel} tabIndex={-1} className="node-result-history nodrag nowheel nopan" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-hidden={assetDraft ? true : undefined} onWheelCapture={(event) => event.stopPropagation()} onKeyDown={(event) => {
    if (large || assetDraft) return;
    if (event.key === "Escape") { if (large) closeLarge(); else onClose(); event.stopPropagation(); }
    trapDialogFocus(event, panel.current);
    if (event.key === "ArrowLeft" && page > 0) setPage(page - 1);
    if (event.key === "ArrowRight" && page + 1 < pages) setPage(page + 1);
  }}>
    <header><div><strong id={titleId}>{t("common.savedResults")}</strong><span>{history.length} · {data?.label}</span></div><button ref={closeButton} className="icon-button" onClick={onClose} aria-label={t("common.close")}><X size={14}/></button></header>
    {error ? <div className="node-error" role="alert">{error}</div> : null}
    {exported ? <div className="history-exported" role="status"><span>{t("history.exported",{count:exported.count})}</span><button className="secondary" onClick={() => projectId && void revealExport(projectId,exported.grantId,exported.path)}><FolderOpen size={12}/>{t("history.revealExport")}</button></div> : null}
    {chosen.length ? <div className="history-selection"><span>{t("history.selected",{count:chosen.length})}</span><button className="secondary" disabled={Boolean(busy)||!isDesktopRuntime()} onClick={() => void exportResults(chosen)}><Download size={12}/>{t("history.exportSelected")}</button>{chosen.every((item) => ["image","video"].includes(mediaKind(item))) ? <button className="secondary" onClick={() => { if (exposeOutputs(nodeId, chosen.map((item) => item.id))) setSelected(new Set()); }}>{t("history.exposeOutputs")}</button> : null}{chosen.length >= 2 && chosen.every((item) => ["image","video"].includes(mediaKind(item))) ? <button className="secondary" onClick={curate}>{t("history.createCollection")}</button> : null}<button className="secondary" onClick={() => setSelected(new Set())}>{t("history.clearSelection")}</button></div> : null}
    {compare ? <div className="history-compare">{chosen.map((item) => <article key={item.id}><strong>{formatDate(item.createdAt,{dateStyle:"medium",timeStyle:"short"})}</strong><DeferredMarkdown value={item.value}/></article>)}</div> : null}
    <div className="history-grid">{visible.map((item) => { const kind = mediaKind(item), prompt = promptText(item), provenance = item.costProvenance ?? String(item.parameters?.costProvenance ?? "unknown"); return <article key={item.id} className={item.active ? "is-active" : ""}>
      <button type="button" className="history-preview-button" onClick={(event) => { largeTrigger.current=event.currentTarget; setLarge(item); }} aria-label={t("common.openLarge")}><ResultPreview item={item}/><Expand size={12}/></button>
      <div className="history-card-head"><label><input type="checkbox" checked={selected.has(item.id)} onChange={() => toggle(item.id)}/><span className="visually-hidden">{t("history.select")}</span></label><strong>{item.active ? <><Check size={11}/>{t("history.active")}</> : formatDate(item.createdAt,{dateStyle:"medium",timeStyle:"short"})}</strong></div>
      <dl><div><dt>{t("history.modelEndpoint")}</dt><dd title={endpointText(item)}>{endpointText(item)}</dd></div><div><dt>{t("history.cost")}</dt><dd>{item.cost == null ? (provenance === "unknown" ? t("data.unknown") : "—") : formatCost(item.cost, provenance === "estimated" ? "estimated" : "actual")}</dd></div></dl>
      {prompt ? <details><summary>{t("history.instruction")}</summary><p>{prompt}</p></details> : null}
      {item.parameters ? <details><summary>{t("history.parameters")}</summary><code>{Object.entries(item.parameters).filter(([key]) => !/prompt|url|path|token|key/i.test(key)).slice(0,12).map(([key,value]) => `${key}: ${String(value)}`).join("\n")}</code></details> : null}
      <footer><button className="secondary" disabled={Boolean(busy)||!isDesktopRuntime()} onClick={() => void exportResults([item])}><Download size={12}/>{data ? resultExportLabel(data.kind,item.mediaType) : t("history.exportResult")}</button>{kind!=="video"?<button className="icon-button" disabled={Boolean(busy)||!isDesktopRuntime()} aria-label={t('assets.saveGlobal')} title={t('assets.saveGlobal')} onClick={()=>void saveAsAsset(item)}><Archive size={12}/></button>:null}{!item.active ? <button className="secondary" disabled={Boolean(busy) || data?.status === "running"} onClick={() => void run(item.id, () => activate(nodeId,item.id))}>{t("history.activate")}</button> : null}<button className="icon-button danger" disabled={item.active || Boolean(busy)} aria-label={t("data.deleteVariant",{name:data?.label ?? "Node"})} onClick={() => void run(item.id, () => remove(nodeId,item.id))}><Trash2 size={12}/></button></footer>
    </article>; })}</div>
    <footer className="history-pagination"><button className="icon-button" disabled={page === 0} onClick={() => setPage(page - 1)} aria-label={t("data.previous")}><ChevronLeft size={14}/></button><span>{page + 1} / {pages}</span><button className="icon-button" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)} aria-label={t("data.next")}><ChevronRight size={14}/></button></footer>
    {large ? <div ref={lightbox} className="history-lightbox" role="dialog" aria-modal="true" aria-label={t("common.openLarge")} onClick={closeLarge} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeLarge(); return; } event.stopPropagation(); trapDialogFocus(event, lightbox.current); }}><button data-history-lightbox-close className="icon-button" aria-label={t("common.closeLarge")} onClick={closeLarge}><X size={16}/></button><div onClick={(event) => event.stopPropagation()}><ResultPreview item={large} large/></div></div> : null}
    <SaveAssetDialog draft={assetDraft} onClose={()=>setAssetDraft(undefined)} onSaved={()=>setAssetDraft(undefined)}/>
  </section></div>;
  return typeof document === "undefined" ? content : createPortal(content, document.body);
}
