import { CheckCircle2, KeyRound, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { braveKeyStatus, clearFalUploadCache, deleteBrandFontCache, deleteBraveKey, deleteFalKey, deleteKey, falKeyStatus, falUploadCacheStatus, keyStatus, listBrandFontCache, saveBraveKey, saveFalKey, saveKey, type FontCacheEntry } from '../api';
import { AppUpdater } from './AppUpdater';
import { formatFileSize, localizeErrorMessage, useI18n } from '../i18n';
import { CustomSelect } from './CustomSelect';

export function Settings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const {locale,setLocale,t}=useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const [key, setKey] = useState(''); const [saved, setSaved] = useState(false); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [braveKey, setBraveKey] = useState(''); const [braveSaved, setBraveSaved] = useState(false); const [braveBusy, setBraveBusy] = useState(false);
  const [falKey, setFalKey] = useState(''); const [falSaved, setFalSaved] = useState(false); const [falBusy, setFalBusy] = useState(false);
  const [falCache, setFalCache] = useState<{ entries: number; nextExpiry?: string }>({ entries: 0 });
  const [fontCache,setFontCache]=useState<FontCacheEntry[]>([]);
  useEffect(() => { if (open) { ref.current?.showModal(); void Promise.all([keyStatus().then(setSaved), braveKeyStatus().then(setBraveSaved), falKeyStatus().then(setFalSaved), falUploadCacheStatus().then(setFalCache),listBrandFontCache().then(setFontCache)]); } else ref.current?.close(); }, [open]);
  async function store() { setBusy(true); setError(''); try { await saveKey(key); setSaved(true); setKey(''); } catch (e) { setError(String(e)); } finally { setBusy(false); } }
  async function remove() { try { await deleteKey(); setSaved(false); } catch (e) { setError(String(e)); } }
  async function storeBrave() { setBraveBusy(true); setError(''); try { await saveBraveKey(braveKey); setBraveSaved(true); setBraveKey(''); } catch (e) { setError(String(e)); } finally { setBraveBusy(false); } }
  async function removeBrave() { try { await deleteBraveKey(); setBraveSaved(false); } catch (e) { setError(String(e)); } }
  async function storeFal() { setFalBusy(true); setError(''); try { await saveFalKey(falKey); setFalSaved(true); setFalKey(''); } catch (e) { setError(String(e)); } finally { setFalBusy(false); } }
  async function removeFal() { try { await deleteFalKey(); setFalSaved(false); } catch (e) { setError(String(e)); } }
  async function clearFalCache() { try { await clearFalUploadCache(); setFalCache({ entries: 0 }); } catch (e) { setError(String(e)); } }
  return <dialog ref={ref} className="settings-dialog" aria-labelledby="settings-dialog-title" onClose={onClose} onCancel={onClose}>
    <div className="dialog-heading"><div><KeyRound size={20} /><div><h2 id="settings-dialog-title">{t('settings.title')}</h2><p>{t('settings.subtitle')}</p></div></div><button className="icon-button" onClick={onClose} aria-label={t('settings.close')}><X size={17} /></button></div>
    <section className="provider-key-section"><header><strong>{t('settings.interface')}</strong><span>{t('language.hint')}</span></header><label className="field-label">{t('language.label')}<CustomSelect label={t('language.label')} value={locale} options={[{value:'de',label:t('language.de')},{value:'en',label:t('language.en')}]} onChange={(value)=>setLocale(value==='en'?'en':'de')}/></label></section>
    <section className="provider-key-section"><header><strong>OpenRouter</strong><span>{t('settings.openrouterHint')}</span></header>
    <div className={`key-status ${saved ? 'connected' : ''}`}>{saved ? <><CheckCircle2 size={16} /> {t('settings.keyConnected')}</> : t('settings.keyMissing')}</div>
    <label className="field-label">{t('settings.apiKey')}<input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-or-v1-…" /></label>
    <div className="dialog-actions compact">{saved && <button className="secondary danger" onClick={remove}><Trash2 size={15} />{t('settings.remove')}</button>}<button className="primary" disabled={busy || !key} onClick={store}>{busy ? t('common.loading') : t('settings.save')}</button></div></section>
    <section className="provider-key-section"><header><strong>fal.ai</strong><span>{t('settings.falHint')}</span></header>
    <div className={`key-status ${falSaved ? 'connected' : ''}`}>{falSaved ? <><CheckCircle2 size={16} /> {t('settings.falConnected')}</> : t('settings.falMissing')}</div>
    <label className="field-label">{t('settings.apiKey')}<input type="password" autoComplete="off" value={falKey} onChange={(e) => setFalKey(e.target.value)} placeholder="fal.ai Key ID:Secret" /></label>
    <div className="dialog-actions compact">{falSaved && <button className="secondary danger" onClick={removeFal}><Trash2 size={15} />{t('settings.remove')}</button>}<button className="primary" disabled={falBusy || !falKey} onClick={storeFal}>{falBusy ? t('common.loading') : t('settings.save')}</button></div></section>
    <section className="provider-key-section"><header><strong>{t('settings.cacheTitle')}</strong><span>{falCache.entries ? t('settings.cacheCount',{count:falCache.entries}) : t('settings.cacheEmpty')}</span></header><p className="privacy-note">{t('settings.cachePrivacy')}</p><div className="dialog-actions compact"><button className="secondary danger" disabled={!falCache.entries} onClick={() => void clearFalCache()}><Trash2 size={15} />{t('settings.clearCache')}</button></div></section>
    <section className="provider-key-section"><header><strong>{t('settings.fontCache')}</strong><span>{fontCache.length?t('settings.fontCacheCount',{count:fontCache.length,size:formatFileSize(fontCache.reduce((sum,item)=>sum+item.sizeBytes,0))}):t('settings.fontCacheEmpty')}</span></header><p className="privacy-note">{t('settings.fontCacheHint')}</p>{fontCache.slice(0,12).map(font=><div className="cache-font-row" key={font.blobHash}><span>{font.family} · {font.style} {font.weight}</span><button className="icon-button danger" aria-label={t('settings.deleteFont',{family:font.family})} onClick={()=>void deleteBrandFontCache(font.blobHash).then(()=>setFontCache(items=>items.filter(item=>item.blobHash!==font.blobHash))).catch(reason=>setError(String(reason)))}><Trash2 size={12}/></button></div>)}</section>
    <section className="provider-key-section"><header><strong>Brave Search</strong><span>{t('settings.braveHint')}</span></header>
    <div className={`key-status ${braveSaved ? 'connected' : ''}`}>{braveSaved ? <><CheckCircle2 size={16} /> {t('settings.braveConnected')}</> : t('settings.braveMissing')}</div>
    <label className="field-label">{t('settings.braveToken')}<input type="password" autoComplete="off" value={braveKey} onChange={(e) => setBraveKey(e.target.value)} placeholder="Brave Search API Token" /></label>
    <div className="dialog-actions compact">{braveSaved && <button className="secondary danger" onClick={removeBrave}><Trash2 size={15} />{t('settings.remove')}</button>}<button className="primary" disabled={braveBusy || !braveKey} onClick={storeBrave}>{braveBusy ? t('common.loading') : t('settings.save')}</button></div></section>
    <AppUpdater active={open} />
    {error && <p className="dialog-error" role="alert" aria-live="assertive">{localizeErrorMessage(error)}</p>}
    <p className="privacy-note">{t('settings.credentialsPrivacy')}</p>
  </dialog>;
}
