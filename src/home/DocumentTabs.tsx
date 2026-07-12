import { AlertTriangle, Check, Circle, Frame, GitBranch, Home, LoaderCircle, RotateCcw, X } from "lucide-react";
import type { KeyboardEvent } from "react";
import type { DocumentSaveState, DocumentTab } from "./types";
import { useI18n, type TranslationKey } from "../i18n";

export type DocumentTabTarget = { surface: "home" } | { surface: "document"; documentId: string };

export interface DocumentTabsProps {
  tabs: readonly DocumentTab[];
  active: DocumentTabTarget;
  onActivate: (target: DocumentTabTarget) => void;
  onCloseRequest: (tab: DocumentTab) => void;
  onKeyboardNavigate?: (target: DocumentTabTarget, event: KeyboardEvent<HTMLButtonElement>) => void;
}

const saveStateKey: Record<DocumentSaveState, TranslationKey> = {
  saved: "tabs.saved", dirty: "tabs.dirty", saving: "tabs.saving", error: "tabs.error", "recovery-required": "tabs.recovery",
};

function TabKindIcon({ tab }: { tab: DocumentTab }) {
  return tab.kind === "flow" ? <GitBranch size={13} aria-hidden="true" /> : <Frame size={13} aria-hidden="true" />;
}

function SaveStateIcon({ state }: { state: DocumentSaveState }) {
  if (state === "saved") return <Check size={11} />;
  if (state === "dirty") return <Circle size={8} fill="currentColor" />;
  if (state === "saving") return <LoaderCircle size={11} className="document-tabs-spinner" />;
  if (state === "recovery-required") return <RotateCcw size={11} />;
  return <AlertTriangle size={11} />;
}

export function getAdjacentTabTarget(tabs: readonly DocumentTab[], current: DocumentTabTarget, key: string): DocumentTabTarget | undefined {
  const targets: DocumentTabTarget[] = [{ surface: "home" }, ...tabs.map((tab) => ({ surface: "document" as const, documentId: tab.documentId }))];
  const currentIndex = current.surface === "home" ? 0 : targets.findIndex((target) => target.surface === "document" && target.documentId === current.documentId);
  if (key === "Home") return targets[0];
  if (key === "End") return targets.at(-1);
  if (key !== "ArrowLeft" && key !== "ArrowRight") return undefined;
  const direction = key === "ArrowLeft" ? -1 : 1;
  const safeIndex = currentIndex < 0 ? 0 : currentIndex;
  return targets[(safeIndex + direction + targets.length) % targets.length];
}

export function DocumentTabs({ tabs, active, onActivate, onCloseRequest, onKeyboardNavigate }: DocumentTabsProps) {
  const {t}=useI18n();
  const handleKeyDown = (target: DocumentTabTarget) => (event: KeyboardEvent<HTMLButtonElement>) => {
    const next = getAdjacentTabTarget(tabs, target, event.key);
    if (!next) return;
    event.preventDefault();
    onActivate(next);
    onKeyboardNavigate?.(next, event);
  };
  const homeActive = active.surface === "home";

  return (
    <nav className="document-tabs" aria-label={t('tabs.openDocuments')}>
      <div role="tablist" aria-label={t('tabs.documents')} aria-orientation="horizontal">
        <button type="button" role="tab" className={`document-tabs-home${homeActive ? " is-active" : ""}`} aria-selected={homeActive} tabIndex={homeActive ? 0 : -1} onClick={() => onActivate({ surface: "home" })} onKeyDown={handleKeyDown({ surface: "home" })}>
          <Home size={14} aria-hidden="true" /><span>{t('tabs.home')}</span>
        </button>
        {tabs.map((tab) => {
          const isActive = active.surface === "document" && active.documentId === tab.documentId;
          const target = { surface: "document" as const, documentId: tab.documentId };
          return (
            <div className={`document-tabs-item document-tabs-item-${tab.kind}${isActive ? " is-active" : ""}`} key={tab.documentId}>
              <button type="button" role="tab" aria-selected={isActive} aria-controls={`document-surface-${tab.documentId}`} aria-label={`${tab.name}, ${tab.kind === "flow" ? "Flow" : "Artboard"}, ${t(saveStateKey[tab.saveState])}`} tabIndex={isActive ? 0 : -1} onClick={() => onActivate(target)} onKeyDown={handleKeyDown(target)}>
                <TabKindIcon tab={tab} />
                <span className="document-tabs-name" title={tab.name}>{tab.name}</span>
                <span className={`document-tabs-save document-tabs-save-${tab.saveState}`} title={t(saveStateKey[tab.saveState])} aria-label={t(saveStateKey[tab.saveState])}><SaveStateIcon state={tab.saveState} /></span>
              </button>
              <button type="button" className="document-tabs-close" aria-label={t('tabs.close',{name:tab.name})} title={tab.saveState === "saving" ? t('tabs.savingHint') : t('tabs.closeHint')} disabled={tab.saveState === "saving"} onClick={() => onCloseRequest(tab)}><X size={13} /></button>
            </div>
          );
        })}
      </div>
    </nav>
  );
}
