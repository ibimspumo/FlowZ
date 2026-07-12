import { Check, ChevronDown, Search } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { activateSelect, closeActiveSelect, deactivateSelect } from './select-coordinator';
import { useI18n } from '../i18n';

export type SelectOption = { value: string; label: string };
export const customSelectOptionId=(id:string,index:number)=>`${id}-option-${index}`;

export function CustomSelect({ value, options, onChange, label, searchable = false }: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  label: string;
  searchable?: boolean;
}) {
  const {t}=useI18n();
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0 });

  const uniqueOptions = useMemo(() => Array.from(new Map(options.map((option) => [option.value, option])).values()), [options]);
  const filtered = useMemo(() => uniqueOptions.filter((option) => option.label.toLowerCase().includes(query.toLowerCase()) || option.value.toLowerCase().includes(query.toLowerCase())), [uniqueOptions, query]);
  const selected = uniqueOptions.find((option) => option.value === value) ?? { value, label: value };
  const activeOptionId = filtered[active] ? customSelectOptionId(id,active) : undefined;

  function place() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const popupHeight = searchable ? 280 : Math.min(230, uniqueOptions.length * 33 + 10);
    const top = window.innerHeight - rect.bottom > popupHeight + 8 ? rect.bottom + 5 : Math.max(8, rect.top - popupHeight - 5);
    setPosition({ left: Math.min(rect.left, window.innerWidth - Math.max(rect.width, 220) - 8), top, width: Math.max(rect.width, searchable ? 278 : 180) });
  }

  function show() {
    place(); setQuery(''); setActive(Math.max(0, uniqueOptions.findIndex((option) => option.value === value))); setOpen(true);
  }

  function choose(option: SelectOption) {
    onChange(option.value); setOpen(false); triggerRef.current?.focus();
  }

  function handleKeys(event: KeyboardEvent) {
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); triggerRef.current?.focus(); return; }
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((index) => Math.min(filtered.length - 1, index + 1)); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActive((index) => Math.max(0, index - 1)); return; }
    if (event.key === 'Enter' && filtered[active]) { event.preventDefault(); choose(filtered[active]); }
  }

  useEffect(() => {
    if (!open) return;
    activateSelect(id, () => setOpen(false));
    const focusTarget = searchable ? searchRef.current : listRef.current;
    focusTarget?.focus();
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !document.getElementById(`${id}-popup`)?.contains(target)) setOpen(false);
    };
    const closeOnViewportChange = () => closeActiveSelect();
    const closeOnGlobalUi = () => closeActiveSelect();
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('flowz:close-selects', closeOnGlobalUi);
    window.addEventListener('resize', closeOnViewportChange);
    return () => {
      deactivateSelect(id);
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('flowz:close-selects', closeOnGlobalUi);
      window.removeEventListener('resize', closeOnViewportChange);
    };
  }, [id, open, searchable]);

  useEffect(() => setActive(0), [query]);

  return <>
    <button ref={triggerRef} type="button" className="custom-select-trigger nodrag nowheel nopan" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={`${id}-listbox`} onClick={() => open ? setOpen(false) : show()} onKeyDown={(event) => { if (!open && ['Enter', ' ', 'ArrowDown'].includes(event.key)) { event.preventDefault(); show(); } }}>
      <span>{selected.label}</span><ChevronDown size={13} />
    </button>
    {open && createPortal(<div id={`${id}-popup`} className="custom-select-popup nodrag nowheel nopan" style={position}>
      {searchable && <label className="select-search"><Search size={13} /><input ref={searchRef} role="combobox" aria-label={t('common.searchWithin',{label})} aria-autocomplete="list" aria-expanded="true" aria-controls={`${id}-listbox`} aria-activedescendant={activeOptionId} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={handleKeys} placeholder={t('common.search')} /></label>}
      <div ref={listRef} id={`${id}-listbox`} className="custom-select-list" role="listbox" aria-label={label} aria-activedescendant={activeOptionId} tabIndex={searchable ? -1 : 0} onKeyDown={handleKeys}>
        {filtered.map((option, index) => <button id={customSelectOptionId(id,index)} type="button" role="option" aria-selected={option.value === value} className={`custom-select-option ${index === active ? 'active' : ''}`} key={option.value} onPointerMove={() => setActive(index)} onClick={() => choose(option)}><span>{option.label}</span>{option.value === value && <Check size={13} />}</button>)}
        {!filtered.length && <div className="select-empty">{t('common.noResults')}</div>}
      </div>
    </div>, document.body)}
  </>;
}
