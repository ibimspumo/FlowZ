import {
  AlertTriangle,
  ArrowDownAZ,
  Boxes,
  Copy,
  FileQuestion,
  Frame,
  GitBranch,
  ImageOff,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { hasCurrentCover, type DocumentKind, type DocumentRecord } from "./types";
import type { CatalogFilter, CatalogQuery, CatalogSort } from "./catalog";
import { CustomSelect } from "../components/CustomSelect";
import { formatDate, localizeErrorMessage, useI18n, type TranslationKey } from "../i18n";
import "./home.css";
// FlowZ always boots into Home. Co-loading the small persistent tab skin with
// this initial lazy surface keeps the large editor CSS budget isolated.
import "./document-tabs.css";
import { isDesktopRuntime } from "../persistence/projects";

export type HomeContextMenuRequest = {
  document: DocumentRecord;
  source: "pointer" | "keyboard";
  x: number;
  y: number;
};

export type HomeContextMenuState = {
  documentId: string;
  x: number;
  y: number;
};

export interface HomeScreenProps {
  documents: readonly DocumentRecord[];
  query: CatalogQuery;
  selectedDocumentId?: string;
  contextMenu?: HomeContextMenuState;
  loading?: boolean;
  errorMessage?: string;
  locale?: string;
  resolveCoverSrc?: (document: DocumentRecord) => string | undefined;
  canCreateKind?: (kind: DocumentKind) => boolean;
  onCreate: (kind: DocumentKind) => void;
  onOpenSettings?: () => void;
  onQueryChange: (query: CatalogQuery) => void;
  onSelect: (documentId: string) => void;
  onOpen: (document: DocumentRecord) => void;
  onRenameRequest: (document: DocumentRecord) => void;
  onDuplicateRequest: (document: DocumentRecord) => void;
  onDeleteRequest: (document: DocumentRecord) => void;
  onContextMenuRequest: (request: HomeContextMenuRequest) => void;
  onContextMenuClose: () => void;
  emptyAction?: ReactNode;
}

const kindLabel: Record<DocumentKind, string> = { flow: "Flow", artboard: "Artboard" };

function KindIcon({ kind, size = 16 }: { kind: DocumentKind; size?: number }) {
  return kind === "flow" ? <GitBranch size={size} aria-hidden="true" /> : <Frame size={size} aria-hidden="true" />;
}

function healthLabel(document: DocumentRecord, t: (key: TranslationKey, vars?: Readonly<Record<string,string|number>>) => string): string | undefined {
  if (document.health.state === "corrupt") return t('home.corrupt');
  if (document.health.state === "unsupported") return document.health.foundVersion > 0 ? t('home.unsupportedVersion',{version:document.health.foundVersion}) : t('home.unsupportedProject');
  return undefined;
}

export function isDocumentOpenable(document: DocumentRecord): boolean {
  return document.health.state === "healthy";
}

export type HomeCardKeyboardAction = "open" | "rename" | "delete" | "context-menu";

export function getHomeCardKeyboardAction(key: string, shiftKey = false): HomeCardKeyboardAction | undefined {
  if (key === "Enter") return "open";
  if (key === "F2") return "rename";
  if (key === "Delete" || key === "Backspace") return "delete";
  if (key === "F10" && shiftKey) return "context-menu";
  return undefined;
}

export function getHomeCardNavigationIndex(key: string, current: number, count: number): number | undefined {
  if (count < 1 || current < 0 || current >= count) return undefined;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowLeft" || key === "ArrowUp") return Math.max(0, current - 1);
  if (key === "ArrowRight" || key === "ArrowDown") return Math.min(count - 1, current + 1);
  return undefined;
}

function formatUpdatedAt(document: DocumentRecord, unknown: string): string {
  const value = Date.parse(document.updatedAt);
  if (!Number.isFinite(value)) return unknown;
  return formatDate(value);
}

function EmptyCover({ kind }: { kind: DocumentKind }) {
  if (kind === "flow") {
    return (
      <div className="home-cover-fallback home-cover-fallback-flow" aria-hidden="true">
        <span className="home-flow-node home-flow-node-a" />
        <span className="home-flow-node home-flow-node-b" />
        <span className="home-flow-node home-flow-node-c" />
        <svg viewBox="0 0 320 180" preserveAspectRatio="none">
          <path d="M72 62 C128 62, 116 118, 174 118 S236 82, 278 82" />
          <path d="M72 62 C126 62, 126 36, 190 36" />
        </svg>
      </div>
    );
  }
  return (
    <div className="home-cover-fallback home-cover-fallback-artboard" aria-hidden="true">
      <span className="home-artboard-sheet home-artboard-sheet-back" />
      <span className="home-artboard-sheet home-artboard-sheet-front">
        <i />
        <b />
        <em />
      </span>
    </div>
  );
}

function DocumentCard({
  document,
  selected,
  tabbable,
  locale,
  coverSrc,
  onSelect,
  onOpen,
  onRenameRequest,
  onDeleteRequest,
  onContextMenuRequest,
}: {
  document: DocumentRecord;
  selected: boolean;
  tabbable: boolean;
  locale: string;
  coverSrc?: string;
  onSelect: () => void;
  onOpen: () => void;
  onRenameRequest: () => void;
  onDeleteRequest: () => void;
  onContextMenuRequest: (request: HomeContextMenuRequest) => void;
}) {
  const {t}=useI18n();
  const [coverFailed, setCoverFailed] = useState(false);
  useEffect(() => setCoverFailed(false), [coverSrc]);
  const openable = isDocumentOpenable(document);
  const health = healthLabel(document,t);
  const requestContextMenu = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    onSelect();
    onContextMenuRequest({ document, source: "pointer", x: event.clientX, y: event.clientY });
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const action = getHomeCardKeyboardAction(event.key, event.shiftKey);
    if (action === "open" && openable) {
      event.preventDefault();
      onOpen();
    } else if (action === "rename") {
      event.preventDefault();
      onRenameRequest();
    } else if (action === "delete") {
      event.preventDefault();
      onDeleteRequest();
    } else if (action === "context-menu") {
      event.preventDefault();
      const bounds = event.currentTarget.getBoundingClientRect();
      onContextMenuRequest({ document, source: "keyboard", x: bounds.left + 24, y: bounds.top + 24 });
    }
  };

  return (
    <article
      className={`home-document-card home-document-card-${document.kind}${selected ? " is-selected" : ""}${openable ? "" : " is-unavailable"}`}
      aria-label={`${document.name}, ${kindLabel[document.kind]}${health ? `, ${health}` : ""}`}
      aria-selected={selected}
      data-document-id={document.id}
      onClick={onSelect}
      onDoubleClick={openable ? onOpen : undefined}
      onContextMenu={requestContextMenu}
      onKeyDown={handleKeyDown}
      role="option"
      tabIndex={tabbable ? 0 : -1}
    >
      <div className="home-document-cover">
        {coverSrc && hasCurrentCover(document) && !coverFailed ? (
          <img src={coverSrc} alt="" aria-hidden="true" loading="lazy" decoding="async" draggable="false" onError={() => setCoverFailed(true)} />
        ) : (
          <EmptyCover kind={document.kind} />
        )}
        <span className="home-kind-badge"><KindIcon kind={document.kind} size={13} />{kindLabel[document.kind]}</span>
        {!openable && (
          <span className="home-health-badge">
            {document.health.state === "corrupt" ? <AlertTriangle size={13} /> : <FileQuestion size={13} />}
            {health}
          </span>
        )}
      </div>
      <footer className="home-document-meta">
        <div>
          <strong title={document.name}>{document.name}</strong>
          <span>{t('home.changed',{date:formatUpdatedAt(document,t('home.unknownDate'))})}</span>
        </div>
        <span className="home-document-menu-hint" aria-hidden="true"><MoreHorizontal size={16} /></span>
      </footer>
    </article>
  );
}

function DocumentContextMenu({
  document,
  state,
  onOpen,
  onRename,
  onDuplicate,
  onDelete,
  onClose,
}: {
  document: DocumentRecord;
  state: HomeContextMenuState;
  onOpen: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const {t}=useI18n();
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = globalThis.document.activeElement instanceof HTMLElement ? globalThis.document.activeElement : undefined;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    return () => previous?.focus();
  }, []);
  const style = { "--home-menu-x": `${state.x}px`, "--home-menu-y": `${state.y}px` } as CSSProperties;
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") event.preventDefault();
      onClose();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(globalThis.document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : event.key === "ArrowDown" ? (current + 1 + items.length) % items.length
        : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  };
  return (
    <div className="home-context-layer" onPointerDown={onClose}>
      <div ref={menuRef} className="home-context-menu" role="menu" aria-label={t('home.actions',{name:document.name})} style={style} onPointerDown={(event) => event.stopPropagation()} onKeyDown={handleKeyDown}>
        <div className="home-context-heading"><KindIcon kind={document.kind} size={13} /><span>{document.name}</span><button type="button" onClick={onClose} aria-label={t('home.closeMenu')}><X size={14} /></button></div>
        <button type="button" role="menuitem" disabled={!isDocumentOpenable(document)} onClick={onOpen}><Boxes size={14} />{t('home.open')}</button>
        <button type="button" role="menuitem" onClick={onRename}><Pencil size={14} />{t('home.rename')} <kbd>F2</kbd></button>
        <button type="button" role="menuitem" onClick={onDuplicate}><Copy size={14} />{t('home.duplicate')}</button>
        <button type="button" role="menuitem" className="is-danger" onClick={onDelete}><Trash2 size={14} />{t('home.delete')} <kbd>⌫</kbd></button>
      </div>
    </div>
  );
}

export function HomeScreen(props: HomeScreenProps) {
  const {t}=useI18n();
  const desktopRuntime = isDesktopRuntime();
  const canCreate = (kind: DocumentKind) => desktopRuntime && props.canCreateKind?.(kind) !== false;
  const createUnavailable = !desktopRuntime ? t('home.desktopOnlyCreate') : undefined;
  const filterItems: readonly { value: CatalogFilter; label: string }[] = [{value:'all',label:t('home.all')},{value:'flow',label:t('home.flows')},{value:'artboard',label:t('home.artboards')}];
  const sortItems: readonly { value: CatalogSort; label: string }[] = [{value:'updated',label:t('home.sort.updated')},{value:'opened',label:t('home.sort.opened')},{value:'name',label:t('home.sort.name')}];
  const menuDocument = props.contextMenu ? props.documents.find((document) => document.id === props.contextMenu?.documentId) : undefined;
  const selectedVisible = props.documents.some((document) => document.id === props.selectedDocumentId);
  const setQuery = (part: Partial<CatalogQuery>) => props.onQueryChange({ ...props.query, ...part });

  return (
    <main className="home-screen" aria-labelledby="home-title">
      <header className="home-header">
        <div>
          <span className="home-product-mark" aria-hidden="true"><GitBranch size={18} /></span>
          <div><h1 id="home-title">{t('home.title')}</h1><p>{t('home.subtitle')}</p></div>
        </div>
        <nav className="home-create-actions" aria-label={t('home.create')}>
          {props.onOpenSettings ? <button type="button" className="home-create-button home-settings-button" onClick={props.onOpenSettings} aria-label={t('settings.title')}><Settings size={15} />{t('settings.title')}</button> : null}
          <button type="button" className="home-create-button home-create-flow" disabled={!canCreate("flow")} title={createUnavailable} aria-describedby={!desktopRuntime ? "home-create-runtime-note" : undefined} onClick={() => props.onCreate("flow")}><Plus size={15} /><GitBranch size={15} />{t('home.newFlow')}</button>
          <button type="button" className="home-create-button home-create-artboard" disabled={!canCreate("artboard")} title={createUnavailable ?? (props.canCreateKind?.("artboard") === false ? t('home.artboardUnavailable') : undefined)} aria-describedby={!desktopRuntime ? "home-create-runtime-note" : undefined} onClick={() => props.onCreate("artboard")}><Plus size={15} /><Frame size={15} />{t('home.newArtboard')}</button>
        </nav>
      </header>
      {!desktopRuntime ? <p id="home-create-runtime-note" className="home-runtime-note" role="note">{t('home.desktopOnlyCreate')}</p> : null}

      <section className="home-toolbar" aria-label={t('home.filter')}>
        <label className="home-search"><Search size={15} aria-hidden="true" /><span className="home-visually-hidden">{t('home.search')}</span><input type="search" value={props.query.search} placeholder={t('home.search')} onChange={(event) => setQuery({ search: event.target.value })} /></label>
        <div className="home-filter" role="group" aria-label={t('home.documentType')}>
          {filterItems.map((item) => <button key={item.value} type="button" className={props.query.filter === item.value ? "is-active" : ""} aria-pressed={props.query.filter === item.value} onClick={() => setQuery({ filter: item.value })}>{item.label}</button>)}
        </div>
        <div className="home-sort"><ArrowDownAZ size={15} aria-hidden="true" /><CustomSelect label={t('home.sort')} value={props.query.sort} options={[...sortItems]} onChange={(value) => setQuery({ sort: value as CatalogSort })} /></div>
      </section>

      {props.errorMessage ? (
        <section className="home-state home-state-error" role="alert"><AlertTriangle size={20} /><div><strong>{t('home.loadFailed')}</strong><p>{localizeErrorMessage(props.errorMessage)}</p></div></section>
      ) : props.loading ? (
        <section className="home-document-grid" aria-label={t('home.loading')} aria-busy="true">
          {Array.from({ length: 6 }, (_, index) => <div className="home-document-skeleton" key={index} aria-hidden="true"><span /><i /><b /></div>)}
        </section>
      ) : props.documents.length === 0 ? (
        <section className="home-state home-state-empty">
          <ImageOff size={22} />
          <div><strong>{props.query.search || props.query.filter !== "all" ? t('home.noMatches') : t('home.ready')}</strong><p>{props.query.search || props.query.filter !== "all" ? t('home.noMatchesHint') : t('home.readyHint')}</p></div>
          {props.emptyAction ?? (!props.query.search && props.query.filter === "all" ? <button type="button" className="home-create-button home-create-flow" disabled={!canCreate("flow")} aria-describedby={!desktopRuntime ? "home-create-runtime-note" : undefined} onClick={() => props.onCreate("flow")}><Plus size={15} />{t('home.firstFlow')}</button> : undefined)}
        </section>
      ) : (
        <section className="home-document-grid" role="listbox" aria-label={t('home.title')} aria-multiselectable="false" onKeyDown={(event) => {
          const options = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]')];
          const current = options.findIndex((option) => option === (event.target as Element).closest('[role="option"]'));
          const target = getHomeCardNavigationIndex(event.key, current, options.length);
          if (target === undefined || target === current) return;
          event.preventDefault(); const next = props.documents[target]; if (!next) return;
          props.onSelect(next.id); options[target]?.focus();
        }}>
          {props.documents.map((document, index) => {
            return <DocumentCard key={document.id} document={document} selected={props.selectedDocumentId === document.id} tabbable={props.selectedDocumentId === document.id || (!selectedVisible && index === 0)} locale={props.locale??''} coverSrc={props.resolveCoverSrc?.(document)} onSelect={() => props.onSelect(document.id)} onOpen={() => props.onOpen(document)} onRenameRequest={() => props.onRenameRequest(document)} onDeleteRequest={() => props.onDeleteRequest(document)} onContextMenuRequest={props.onContextMenuRequest} />;
          })}
        </section>
      )}

      {menuDocument && props.contextMenu && <DocumentContextMenu document={menuDocument} state={props.contextMenu} onOpen={() => props.onOpen(menuDocument)} onRename={() => props.onRenameRequest(menuDocument)} onDuplicate={() => props.onDuplicateRequest(menuDocument)} onDelete={() => props.onDeleteRequest(menuDocument)} onClose={props.onContextMenuClose} />}
    </main>
  );
}
