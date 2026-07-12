import { getVersion } from '@tauri-apps/api/app';
import { relaunch } from '@tauri-apps/plugin-process';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { CheckCircle2, Download, LoaderCircle, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { advanceDownload, attemptUpdaterAction, finishDownload, OperationGate, startDownload, UPDATER_ERROR_ALERT_PROPS, updaterErrorMessage, type DownloadProgress } from './app-updater-state';
import { formatDate, formatFileSize, localizeErrorMessage, useI18n } from '../i18n';

type UpdatePhase = 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'installed' | 'error';
const isDesktopRuntime = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export function AppUpdater({ active }: { active: boolean }) {
  const {t}=useI18n();
  const updateRef = useRef<Update | null>(null);
  const operations = useRef(new OperationGate());
  const [currentVersion, setCurrentVersion] = useState('…');
  const [latestVersion, setLatestVersion] = useState<string>();
  const [notes, setNotes] = useState<string>();
  const [date, setDate] = useState<string>();
  const [phase, setPhase] = useState<UpdatePhase>('idle');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<DownloadProgress>(() => startDownload());

  useEffect(() => {
    if (!active || !isDesktopRuntime()) return;
    let cancelled = false;
    void getVersion().then((version) => { if (!cancelled) setCurrentVersion(version); }).catch(() => { if (!cancelled) setCurrentVersion('Unbekannt'); });
    return () => { cancelled = true; };
  }, [active]);

  useEffect(() => () => {
    operations.current.dispose();
    const pending = updateRef.current;
    updateRef.current = null;
    if (pending) void attemptUpdaterAction(() => pending.close());
  }, []);

  if (!isDesktopRuntime()) return null;

  async function checkForUpdate() {
    const token = operations.current.begin();
    setPhase('checking'); setError(''); setLatestVersion(undefined); setNotes(undefined); setDate(undefined);
    try {
      const previous = updateRef.current; updateRef.current = null;
      if (previous) {
        const closeError = await attemptUpdaterAction(() => previous.close());
        if (closeError) throw new Error(closeError);
      }
      if (!operations.current.isCurrent(token)) return;
      const installedVersion = await getVersion();
      if (!operations.current.isCurrent(token)) return;
      setCurrentVersion(installedVersion);
      const update = await check({ timeout: 30_000 });
      if (!operations.current.isCurrent(token)) { if (update) await attemptUpdaterAction(() => update.close()); return; }
      updateRef.current = update;
      if (!update) { setLatestVersion(installedVersion); setPhase('current'); return; }
      setLatestVersion(update.version); setNotes(update.body); setDate(update.date); setPhase('available');
    } catch (cause) {
      if (operations.current.isCurrent(token)) { setError(updaterErrorMessage(cause)); setPhase('error'); }
    }
  }

  async function installUpdate() {
    const update = updateRef.current;
    if (!update) return;
    const token = operations.current.begin();
    setPhase('downloading'); setError(''); setProgress(startDownload());
    try {
      await update.downloadAndInstall((event) => {
        if (!operations.current.isCurrent(token)) return;
        if (event.event === 'Started') setProgress(startDownload(event.data.contentLength));
        if (event.event === 'Progress') setProgress((value) => advanceDownload(value, event.data.chunkLength));
        if (event.event === 'Finished') setProgress(finishDownload);
      }, { timeout: 10 * 60_000 });
      if (operations.current.isCurrent(token)) setPhase('installed');
    } catch (cause) {
      if (operations.current.isCurrent(token)) { setError(updaterErrorMessage(cause)); setPhase('error'); }
    } finally {
      if (updateRef.current === update) updateRef.current = null;
      await attemptUpdaterAction(() => update.close());
    }
  }

  async function restartApp() {
    setError('');
    const restartError = await attemptUpdaterAction(relaunch);
    if (restartError) setError(restartError);
  }

  const percent = progress.total ? Math.round(progress.downloaded / progress.total * 100) : undefined;
  const status = phase === 'checking' ? t('updater.checking')
    : phase === 'current' ? t('updater.current')
    : phase === 'available' ? t('updater.available',{version:latestVersion??''})
    : phase === 'downloading' ? percent == null ? t('updater.download') : t('updater.downloadPercent',{percent})
    : phase === 'installed' ? t('updater.ready')
    : phase === 'error' ? t('updater.failed')
    : t('updater.idle');

  return <section className="provider-key-section updater-section" aria-labelledby="app-update-heading">
    <header><strong id="app-update-heading">FlowZ · {t('updater.title')}</strong><span>{t('updater.subtitle')}</span></header>
    <div className="update-versions"><span>{t('updater.installedVersion')} <strong>{currentVersion}</strong></span><span>{t('updater.latestVersion')} <strong>{latestVersion ?? t('updater.notChecked')}</strong></span></div>
    <p className={`update-status ${phase}`} role={phase === 'error' ? 'alert' : 'status'} aria-live="polite">{phase === 'installed' && <CheckCircle2 size={14} />}{status}</p>
    {phase === 'downloading' && <div className="update-progress">
      <progress aria-label={t('updater.downloadProgress')} {...(progress.total ? { value: progress.downloaded, max: progress.total } : {})} />
      <small>{progress.total ? `${formatFileSize(progress.downloaded)} / ${formatFileSize(progress.total)}` : t('updater.download')}</small>
    </div>}
    {(notes || date) && <div className="update-notes"><strong>{t('updater.releaseNotes')}{date ? ` · ${formatDate(date,{dateStyle:'medium'})}` : ''}</strong><p>{notes || t('updater.noNotes')}</p></div>}
    {error && <p className="dialog-error" {...UPDATER_ERROR_ALERT_PROPS}>{localizeErrorMessage(error)}</p>}
    <div className="dialog-actions compact">
      {phase === 'available' && <button className="primary" onClick={() => void installUpdate()}><Download size={15} />{t('updater.install')}</button>}
      {phase === 'installed' && <button className="primary" onClick={() => void restartApp()}><RefreshCw size={15} />{t('updater.restart')}</button>}
      {phase !== 'available' && phase !== 'installed' && <button className="secondary" disabled={phase === 'checking' || phase === 'downloading'} onClick={() => void checkForUpdate()}>{phase === 'checking' ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}{t('updater.check')}</button>}
    </div>
  </section>;
}
