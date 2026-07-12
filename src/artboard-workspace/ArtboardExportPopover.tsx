import { Check, FileArchive, FolderOpen, Image, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent } from "react";
import type { ArtboardExportFolderGrant, ArtboardExportResult } from "../api";
import { formatNumber, useI18n } from "../i18n";

export type ArtboardExportOptions = {
  includeManifest: boolean;
  overwrite: "rename" | "replace" | "error";
};

export function ArtboardExportPopover(props: {
  boardNames: string[];
  folder?: ArtboardExportFolderGrant;
  busy: boolean;
  progress: number;
  result?: ArtboardExportResult;
  error?: string;
  options: ArtboardExportOptions;
  onOptions: (options: ArtboardExportOptions) => void;
  onChooseFolder: () => void;
  onExport: () => void;
  onReveal: () => void;
  onClose: () => void;
}) {
  const {t}=useI18n();
  const count = props.boardNames.length;
  const dialogRef=useRef<HTMLElement>(null);
  const previousFocusRef=useRef<HTMLElement | null>(null);
  useEffect(()=>{
    previousFocusRef.current=document.activeElement instanceof HTMLElement?document.activeElement:null;
    dialogRef.current?.querySelector<HTMLElement>("button:not(:disabled),input:not(:disabled)")?.focus();
    return()=>previousFocusRef.current?.focus();
  },[]);
  const onKeyDown=(event:KeyboardEvent<HTMLElement>)=>{
    if(event.key==="Escape"&&!props.busy){event.preventDefault();props.onClose();return;}
    if(event.key!=="Tab")return;
    const controls=[...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),[tabindex]:not([tabindex='-1'])")??[])];
    if(!controls.length)return;const first=controls[0],last=controls[controls.length-1];
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  };
  return <div className="awb-export-scrim" onMouseDown={(event) => { if (event.currentTarget === event.target && !props.busy) props.onClose(); }}>
    <section ref={dialogRef} className="awb-export-popover" role="dialog" aria-modal="true" aria-labelledby="awb-export-title" aria-describedby="awb-export-summary" onKeyDown={onKeyDown}>
      <header><div><strong id="awb-export-title">{t('artboard.exportTitle')}</strong><span id="awb-export-summary">{count === 1 ? props.boardNames[0] : t('artboard.selectedCount',{count})}</span></div><button type="button" className="awb-icon-button" onClick={props.onClose} disabled={props.busy} aria-label={t('artboard.closeExport')}><X size={15}/></button></header>
      <div className="awb-export-body">
        <div className="awb-export-kind"><Image size={15}/><span><strong>{t('artboard.pngComposites')}</strong><small>{t('artboard.exactRevision')}</small></span><b>{formatNumber(count)}</b></div>
        <label className="awb-export-check"><input type="checkbox" checked={props.options.includeManifest} onChange={(event) => props.onOptions({ ...props.options, includeManifest: event.currentTarget.checked })}/><span><FileArchive size={14}/><span><strong>{t('artboard.workspaceManifest')}</strong><small>{t('artboard.manifestHint')}</small></span></span></label>
        <fieldset className="awb-export-collisions"><legend>{t('artboard.sameFilename')}</legend>{([
          ["rename", t('artboard.renameCollision')], ["replace", t('artboard.replaceCollision')], ["error", t('artboard.abortCollision')],
        ] as const).map(([value,label])=><label key={value}><input type="radio" name="artboard-overwrite" value={value} checked={props.options.overwrite===value} onChange={()=>props.onOptions({...props.options,overwrite:value})}/><span>{label}</span></label>)}</fieldset>
        <button type="button" className="awb-export-folder" onClick={props.onChooseFolder} disabled={props.busy}><FolderOpen size={15}/><span><strong>{props.folder?.displayName ?? t('artboard.chooseFolder')}</strong><small>{props.folder ? t('artboard.folderGranted') : t('artboard.folderHint')}</small></span></button>
        {props.busy ? <div className="awb-export-progress" role="status" aria-live="polite"><div><span>{t('artboard.exportPreparing')}</span><b>{formatNumber(Math.round(props.progress))} %</b></div><progress max="100" value={props.progress}/></div> : null}
        {props.error ? <p className="awb-export-error" role="alert">{props.error}</p> : null}
        {props.result ? <div className="awb-export-success" role="status"><Check size={15}/><span><strong>{t('artboard.exportedFiles',{count:props.result.files.length})}</strong><small>{props.result.folder}</small></span></div> : null}
      </div>
      <footer>{props.result ? <><button type="button" className="awb-button" onClick={props.onClose}>{t('artboard.done')}</button><button type="button" className="awb-button awb-button-primary" onClick={props.onReveal}><FolderOpen size={14}/>{t('artboard.reveal')}</button></> : <><button type="button" className="awb-button" onClick={props.onClose} disabled={props.busy}>{t('common.cancel')}</button><button type="button" className="awb-button awb-button-primary" onClick={props.onExport} disabled={props.busy}>{props.busy?<LoaderCircle className="spin" size={14}/>:<Image size={14}/>} {t('artboard.exportPng')}</button></>}</footer>
    </section>
  </div>;
}
