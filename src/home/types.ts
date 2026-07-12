export type DocumentKind = "flow" | "artboard";

export type DocumentHealth =
  | { state: "healthy" }
  | { state: "corrupt"; reason: string }
  | { state: "unsupported"; foundVersion: number };

export type DocumentCover = {
  blobHash: string;
  contentFingerprint: string;
  width: number;
  height: number;
  mediaType: "image/webp" | "image/png" | "image/svg+xml";
  generatedAt: string;
};

export type DocumentRecord = {
  id: string;
  kind: DocumentKind;
  schemaVersion: 1;
  name: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
  revision: number;
  contentFingerprint: string;
  cover?: DocumentCover;
  health: DocumentHealth;
};

export type DocumentSaveState = "saved" | "dirty" | "saving" | "error" | "recovery-required";

export type FlowViewState = {
  kind: "flow";
  viewport: { x: number; y: number; zoom: number };
  selectedNodeIds: string[];
  selectedEdgeIds: string[];
  focusedNodeId?: string;
};

export type ArtboardViewState = {
  kind: "artboard";
  viewport: { x: number; y: number; zoom: number };
  selectedBoardIds: string[];
  selectedObjectIds: string[];
  focusedObjectId?: string;
};

export type DocumentViewState = FlowViewState | ArtboardViewState;

export type DocumentTab = {
  documentId: string;
  kind: DocumentKind;
  name: string;
  saveState: DocumentSaveState;
  viewState: DocumentViewState;
  lastActiveAt: string;
};

export type AppSession = {
  schemaVersion: 1;
  openDocuments: DocumentTab[];
  active: { surface: "home" } | { surface: "document"; documentId: string };
};

export type ArtboardReferenceImpact = {
  workspaceId: string;
  referencingFlowIds: string[];
};

export function emptyViewState(kind: DocumentKind): DocumentViewState {
  return kind === "flow"
    ? { kind, viewport: { x: 0, y: 0, zoom: 1 }, selectedNodeIds: [], selectedEdgeIds: [] }
    : { kind, viewport: { x: 0, y: 0, zoom: 1 }, selectedBoardIds: [], selectedObjectIds: [] };
}

export function hasCurrentCover(document: DocumentRecord): boolean {
  return document.cover?.contentFingerprint === document.contentFingerprint;
}
