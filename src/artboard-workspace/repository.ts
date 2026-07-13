import {
  applyArtboardOperations,
  moveArtboardHead,
  openArtboardRevision,
  openArtboardWorkspace,
  type ArtboardBranchRecord,
  type ArtboardRevisionRecord,
  type ArtboardWorkspaceRecord,
} from "../api";
import {
  createDocument as createCatalogDocument,
  listDocuments,
  type DocumentCatalogRecord,
} from "../home/catalog-api";
import type { DocumentRecord } from "../home/types";
import {
  ARTBOARD_DOCUMENT_VERSION,
  ARTBOARD_FORMATS,
  findBoardPlacement,
  validateArtboardWorkspace,
  type ArtboardBoard,
  type ArtboardInputSnapshot,
  type ArtboardPreset,
  type ArtboardWorkspace as Workspace,
} from "../nodes/brand/artboard-domain";
import type { ArtboardOperationBatch, ArtboardWorkspaceOperation } from "./types";

export type OpenArtboardDocument = {
  record: ArtboardWorkspaceRecord;
  branch: ArtboardBranchRecord;
  revision: ArtboardRevisionRecord;
};

export interface ArtboardDocumentRepository {
  list(): Promise<readonly DocumentRecord[]>;
  create(name: string): Promise<DocumentRecord>;
  open(id: string): Promise<OpenArtboardDocument | undefined>;
  apply(opened: OpenArtboardDocument, batch: ArtboardOperationBatch): Promise<OpenArtboardDocument>;
  undo(opened: OpenArtboardDocument): Promise<OpenArtboardDocument>;
  redo(opened: OpenArtboardDocument): Promise<OpenArtboardDocument>;
}

const timestamp = (value?: string) => value && Number.isFinite(Date.parse(value)) ? value : "1970-01-01T00:00:00.000Z";

export function catalogArtboardRecord(record: DocumentCatalogRecord): DocumentRecord {
  const updatedAt = timestamp(record.updatedAt ?? record.createdAt);
  const revision = record.revision && record.revision > 0 ? record.revision : 1;
  return {
    id: record.id,
    kind: "artboard",
    schemaVersion: 1,
    name: record.name?.trim() || "Unbenanntes Artboard",
    createdAt: timestamp(record.createdAt ?? record.updatedAt),
    updatedAt,
    lastOpenedAt: record.lastOpenedAt,
    revision,
    contentFingerprint: record.fingerprint ?? `artboard:${record.id}:${revision}:${updatedAt}`,
    health: record.health === "unsupported"
      ? { state: "unsupported", foundVersion: 0 }
      : record.health === "corrupt"
        ? { state: "corrupt", reason: "Das Artboard-Dokument ist beschädigt." }
        : { state: "healthy" },
  };
}

const clone = <T,>(value: T): T => structuredClone(value);

function changedBoardIds(before: Workspace, after: Workspace): string[] {
  const ids = new Set([...Object.keys(before.boards), ...Object.keys(after.boards)]);
  return [...ids].filter((id) => JSON.stringify(before.boards[id]) !== JSON.stringify(after.boards[id]));
}

export function applyWorkspaceOperations(workspace: Workspace, operations: readonly ArtboardWorkspaceOperation[]): Workspace {
  const next = clone(workspace);
  for (const operation of operations) {
    if (operation.type === "rename-workspace") next.name = operation.name.trim();
    else if (operation.type === "rename-board") {
      const board = next.boards[operation.boardId]; if (board) { board.name = operation.name; board.document.name = operation.name; }
    } else if (operation.type === "set-board-format") {
      const board = next.boards[operation.boardId]; if (board) {
        board.document.format = clone(operation.format);
        for (const layer of Object.values(board.document.layers)) {
          layer.geometry.width = Math.min(layer.geometry.width, operation.format.width);
          layer.geometry.height = Math.min(layer.geometry.height, operation.format.height);
          layer.geometry.x = Math.max(0, Math.min(layer.geometry.x, operation.format.width - layer.geometry.width));
          layer.geometry.y = Math.max(0, Math.min(layer.geometry.y, operation.format.height - layer.geometry.height));
        }
      }
    } else if (operation.type === "set-board-paint") {
      const board = next.boards[operation.boardId]; if (board) board.document.paint = { kind: "solid", color: operation.color };
    } else if (operation.type === "move-board") {
      if (next.placements[operation.boardId]) next.placements[operation.boardId] = { x: operation.x, y: operation.y };
    } else if (operation.type === "update-layer") {
      const board = next.boards[operation.boardId]; const layer = board?.document.layers[operation.layerId];
      if (board && layer) board.document.layers[operation.layerId] = { ...layer, ...clone(operation.patch), id: layer.id, type: layer.type } as typeof layer;
    } else if (operation.type === "create-layer") {
      const board = next.boards[operation.boardId]; if (!board) continue;
      board.document.layers[operation.layer.id] = clone(operation.layer);
      board.document.rootLayerIds.splice(Math.max(0, Math.min(operation.rootIndex, board.document.rootLayerIds.length)), 0, operation.layer.id);
    } else if (operation.type === "set-layer-tree") {
      const board = next.boards[operation.boardId]; if (!board) continue;
      board.document.layers = clone(operation.layers); board.document.rootLayerIds = clone(operation.rootLayerIds);
    } else if (operation.type === "delete-layers") {
      const board = next.boards[operation.boardId]; if (!board) continue;
      const remove=new Set<string>();const visit=(id:string)=>{if(remove.has(id))return;remove.add(id);const layer=board.document.layers[id];if(layer?.type==="group"||layer?.type==="container")layer.childIds.forEach(visit);};operation.layerIds.forEach(visit);
      for (const id of remove) delete board.document.layers[id];
      board.document.rootLayerIds = board.document.rootLayerIds.filter((id) => !remove.has(id));
      for(const layer of Object.values(board.document.layers))if(layer.type==="group"||layer.type==="container")layer.childIds=layer.childIds.filter((id)=>!remove.has(id));
    } else if (operation.type === "reorder-layer") {
      const board = next.boards[operation.boardId]; if (!board) continue;
      const parent = Object.values(board.document.layers).find((layer) => (layer.type === "group"||layer.type==="container") && layer.childIds.includes(operation.layerId));
      const siblings = board.document.rootLayerIds.includes(operation.layerId)
        ? board.document.rootLayerIds
        : (parent?.type === "group" || parent?.type === "container") ? parent.childIds : undefined;
      if (!siblings) continue;
      const index = siblings.indexOf(operation.layerId); if (index < 0) continue;
      const target = operation.direction === "forward" ? Math.min(siblings.length - 1, index + 1) : Math.max(0, index - 1);
      const [id] = siblings.splice(index, 1); siblings.splice(target, 0, id);
    } else if (operation.type === "create-board") {
      next.boards[operation.board.id] = clone(operation.board); next.placements[operation.board.id] = clone(operation.placement);
      next.activeBoardId = operation.board.id; next.selectedBoardIds = [operation.board.id];
    } else if (operation.type === "delete-board") {
      if (!next.boards[operation.boardId]) throw new Error(`Artboard ${operation.boardId} existiert nicht.`);
      if (Object.keys(next.boards).length <= 1) throw new Error("Das letzte Artboard kann nicht entfernt werden.");
      delete next.boards[operation.boardId];
      delete next.placements[operation.boardId];
      const remaining = Object.keys(next.boards).sort((left, right) => {
        const a = next.placements[left]; const b = next.placements[right];
        return (a?.y ?? 0) - (b?.y ?? 0) || (a?.x ?? 0) - (b?.x ?? 0) || left.localeCompare(right);
      });
      if (next.activeBoardId === operation.boardId) next.activeBoardId = remaining[0];
      next.selectedBoardIds = next.selectedBoardIds.filter((id) => id !== operation.boardId);
      if (!next.selectedBoardIds.length) next.selectedBoardIds = [next.activeBoardId];
    } else if (operation.type === "set-board-inputs") {
      const board = next.boards[operation.boardId]; if (board) {
        board.inputSnapshot = clone(operation.snapshot); board.document.bindings = clone(operation.snapshot.bindings);
        const artifactRef = (role: "palette" | "fonts") => {
          const binding = Object.values(operation.snapshot.bindings).find((item) => item.id.startsWith(`${role}-`) && item.snapshot.kind === "artifact");
          return binding?.snapshot.kind === "artifact" ? { artifactId: binding.source.resultId, snapshotHash: binding.snapshot.artifactHash } : undefined;
        };
        board.document.tokenRefs = { palette: artifactRef("palette"), fonts: artifactRef("fonts") };
      }
    }
  }
  return next;
}

export function blankBoard(workspace: Workspace, preset: ArtboardPreset, sourceBoardId?: string): ArtboardBoard {
  const now = new Date().toISOString();
  const boardId = crypto.randomUUID();
  const source = workspace.boards[sourceBoardId ?? workspace.activeBoardId];
  const dimensions = ARTBOARD_FORMATS[preset];
  const format = { preset, width: dimensions.width, height: dimensions.height };
  return {
    id: boardId,
    name: ARTBOARD_FORMATS[preset].label,
    activeRevisionId: crypto.randomUUID(),
    document: { schemaVersion: ARTBOARD_DOCUMENT_VERSION, id: crypto.randomUUID(), name: ARTBOARD_FORMATS[preset].label, format, paint: { kind: "solid", color: "#FFFFFF" }, rootLayerIds: [], layers: {}, bindings: {}, tokenRefs: {} },
    inputSnapshot: { id: crypto.randomUUID(), createdAt: now, bindings: {} },
    ancestry: { branchId: source?.ancestry.branchId ?? crypto.randomUUID() },
    createdAt: now,
  };
}

export function addBlankBoard(workspace: Workspace, preset: ArtboardPreset, sourceBoardId?: string): Workspace {
  const next = clone(workspace); const board = blankBoard(workspace, preset, sourceBoardId);
  next.boards[board.id] = board;
  next.placements[board.id] = findBoardPlacement(workspace, board.document.format, sourceBoardId);
  next.activeBoardId = board.id; next.selectedBoardIds = [board.id];
  validateArtboardWorkspace(next); return next;
}

function activeSnapshot(workspace: Workspace): ArtboardInputSnapshot | undefined {
  const snapshot = workspace.boards[workspace.activeBoardId]?.inputSnapshot;
  return snapshot && Object.keys(snapshot.bindings).length ? snapshot : undefined;
}

async function openAtHead(record: ArtboardWorkspaceRecord, branch: ArtboardBranchRecord): Promise<OpenArtboardDocument> {
  const revision = await openArtboardRevision(branch.headRevisionId);
  if (!revision) throw new Error("Die aktive Artboard-Revision wurde nicht gefunden.");
  return { record, branch, revision };
}

export const desktopArtboardRepository: ArtboardDocumentRepository = {
  async list() { return (await listDocuments()).filter((record) => record.kind === "artboard").map(catalogArtboardRecord); },
  async create(name) { return catalogArtboardRecord(await createCatalogDocument("artboard", name, crypto.randomUUID())); },
  async open(id) {
    const record = await openArtboardWorkspace(id); if (!record) return;
    const branch = record.branches.find((item) => item.name === "Main") ?? record.branches[0];
    if (!branch) throw new Error("Das Artboard hat keinen bearbeitbaren Branch.");
    return openAtHead(record, branch);
  },
  async apply(opened, batch) {
    const revisionId = crypto.randomUUID();
    const workspace = applyWorkspaceOperations(opened.revision.workspace, batch.operations);
    for (const boardId of changedBoardIds(opened.revision.workspace, workspace)) if (workspace.boards[boardId]) workspace.boards[boardId].activeRevisionId = `${revisionId}:${boardId}`;
    validateArtboardWorkspace(workspace);
    const revision = await applyArtboardOperations({ workspaceId: opened.record.id, branchId: opened.branch.id, revisionId, operationId: batch.operationId, expectedRevisionId: batch.expectedRevisionId, expectedRevisionNumber: batch.expectedRevisionNumber, operations: batch.operations as unknown as Record<string, unknown>[], workspace, inputSnapshot: activeSnapshot(workspace), createdAt: new Date().toISOString() });
    return { ...opened, record: { ...opened.record, name: workspace.name, updatedAt: revision.createdAt }, branch: { ...opened.branch, headRevisionId: revision.id, redoRevisionId: undefined }, revision };
  },
  async undo(opened) {
    const target = opened.revision.parentRevisionId; if (!target) return opened;
    const branch = await moveArtboardHead({ workspaceId: opened.record.id, branchId: opened.branch.id, expectedRevisionId: opened.revision.id, targetRevisionId: target });
    return openAtHead(opened.record, branch);
  },
  async redo(opened) {
    const target = opened.branch.redoRevisionId; if (!target) return opened;
    const branch = await moveArtboardHead({ workspaceId: opened.record.id, branchId: opened.branch.id, expectedRevisionId: opened.revision.id, targetRevisionId: target });
    return openAtHead(opened.record, branch);
  },
};
