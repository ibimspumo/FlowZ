import { Archive, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { saveLibraryAsset, type AssetKind, type LibraryAssetSummary } from '../persistence/assets';
import { CustomSelect } from './CustomSelect';
import { ModalDialog } from './ModalDialog';
import { localizeErrorMessage, useI18n } from '../i18n';

export type SaveAssetDraft = { value: string; kind: AssetKind; name: string; sourceProjectId?: string; sourceNodeId?: string; sourceResultId?: string };

export function SaveAssetDialog({ draft, onClose, onSaved }: { draft?: SaveAssetDraft; onClose: () => void; onSaved: (asset: LibraryAssetSummary) => void }) {
  const {t}=useI18n();
  const [name, setName] = useState(''); const [kind, setKind] = useState<AssetKind>('text'); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => { if (draft) { setName(draft.name); setKind(draft.kind); setError(''); } }, [draft]);
  async function save() {
    if (!draft) return; setBusy(true); setError('');
    try {
      const image = draft.value.startsWith('data:image/');
      const asset = await saveLibraryAsset({ name, kind: image ? 'image' : kind, ...(image ? { dataUrl: draft.value, originalName: `${name || 'Asset'}.png` } : { text: draft.value }), sourceProjectId: draft.sourceProjectId, sourceNodeId: draft.sourceNodeId, sourceResultId: draft.sourceResultId });
      onSaved(asset); onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  const image = draft?.value.startsWith('data:image/');
  return <ModalDialog open={Boolean(draft)} className="save-asset-dialog" onClose={onClose} label={t('assets.saveGlobal')}><header><div><Archive size={17} /><strong>{t('assets.saveAs')}</strong></div><button type="button" className="icon-button" onClick={onClose} aria-label={t('common.close')}><X size={15} /></button></header><div className="save-asset-body"><label className="field-label">Name<input autoFocus value={name} maxLength={120} onChange={(event) => setName(event.target.value)} /></label>{!image && <label className="field-label">{t('assets.type')}<CustomSelect label={t('assets.assetType')} value={kind} options={[{ value: 'prompt', label: 'Prompt' }, { value: 'text', label: 'Text' }]} onChange={(value) => setKind(value as AssetKind)} /></label>}<p>{t('assets.provenance')}</p>{error && <div className="node-error">{localizeErrorMessage(error)}</div>}</div><footer><button type="button" className="secondary" onClick={onClose}>{t('common.cancel')}</button><button type="button" className="primary" disabled={busy || !name.trim()} onClick={() => void save()}>{busy ? t('common.loading') : t('assets.save')}</button></footer></ModalDialog>;
}
