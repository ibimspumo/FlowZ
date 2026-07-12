import { AlertTriangle, Copy, GitBranch, Pencil, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ModalDialog } from "../components/ModalDialog";
import type { DocumentAction } from "./document-actions";
import { localizeErrorMessage, useI18n } from "../i18n";

export function DocumentActionDialog({ action, busy, error, onClose, onSubmit }: { action?: DocumentAction; busy: boolean; error?: string; onClose: () => void; onSubmit: (name?: string) => void }) {
  const {t}=useI18n();
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  useEffect(() => {
    if (!action) return;
    setName(action.kind === "rename" ? action.name : action.kind === "duplicate" ? action.name : "");
    if (action.kind !== "delete") requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select(); });
  }, [action]);
  if (!action) return null;
  const submit = (event: FormEvent) => { event.preventDefault(); onSubmit(action.kind === "delete" ? undefined : name); };
  const isReferenceConfirmation = action.kind === "delete" && action.references.length > 0;
  const groupedReferences = isReferenceConfirmation ? [...new Map(action.references.map((reference) => [reference.flowId, reference.flowName])).entries()] : [];
  const title = action.kind === "rename" ? t('document.renameTitle') : action.kind === "duplicate" ? t('document.duplicateTitle') : isReferenceConfirmation ? t('document.unlinkDeleteTitle') : t('document.deleteTitle');
  return (
    <ModalDialog open className="home-action-dialog" onClose={() => { if (!busy) onClose(); }} labelledBy={titleId}>
      <form onSubmit={submit} aria-busy={busy}>
        <header><span className={`home-action-icon is-${action.kind}`} aria-hidden="true">{action.kind === "rename" ? <Pencil size={16} /> : action.kind === "duplicate" ? <Copy size={16} /> : <Trash2 size={16} />}</span><div><h2 id={titleId}>{title}</h2><p>{action.document.name}</p></div></header>
        {action.kind === "rename" || action.kind === "duplicate" ? (
          <label className="home-action-field"><span>{action.kind === "rename" ? t('document.newName') : t('document.copyName')}</span><input ref={inputRef} value={name} maxLength={160} disabled={busy} onChange={(event) => setName(event.target.value)} autoComplete="off" /></label>
        ) : isReferenceConfirmation ? (
          <div className="home-reference-warning">
            <p><AlertTriangle size={15} aria-hidden="true" />{t('document.referenceWarning',{count:action.references.length})}</p>
            <ul>{groupedReferences.slice(0, 6).map(([id, flowName]) => { const count = action.references.filter((item) => item.flowId === id).length; return <li key={id}><GitBranch size={13} aria-hidden="true" /><span>{flowName}</span><small>{t('common.nodes',{count})}</small></li>; })}</ul>
            {groupedReferences.length > 6 && <span className="home-reference-more">{t('document.moreFlows',{count:groupedReferences.length-6})}</span>}
          </div>
        ) : <p className="home-delete-copy">{t('document.deleteWarning')}</p>}
        {error && <div className="home-action-error" role="alert"><AlertTriangle size={14} /><span>{localizeErrorMessage(error)}</span></div>}
        <footer><button type="button" className="secondary" disabled={busy} onClick={onClose}>{t('common.cancel')}</button><button type="submit" className={action.kind === "delete" ? "danger" : "primary"} disabled={busy || (action.kind !== "delete" && !name.trim())}>{busy ? t('document.running') : action.kind === "rename" ? t('home.rename') : action.kind === "duplicate" ? t('document.createCopy') : isReferenceConfirmation ? t('document.unlinkDelete') : t('document.deletePermanent')}</button></footer>
      </form>
    </ModalDialog>
  );
}
