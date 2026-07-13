import type { DocumentCatalogRecord, DocumentReference } from "./catalog-api";
import type { AppSession, DocumentRecord } from "./types";

export type DocumentAction =
  | { kind: "rename"; document: DocumentRecord; name: string }
  | { kind: "duplicate"; document: DocumentRecord; name: string; operationId: string }
  | { kind: "delete"; document: DocumentRecord; references: readonly DocumentReference[]; confirmationFingerprint?: string };

const validTimestamp = (value?: string): string | undefined => value && Number.isFinite(Date.parse(value)) ? value : undefined;

export function catalogRecordToDocument(record: DocumentCatalogRecord): DocumentRecord {
  const updatedAt = validTimestamp(record.updatedAt) ?? validTimestamp(record.createdAt) ?? "1970-01-01T00:00:00.000Z";
  const createdAt = validTimestamp(record.createdAt) ?? updatedAt;
  const revision = record.revision && record.revision > 0 ? record.revision : 1;
  const fallbackName = record.kind === "flow" ? "Unbenannter Flow" : "Unbenanntes Artboard";
  const fingerprint = record.coverFingerprint ?? record.fingerprint ?? `${record.kind}:${record.id}:${revision}:${updatedAt}`;
  const cover = record.cover && /^[a-f0-9]{64}$/.test(record.cover.blobHash)
    && record.cover.contentFingerprint === fingerprint && Number.isInteger(record.cover.width) && record.cover.width > 0 && record.cover.width <= 512
    && Number.isInteger(record.cover.height) && record.cover.height > 0 && record.cover.height <= 512
    && record.cover.mediaType === "image/png"
    && Number.isFinite(Date.parse(record.cover.generatedAt)) ? record.cover : undefined;
  return {
    id: record.id, kind: record.kind, schemaVersion: 1,
    name: record.name?.trim() || fallbackName,
    createdAt, updatedAt, lastOpenedAt: validTimestamp(record.lastOpenedAt), revision,
    contentFingerprint: fingerprint, cover,
    health: record.health === "unsupported"
      ? { state: "unsupported", foundVersion: 0 }
      : record.health === "corrupt"
        ? { state: "corrupt", reason: `Das ${record.kind === "flow" ? "Flow" : "Artboard"}-Dokument ist beschädigt.` }
        : { state: "healthy" },
  };
}

export function replaceDocumentEverywhere(catalog: readonly DocumentRecord[], session: AppSession, document: DocumentRecord): { catalog: DocumentRecord[]; session: AppSession } {
  const exists = catalog.some((item) => item.id === document.id);
  return {
    catalog: exists ? catalog.map((item) => item.id === document.id ? document : item) : [...catalog, document],
    session: { ...session, openDocuments: session.openDocuments.map((tab) => tab.documentId === document.id ? { ...tab, kind: document.kind, name: document.name, saveState: "saved" } : tab) },
  };
}

export function removeDocumentEverywhere(catalog: readonly DocumentRecord[], session: AppSession, documentId: string): { catalog: DocumentRecord[]; session: AppSession } {
  const closingIndex = session.openDocuments.findIndex((tab) => tab.documentId === documentId);
  const openDocuments = session.openDocuments.filter((tab) => tab.documentId !== documentId);
  const nextIndex = Math.min(Math.max(closingIndex, 0), openDocuments.length - 1);
  const active = session.active.surface === "document" && session.active.documentId === documentId
    ? (openDocuments[nextIndex] ? { surface: "document" as const, documentId: openDocuments[nextIndex].documentId } : { surface: "home" as const })
    : session.active;
  return { catalog: catalog.filter((item) => item.id !== documentId), session: { ...session, openDocuments, active } };
}

export function reconcileSessionWithCatalog(session: AppSession, catalog: readonly DocumentRecord[]): AppSession {
  const records = new Map(catalog.map((document) => [document.id, document]));
  const openDocuments = session.openDocuments
    .filter((tab) => records.get(tab.documentId)?.kind === tab.kind)
    .map((tab) => ({ ...tab, name: records.get(tab.documentId)?.name ?? tab.name }));
  const activeDocumentId = session.active.surface === "document" ? session.active.documentId : undefined;
  const active = activeDocumentId && !openDocuments.some((tab) => tab.documentId === activeDocumentId)
    ? { surface: "home" as const }
    : session.active;
  return { ...session, openDocuments, active };
}

export function validateDocumentName(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return "Gib dem Dokument einen Namen.";
  if ([...trimmed].length > 160) return "Der Name darf höchstens 160 Zeichen enthalten.";
  if ([...trimmed].some((character) => /\p{Cc}/u.test(character))) return "Der Name enthält ein nicht unterstütztes Steuerzeichen.";
  return;
}

export function newOperationId(): string { return crypto.randomUUID(); }

/** Preserve idempotency only while the duplicate request payload is unchanged. */
export function operationIdForDuplicateAttempt(
  previous: { operationId: string; name: string; revision: number },
  next: { name: string; revision: number },
  create: () => string = newOperationId,
): string {
  return previous.name === next.name && previous.revision === next.revision ? previous.operationId : create();
}
