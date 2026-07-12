import type { ProjectSummary } from "../persistence/projects";
import { emptySession, MAX_RESTORED_DOCUMENT_TABS, restoreSession } from "./session";
import { type AppSession, type DocumentRecord, type DocumentSaveState, type DocumentTab } from "./types";

export const HOME_SESSION_STORAGE_KEY = "flowz.app-session.v1";
export const MAX_SESSION_BYTES = 96 * 1024;

export function flowSummaryToDocument(summary: ProjectSummary): DocumentRecord {
  const timestamp = summary.updatedAt && Number.isFinite(Date.parse(summary.updatedAt)) ? summary.updatedAt : "1970-01-01T00:00:00.000Z";
  const revision = Number.isSafeInteger(summary.revision) && (summary.revision ?? 0) > 0 ? summary.revision! : 1;
  const reportedVersion = Number(summary.message?.match(/version\D*(\d+)/i)?.[1] ?? 0);
  const health: DocumentRecord["health"] = summary.diagnosis === "corrupt"
    ? { state: "corrupt", reason: summary.message ?? "Das Flow-Dokument ist beschädigt." }
    : summary.diagnosis === "unsupported"
      ? { state: "unsupported", foundVersion: Number.isSafeInteger(reportedVersion) ? reportedVersion : 0 }
      : { state: "healthy" };
  return {
    id: summary.id,
    kind: "flow",
    schemaVersion: 1,
    name: summary.name?.trim() || "Unbenannter Flow",
    createdAt: timestamp,
    updatedAt: timestamp,
    lastOpenedAt: undefined,
    revision,
    contentFingerprint: `flow:${summary.id}:${revision}:${timestamp}`,
    health,
  };
}

export function saveStateForFlowStore(state: "idle" | "dirty" | "saving" | "saved" | "conflict" | "error" | "offline"): DocumentSaveState {
  if (state === "dirty") return "dirty";
  if (state === "saving") return "saving";
  if (state === "conflict" || state === "error") return "error";
  return "saved";
}

export function boundedSession(session: AppSession): AppSession {
  if (session.openDocuments.length <= MAX_RESTORED_DOCUMENT_TABS) return session;
  const retained = session.openDocuments.slice(-MAX_RESTORED_DOCUMENT_TABS);
  const retainedIds = new Set(retained.map((tab) => tab.documentId));
  const active = session.active.surface === "document" && retainedIds.has(session.active.documentId) ? session.active : { surface: "home" as const };
  return { ...session, openDocuments: retained, active };
}

export function loadStoredSession(storage: Pick<Storage, "getItem"> | undefined, catalog: readonly DocumentRecord[]): AppSession {
  if (!storage) return emptySession();
  try {
    const raw = storage.getItem(HOME_SESSION_STORAGE_KEY);
    if (!raw || raw.length > MAX_SESSION_BYTES) return emptySession();
    const restored = restoreSession(JSON.parse(raw), catalog).session;
    return { ...restored, active: { surface: "home" } };
  } catch {
    return emptySession();
  }
}

export function persistStoredSession(storage: Pick<Storage, "setItem"> | undefined, session: AppSession): boolean {
  if (!storage) return false;
  try {
    const payload = JSON.stringify(boundedSession(session));
    if (payload.length > MAX_SESSION_BYTES) return false;
    // One bounded setItem is the atomic unit exposed by Web Storage. There is no
    // partially visible session and the previous value survives a failed write.
    storage.setItem(HOME_SESSION_STORAGE_KEY, payload);
    return true;
  } catch {
    return false;
  }
}

export type AppShortcut =
  | { type: "activate-home" }
  | { type: "activate-tab"; index: number }
  | { type: "cycle-tabs"; direction: 1 | -1 }
  | { type: "close-active" }
  | { type: "new-flow" };

export function appShortcut(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">): AppShortcut | undefined {
  if (event.altKey) return;
  const key = event.key.toLowerCase();
  if (event.metaKey && !event.ctrlKey && key === "1") return { type: "activate-home" };
  if (event.metaKey && !event.ctrlKey && /^[2-9]$/.test(key)) return { type: "activate-tab", index: Number(key) - 2 };
  if (event.ctrlKey && !event.metaKey && key === "tab") return { type: "cycle-tabs", direction: event.shiftKey ? -1 : 1 };
  if (event.metaKey && !event.ctrlKey && key === "w") return { type: "close-active" };
  if (event.metaKey && !event.ctrlKey && key === "n") return { type: "new-flow" };
  return;
}

export function cycledTarget(session: AppSession, direction: 1 | -1): AppSession["active"] {
  const targets: AppSession["active"][] = [{ surface: "home" }, ...session.openDocuments.map((tab) => ({ surface: "document" as const, documentId: tab.documentId }))];
  const activeDocumentId = session.active.surface === "document" ? session.active.documentId : undefined;
  const current = activeDocumentId === undefined ? 0 : targets.findIndex((target) => target.surface === "document" && target.documentId === activeDocumentId);
  return targets[((current < 0 ? 0 : current) + direction + targets.length) % targets.length];
}

export function tabForActive(session: AppSession): DocumentTab | undefined {
  const activeDocumentId = session.active.surface === "document" ? session.active.documentId : undefined;
  return activeDocumentId === undefined ? undefined : session.openDocuments.find((tab) => tab.documentId === activeDocumentId);
}

/** Returns zero or one heavy Flow workspace identity; inactive tabs are descriptors only. */
export function activeFlowWorkspaceId(session: AppSession): string | undefined {
  const active = tabForActive(session);
  return active?.kind === "flow" ? active.documentId : undefined;
}
