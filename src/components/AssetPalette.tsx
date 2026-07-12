import { ChevronDown, FileText, GripHorizontal, Image as ImageIcon, Library, Plus, Replace, Search, X } from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { getLibraryAssetContent, getLibraryAssetThumbnail, searchLibraryAssets, type AssetKind, type LibraryAssetPayload, type LibraryAssetSummary } from '../persistence/assets';
import { FLOWZ_ASSET_MIME, encodeAssetDrag, isCompatibleAssetTarget } from './asset-drag';
import { clampAssetPalettePosition, isCurrentAssetSearch, type PalettePoint } from './asset-palette-state';
import { localizeErrorMessage, useI18n } from '../i18n';

const POSITION_KEY = 'flowz.asset-palette.position.v1';
const PAGE_SIZE = 30;

type Point = PalettePoint;

function defaultPosition(): Point {
  return { x: Math.max(12, window.innerWidth - 366), y: 70 };
}

function readPosition(): Point {
  try {
    const parsed = JSON.parse(localStorage.getItem(POSITION_KEY) ?? '') as Partial<Point>;
    if (Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) return { x: Number(parsed.x), y: Number(parsed.y) };
  } catch { /* Use the contextual default. */ }
  return defaultPosition();
}

function clampPosition(point: Point, collapsed = false): Point {
  return clampAssetPalettePosition(point, { width: window.innerWidth, height: window.innerHeight }, collapsed);
}

function LazyAssetImage({ asset }: { asset: LibraryAssetSummary }) {
  const ref = useRef<HTMLDivElement>(null);
  const [source, setSource] = useState<string>();
  useEffect(() => {
    const element = ref.current;
    if (!element || source) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void getLibraryAssetThumbnail(asset.versionId).then(setSource).catch(() => undefined);
    }, { rootMargin: '160px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [asset.versionId, source]);
  return <div ref={ref} className="asset-palette-thumbnail">{source ? <img src={source} alt="" /> : <ImageIcon size={15} aria-hidden="true" />}</div>;
}

function makeDragGhost(asset: LibraryAssetSummary, typeLabel: string): HTMLElement {
  const ghost = document.createElement('div');
  ghost.className = `asset-drag-ghost ${asset.kind}`;
  ghost.textContent = `${typeLabel} · ${asset.name}`;
  document.body.appendChild(ghost);
  return ghost;
}

export function AssetPalette({ projectId, open, onClose, onInsert, onAssetDrag, compatibleTargets = [] }: {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onInsert: (item: LibraryAssetPayload, destination: { projectId: string; targetNodeId?: string }) => void | Promise<void>;
  onAssetDrag: (asset?: LibraryAssetSummary) => void;
  compatibleTargets?: ReadonlyArray<{ id: string; label: string; kind: import('../types').NodeKind }>;
}) {
  const {t}=useI18n();
  const [items, setItems] = useState<LibraryAssetSummary[]>([]);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<AssetKind | undefined>();
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const [position, setPosition] = useState<Point>(() => readPosition());
  const [actionVersionId, setActionVersionId] = useState<string>();
  const positionRef = useRef(position);
  const searchRef = useRef<HTMLInputElement>(null);
  const projectRef = useRef(projectId);
  const requestGeneration = useRef(0);
  const dragOrigin = useRef<{ pointer: Point; palette: Point } | undefined>(undefined);
  projectRef.current = projectId;

  useEffect(() => {
    if (!open || collapsed) return;
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open, collapsed]);

  useEffect(() => { if (!open) setActionVersionId(undefined); }, [open]);

  useEffect(() => {
    if (!open) return;
    const resize = () => setPosition((current) => {
      const next = clampPosition(current, collapsed); positionRef.current = next; return next;
    });
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [open, collapsed]);

  useEffect(() => {
    if (!open) return;
    const generation = ++requestGeneration.current;
    const timeout = window.setTimeout(() => {
      setLoading(true); setError(''); setPage(0);
      searchLibraryAssets(query, kind, 0, PAGE_SIZE)
        .then((result) => { if (generation === requestGeneration.current) { setItems(result.items); setTotal(result.total); } })
        .catch((reason) => { if (generation === requestGeneration.current) setError(reason instanceof Error ? reason.message : String(reason)); })
        .finally(() => { if (generation === requestGeneration.current) setLoading(false); });
    }, 180);
    return () => { window.clearTimeout(timeout); if (generation === requestGeneration.current) requestGeneration.current += 1; };
  }, [open, query, kind, projectId]);

  if (!open) return null;

  function beginMove(event: ReactPointerEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest('button')) return;
    dragOrigin.current = { pointer: { x: event.clientX, y: event.clientY }, palette: position };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function move(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragOrigin.current) return;
    const next = clampPosition({
      x: dragOrigin.current.palette.x + event.clientX - dragOrigin.current.pointer.x,
      y: dragOrigin.current.palette.y + event.clientY - dragOrigin.current.pointer.y,
    }, collapsed);
    positionRef.current = next; setPosition(next);
  }

  function finishMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragOrigin.current) return;
    dragOrigin.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    localStorage.setItem(POSITION_KEY, JSON.stringify(positionRef.current));
  }

  async function loadMore() {
    const next = page + 1; const generation = requestGeneration.current; const querySnapshot = query; const kindSnapshot = kind; setLoading(true);
    try {
      const result = await searchLibraryAssets(querySnapshot, kindSnapshot, next, PAGE_SIZE);
      if (!isCurrentAssetSearch({ generation, query: querySnapshot, kind: kindSnapshot }, { generation: requestGeneration.current, query, kind })) return;
      setItems((current) => [...current, ...result.items.filter((item) => !current.some((existing) => existing.versionId === item.versionId))]); setPage(next); setTotal(result.total);
    } catch (reason) { if (generation === requestGeneration.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (generation === requestGeneration.current) setLoading(false); }
  }

  async function insert(asset: LibraryAssetSummary, targetNodeId?: string) {
    setError('');
    const expectedProjectId = projectId;
    try {
      const payload = await getLibraryAssetContent(asset.versionId);
      if (projectRef.current !== expectedProjectId) return;
      await onInsert(payload, { projectId: expectedProjectId, ...(targetNodeId ? { targetNodeId } : {}) });
      setActionVersionId(undefined);
    }
    catch (reason) { if (projectRef.current === expectedProjectId) setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  function startAssetDrag(event: DragEvent<HTMLElement>, asset: LibraryAssetSummary) {
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData(FLOWZ_ASSET_MIME, encodeAssetDrag(asset));
    event.dataTransfer.setData('text/plain', asset.name);
    const typeLabel = t(asset.kind === 'image' ? 'assets.image' : asset.kind === 'prompt' ? 'assets.prompt' : 'assets.text');
    const ghost = makeDragGhost(asset, typeLabel);
    event.dataTransfer.setDragImage(ghost, 18, 18);
    window.setTimeout(() => ghost.remove());
    onAssetDrag(asset);
  }

  return <aside className={`asset-palette nodrag nowheel nopan ${collapsed ? 'is-collapsed' : ''}`} style={{ left: position.x, top: position.y }} aria-label={t('assets.title')} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
    <div className="asset-palette-handle" onPointerDown={beginMove} onPointerMove={move} onPointerUp={finishMove} onPointerCancel={finishMove}>
      <GripHorizontal size={14} aria-hidden="true" />
      <Library size={14} aria-hidden="true" />
      <strong>{t('assets.title')}</strong>
      <span>{total || items.length}</span>
      <button type="button" className="icon-button" onClick={() => setCollapsed((value) => !value)} aria-expanded={!collapsed} aria-label={collapsed ? t('assets.expand') : t('assets.collapse')}><ChevronDown size={14} /></button>
      <button type="button" className="icon-button" onClick={onClose} aria-label={t('common.close')}><X size={14} /></button>
    </div>
    {!collapsed && <>
      <div className="asset-palette-tools">
        <label className="asset-palette-search"><Search size={14} /><input ref={searchRef} value={query} onChange={(event) => { requestGeneration.current += 1; setQuery(event.target.value); }} placeholder={t('assets.search')} aria-label={t('assets.search')} /></label>
        <div className="asset-palette-filters" aria-label={t('assets.filter')}>{([undefined, 'prompt', 'text', 'image'] as const).map((value) => <button type="button" key={value ?? 'all'} className={kind === value ? 'active' : ''} aria-pressed={kind === value} onClick={() => { requestGeneration.current += 1; setKind(value); }}>{value === 'prompt' ? 'Prompts' : value === 'text' ? t('assets.texts') : value === 'image' ? t('assets.images') : t('font.all')}</button>)}</div>
      </div>
      <div className="asset-palette-content" aria-busy={loading}>
        {error && <div className="node-error" role="alert">{localizeErrorMessage(error)}</div>}
        {!loading && !error && !items.length && <div className="asset-palette-empty"><Library size={18} /><strong>{t('assets.empty')}</strong><span>{t('assets.emptyHint')}</span></div>}
        {items.map((asset) => <article className={`asset-palette-item ${asset.kind}`} key={asset.versionId} draggable onDragStart={(event) => startAssetDrag(event, asset)} onDragEnd={() => onAssetDrag()}>
          {asset.kind === 'image' ? <LazyAssetImage asset={asset} /> : <span className="asset-palette-type"><FileText size={14} /></span>}
          <div><strong>{asset.name}</strong><p>{asset.previewText ?? (asset.kind === 'image' ? t('assets.localImage') : '')}</p><small>{t(asset.kind === 'prompt' ? 'assets.prompt' : asset.kind === 'text' ? 'assets.text' : 'assets.image')} · v{asset.version}</small></div>
          <button type="button" className="icon-button" aria-expanded={actionVersionId === asset.versionId} onClick={() => setActionVersionId((current) => current === asset.versionId ? undefined : asset.versionId)} aria-label={t('assets.use',{name:asset.name})} title={t('assets.insertReplace')}><Plus size={14} /></button>
          {actionVersionId === asset.versionId && <div className="asset-palette-actions" role="group" aria-label={t('assets.useNamed',{name:asset.name})}>
            <button type="button" onClick={() => void insert(asset)}><Plus size={13} />{t('assets.insert')}</button>
            {compatibleTargets.filter((target) => isCompatibleAssetTarget(asset.kind, target.kind)).map((target) => <button type="button" key={target.id} onClick={() => void insert(asset, target.id)}><Replace size={13} /><span>{t('assets.replace',{label:target.label})}</span></button>)}
          </div>}
        </article>)}
        {items.length < total && <button type="button" className="asset-palette-more secondary" disabled={loading} onClick={() => void loadMore()}>{loading ? t('common.loading') : t('assets.loadMore',{current:items.length,total})}</button>}
      </div>
      <footer><span>{t('assets.dragHint')}</span></footer>
    </>}
  </aside>;
}
