import { AlertCircle, RotateCcw, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { loadOrphanResults, type LibraryResult } from '../persistence/library';
import { mediaUrl } from '../persistence/media';
import { formatCurrency, formatDate, localizeErrorMessage, useI18n } from '../i18n';

export function OrphanRunsPalette({ projectId, onClose, onRestore }: { projectId: string; onClose: () => void; onRestore: (result: LibraryResult) => void | Promise<void> }) {
  const {t}=useI18n();const cost=(micros?:number)=>micros==null?'—':formatCurrency(micros/1_000_000);
  const [items, setItems] = useState<LibraryResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let disposed = false; setLoading(true);
    void loadOrphanResults(projectId).then((results) => { if (!disposed) setItems(results); }).catch((reason) => { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)); }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [projectId]);
  return <aside className="orphan-runs-palette" role="dialog" aria-label={t('canvas.unassigned')}>
    <header><div><strong>{t('canvas.unassigned')}</strong><span>{t('orphan.subtitle')}</span></div><button className="icon-button" onClick={onClose} aria-label={t('common.close')}><X size={14} /></button></header>
    <div className="orphan-runs-list">{loading ? <span className="orphan-empty">{t('common.loading')}</span> : error ? <div className="node-error"><AlertCircle size={13} />{localizeErrorMessage(error)}</div> : items.length ? items.map((item) => { const image=Boolean(item.blobHash&&item.mediaType?.startsWith('image/'));return <article key={item.resultId}>{image&&<img className="orphan-image-preview" src={mediaUrl(item.blobHash!)} alt={t('orphan.imageAlt')} />}<div><strong>{item.kind === 'transcription' ? t('orphan.transcript') : image ? t('orphan.imageResult') : item.kind}</strong><span>{formatDate(item.createdAt,{dateStyle:'short',timeStyle:'short'})} · {cost(item.costMicrounits)}</span></div>{item.textValue && <p>{item.textValue}</p>}{item.model && <small>{item.model}</small>}<button className="secondary" disabled={!item.textValue&&!image} onClick={() => void onRestore(item)}><RotateCcw size={12} />{t(image?'orphan.restoreImage':'orphan.restoreText')}</button></article>}) : <span className="orphan-empty">{t('orphan.empty')}</span>}</div>
  </aside>;
}
