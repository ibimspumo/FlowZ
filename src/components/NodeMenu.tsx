import { ArrowLeft, LayoutTemplate, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { registry } from '../registry';
import type { DataType, NodeDefinition, NodeKind } from '../types';
import { closeActiveSelect } from './select-coordinator';
import { canvasTemplates, type CanvasTemplate } from '../templates';
import { localizeTemplateMeta, useI18n } from '../i18n';
import { localizedCategory, localizedNodeDescription, localizedNodeLabel } from '../i18n-schema';

export type PendingConnection = {
  nodeId: string;
  handleId: string;
  handleType: 'source' | 'target';
  dataType: DataType;
};

export type NodeMenuState = {
  screen: { x: number; y: number };
  flow: { x: number; y: number };
  pending?: PendingConnection;
  initialView?: 'nodes' | 'templates';
};

function accepts(definition: NodeDefinition, pending?: PendingConnection) {
  if (!pending) return true;
  return pending.handleType === 'source'
    ? definition.inputs.some((input) => input.type === pending.dataType)
    : definition.outputs.some((output) => output.type === pending.dataType);
}

export function NodeMenu({ state, onSelect, onSelectTemplate, onClose }: {
  state: NodeMenuState;
  onSelect: (kind: NodeKind) => void;
  onSelectTemplate: (template: CanvasTemplate) => void;
  onClose: () => void;
}) {
  const {locale,t}=useI18n();
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'nodes'|'templates'>(state.pending ? 'nodes' : state.initialView ?? 'nodes');
  const [selectedTemplate, setSelectedTemplate] = useState<CanvasTemplate>();
  const searchRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    closeActiveSelect();
    searchRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') closeRef.current(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => { window.removeEventListener('keydown', closeOnEscape); window.requestAnimationFrame(() => previousFocus?.focus()); };
  }, []);
  useEffect(() => {
    if (state.pending) { setView('nodes'); setSelectedTemplate(undefined); }
  }, [state.pending]);

  const definitions = useMemo(() => Object.values(registry).filter((definition) => {
    const matchesSearch = `${localizedNodeLabel(definition.kind,definition.label)} ${localizedNodeDescription(definition.kind,definition.description)} ${localizedCategory(definition.category)}`.toLocaleLowerCase(locale).includes(search.toLocaleLowerCase(locale));
    return !definition.hidden && matchesSearch && accepts(definition, state.pending);
  }), [search, state.pending,locale]);
  const templates = useMemo(() => canvasTemplates.map(localizeTemplateMeta).filter((template) => `${template.name} ${template.summary} ${localizedCategory(template.category)}`.toLocaleLowerCase(locale).includes(search.toLocaleLowerCase(locale))), [search,locale]);

  const pendingType = state.pending?.dataType;
  const typeName = pendingType === 'image' ? t('menu.typeImage') : pendingType === 'video' ? t('menu.typeVideo') : pendingType === 'audio' ? t('menu.typeAudio') : pendingType === 'json' ? t('menu.typeArtifact') : pendingType === 'jsonList' ? t('menu.typeArtifactList') : pendingType?.endsWith('List') || pendingType === 'list' ? t('menu.typeList') : t('menu.typeText');
  const direction = state.pending?.handleType === 'source' ? t('menu.inputs') : t('menu.outputs');

  return <div className="node-menu" style={{ left: state.screen.x, top: state.screen.y }} role="dialog" aria-modal="false" aria-label={view === 'templates' ? t('template.use') : t('canvas.addNode')} onContextMenu={(event) => event.preventDefault()}>
    {state.pending && <div className="node-menu-context"><span className={`type-dot ${state.pending.dataType}`} /> <span>{t('menu.compatible',{type:typeName,direction})}</span><button className="icon-button" onClick={onClose} aria-label={t('menu.close')}><X size={13} /></button></div>}
    {!state.pending && <div className="node-menu-tabs" role="tablist" aria-label={t('menu.add')}><button role="tab" aria-selected={view === 'nodes'} onClick={() => { setView('nodes'); setSelectedTemplate(undefined); setSearch(''); }}>{t('menu.nodes')}</button><button role="tab" aria-selected={view === 'templates'} onClick={() => { setView('templates'); setSearch(''); }}><LayoutTemplate size={12}/>{t('menu.templates')}</button><button className="icon-button" onClick={onClose} aria-label={t('common.close')}><X size={13}/></button></div>}
    {selectedTemplate ? <div className="template-preview">
      <button className="template-back" onClick={() => setSelectedTemplate(undefined)}><ArrowLeft size={12}/>{t('menu.allTemplates')}</button>
      <strong>{selectedTemplate.name}</strong><p>{selectedTemplate.summary}</p>
      <div className="template-facts"><span>{t('template.nodes',{count:selectedTemplate.nodes.length})}</span><span>{localizedCategory(selectedTemplate.category)}</span></div>
      <div className="template-cost"><strong>{t('menu.insertFree')}</strong><span>{selectedTemplate.paidNodeCount ? t('menu.variableCost',{count:selectedTemplate.paidNodeCount}) : t('menu.localFree')}</span></div>
      <div className="template-first-run"><strong>{t('template.firstRun')}</strong><span>{selectedTemplate.firstRun}</span></div>
      <ul>{selectedTemplate.hints.map((hint) => <li key={hint}>{hint}</li>)}</ul>
      <button className="primary template-insert" onClick={() => onSelectTemplate(selectedTemplate)}>{t('template.use')}</button>
    </div> : <>
    <label className="node-menu-search"><Search size={13} /><input ref={searchRef} value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { if (view === 'nodes' && definitions[0]) onSelect(definitions[0].kind); if (view === 'templates' && templates[0]) setSelectedTemplate(templates[0]); } }} placeholder={view === 'templates' ? t('menu.searchTemplate') : t('menu.searchNode')} /></label>
    <div className="node-menu-list">
      {view === 'nodes' && (['Eingabe', 'Kontext', 'Marke', 'Modell'] as const).map((category) => {
        const items = definitions.filter((definition) => definition.category === category);
        if (!items.length) return null;
        return <section key={category}><h2>{localizedCategory(category)}</h2>{items.map((definition) => {
          return <button key={definition.kind} className="node-menu-item" onClick={() => onSelect(definition.kind)}>
            <span className={`type-dot ${definition.outputs[0]?.type ?? definition.inputs[0]?.type ?? 'text'}`} />
            <span>{localizedNodeLabel(definition.kind,definition.label)}</span>
          </button>;
        })}</section>;
      })}
      {view === 'templates' && (['Marke','Content','Video','Recherche','Werkzeug'] as const).map((category) => {
        const items = templates.filter((template) => template.category === category); if (!items.length) return null;
        return <section key={category}><h2>{localizedCategory(category)}</h2>{items.map((template) => <button key={template.id} className="node-menu-item template-menu-item" onClick={() => setSelectedTemplate(template)}><LayoutTemplate size={12}/><span>{template.name}</span><small>{template.nodes.length}</small></button>)}</section>;
      })}
      {view === 'nodes' && !definitions.length && <div className="node-menu-empty">{t('menu.noNode')}</div>}
      {view === 'templates' && !templates.length && <div className="node-menu-empty">{t('menu.noTemplate')}</div>}
    </div>
    </>}
  </div>;
}
