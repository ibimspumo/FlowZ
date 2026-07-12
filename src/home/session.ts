import { emptyViewState, type AppSession, type DocumentRecord, type DocumentTab, type DocumentViewState } from "./types";

export const MAX_RESTORED_DOCUMENT_TABS = 8;

export type SessionAction =
  | { type: "show-home" }
  | { type: "open"; document: DocumentRecord; at: string }
  | { type: "activate"; documentId: string; at: string }
  | { type: "update-view"; documentId: string; viewState: DocumentViewState }
  | { type: "save-state"; documentId: string; saveState: DocumentTab["saveState"] }
  | { type: "rename"; documentId: string; name: string }
  | { type: "close"; documentId: string; discardDirty?: boolean };

export const emptySession = (): AppSession => ({ schemaVersion: 1, openDocuments: [], active: { surface: "home" } });

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") && new Set(value).size === value.length;
}

function validViewState(value: unknown, kind: DocumentRecord["kind"]): value is DocumentViewState {
  if (!value || typeof value !== "object") return false;
  const view = value as Record<string, unknown>;
  const viewport = view.viewport as Record<string, unknown> | undefined;
  if (view.kind !== kind || !viewport || ![viewport.x, viewport.y, viewport.zoom].every((item) => typeof item === "number" && Number.isFinite(item)) || (viewport.zoom as number) <= 0) return false;
  if (kind === "flow") return isStringArray(view.selectedNodeIds) && isStringArray(view.selectedEdgeIds) && (view.focusedNodeId === undefined || typeof view.focusedNodeId === "string");
  return isStringArray(view.selectedBoardIds) && isStringArray(view.selectedObjectIds) && (view.focusedObjectId === undefined || typeof view.focusedObjectId === "string");
}

function activate(session: AppSession, documentId: string, at: string): AppSession {
  if (!session.openDocuments.some((tab) => tab.documentId === documentId)) return session;
  return {
    ...session,
    active: { surface: "document", documentId },
    openDocuments: session.openDocuments.map((tab) => tab.documentId === documentId ? { ...tab, lastActiveAt: at } : tab),
  };
}

export function reduceSession(session: AppSession, action: SessionAction): AppSession {
  if (action.type === "show-home") return { ...session, active: { surface: "home" } };
  if (action.type === "open") {
    const existing = session.openDocuments.find((tab) => tab.documentId === action.document.id);
    if (existing && existing.kind !== action.document.kind) throw new Error("Dokument und Tab besitzen unterschiedliche Typen.");
    const openDocuments = existing ? session.openDocuments : [...session.openDocuments, {
      documentId: action.document.id,
      kind: action.document.kind,
      name: action.document.name,
      saveState: "saved" as const,
      viewState: emptyViewState(action.document.kind),
      lastActiveAt: action.at,
    }];
    return activate({ ...session, openDocuments }, action.document.id, action.at);
  }
  if (action.type === "activate") return activate(session, action.documentId, action.at);
  if (action.type === "update-view") return {
    ...session,
    openDocuments: session.openDocuments.map((tab) => {
      if (tab.documentId !== action.documentId) return tab;
      if (tab.kind !== action.viewState.kind || !validViewState(action.viewState, tab.kind)) throw new Error("Der Ansichtszustand passt nicht zum Dokumenttyp.");
      return { ...tab, viewState: action.viewState };
    }),
  };
  if (action.type === "save-state") return { ...session, openDocuments: session.openDocuments.map((tab) => tab.documentId === action.documentId ? { ...tab, saveState: action.saveState } : tab) };
  if (action.type === "rename") return { ...session, openDocuments: session.openDocuments.map((tab) => tab.documentId === action.documentId ? { ...tab, name: action.name } : tab) };
  const closing = session.openDocuments.find((tab) => tab.documentId === action.documentId);
  if (!closing) return session;
  if (closing.saveState === "saving") return session;
  if ((closing.saveState === "dirty" || closing.saveState === "error" || closing.saveState === "recovery-required") && !action.discardDirty) return session;
  const closingIndex = session.openDocuments.findIndex((tab) => tab.documentId === action.documentId);
  const openDocuments = session.openDocuments.filter((tab) => tab.documentId !== action.documentId);
  if (session.active.surface !== "document" || session.active.documentId !== action.documentId) return { ...session, openDocuments };
  const next = openDocuments[Math.min(closingIndex, openDocuments.length - 1)];
  return { ...session, openDocuments, active: next ? { surface: "document", documentId: next.documentId } : { surface: "home" } };
}

export function restoreSession(value: unknown, catalog: readonly DocumentRecord[]): { session: AppSession; skippedDocumentIds: string[] } {
  if (!value || typeof value !== "object") return { session: emptySession(), skippedDocumentIds: [] };
  const candidate = value as Partial<AppSession>;
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.openDocuments)) return { session: emptySession(), skippedDocumentIds: [] };
  const catalogById = new Map(catalog.map((document) => [document.id, document]));
  const seen = new Set<string>();
  const skippedDocumentIds: string[] = [];
  const valid: DocumentTab[] = [];
  for (const raw of candidate.openDocuments) {
    if (!raw || typeof raw !== "object" || typeof raw.documentId !== "string" || seen.has(raw.documentId)) continue;
    seen.add(raw.documentId);
    const document = catalogById.get(raw.documentId);
    if (!document || document.health.state !== "healthy" || raw.kind !== document.kind || !validViewState(raw.viewState, document.kind) || typeof raw.lastActiveAt !== "string" || !Number.isFinite(Date.parse(raw.lastActiveAt))) {
      skippedDocumentIds.push(raw.documentId);
      continue;
    }
    const saveState = raw.saveState === "saved" ? "saved" : "recovery-required";
    valid.push({ ...raw, name: document.name, saveState });
  }
  const retainedIds = new Set(valid.slice().sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt)).slice(0, MAX_RESTORED_DOCUMENT_TABS).map((tab) => tab.documentId));
  const openDocuments = valid.filter((tab) => retainedIds.has(tab.documentId));
  const requested = candidate.active?.surface === "document" ? candidate.active.documentId : undefined;
  const active = requested && openDocuments.some((tab) => tab.documentId === requested) ? { surface: "document" as const, documentId: requested } : { surface: "home" as const };
  return { session: { schemaVersion: 1, openDocuments, active }, skippedDocumentIds };
}
