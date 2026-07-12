import { invoke } from "@tauri-apps/api/core";

export type DocumentKind = "flow" | "artboard";
export type DocumentHealth = "healthy" | "recovered" | "corrupt" | "unsupported";

export type DocumentCatalogRecord = {
  id: string;
  kind: DocumentKind;
  name?: string;
  createdAt?: string;
  updatedAt?: string;
  lastOpenedAt?: string;
  revision?: number;
  fingerprint?: string;
  health: DocumentHealth;
  cover?: { blobHash: string; contentFingerprint: string; width: number; height: number; mediaType: "image/png" | "image/svg+xml"; generatedAt: string };
};

export type DocumentReference = {
  flowId: string;
  flowName: string;
  nodeId: string;
};

export type DeleteDocumentResult = {
  deleted: boolean;
  requiresConfirmation: boolean;
  references: DocumentReference[];
  confirmationFingerprint?: string;
};

const isDesktop = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function requireDesktop(): void {
  if (!isDesktop()) {
    throw new Error("Der Dokumentkatalog ist nur in der FlowZ-Desktop-App verfügbar.");
  }
}

export async function listDocuments(): Promise<DocumentCatalogRecord[]> {
  if (!isDesktop()) return [];
  return invoke<DocumentCatalogRecord[]>("document_catalog_list");
}

export type FlowCoverSource = import("./flow-cover").FlowCoverInput;
export async function flowCoverSource(documentId: string, expectedRevision: number, contentFingerprint: string): Promise<FlowCoverSource> {
  requireDesktop();
  return invoke("document_flow_cover_source", { documentId, expectedRevision, contentFingerprint });
}

export async function commitDocumentCover(request: { documentId: string; kind: DocumentKind; expectedRevision: number; contentFingerprint: string; width: number; height: number; mediaType: "image/png" | "image/svg+xml"; bytes: number[] }): Promise<NonNullable<DocumentCatalogRecord["cover"]>> {
  requireDesktop();
  return invoke("document_cover_commit", { request });
}

export async function createDocument(
  kind: DocumentKind,
  name: string,
  operationId?: string,
): Promise<DocumentCatalogRecord> {
  requireDesktop();
  return invoke("document_catalog_create", { request: { kind, name, operationId } });
}

export async function renameDocument(
  record: Pick<DocumentCatalogRecord, "id" | "kind" | "revision">,
  name: string,
): Promise<DocumentCatalogRecord> {
  requireDesktop();
  if (record.revision === undefined) throw new Error("Das beschädigte Dokument kann nicht umbenannt werden.");
  return invoke("document_catalog_rename", {
    request: { id: record.id, kind: record.kind, name, expectedRevision: record.revision },
  });
}

export async function duplicateDocument(
  record: Pick<DocumentCatalogRecord, "id" | "kind" | "revision">,
  name?: string,
  operationId?: string,
): Promise<DocumentCatalogRecord> {
  requireDesktop();
  if (record.revision === undefined) throw new Error("Das beschädigte Dokument kann nicht dupliziert werden.");
  return invoke("document_catalog_duplicate", {
    request: { id: record.id, kind: record.kind, name, operationId, expectedRevision: record.revision },
  });
}

export async function deleteDocument(
  record: Pick<DocumentCatalogRecord, "id" | "kind" | "revision">,
  confirmationFingerprint?: string,
): Promise<DeleteDocumentResult> {
  requireDesktop();
  if (record.revision === undefined) throw new Error("Das beschädigte Dokument kann nicht regulär gelöscht werden.");
  return invoke("document_catalog_delete", {
    request: {
      id: record.id,
      kind: record.kind,
      expectedRevision: record.revision,
      confirmationFingerprint,
    },
  });
}
