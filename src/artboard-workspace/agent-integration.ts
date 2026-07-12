import type { ArtboardAgentContextProvider, RevisionBoundArtboardAgentContext } from "../artboard-agent";
import type { ArtboardAgentSelection } from "../artboard-agent-ui";
import type { OpenArtboardDocument } from "./repository";
import type { ArtboardOperationBatch } from "./types";

const clone = <T,>(value: T): T => structuredClone(value);

/**
 * Exposes only the authoritative persisted head to agent tools. Optimistic
 * workspace edits never masquerade as a persisted revision.
 */
export class SurfaceArtboardAgentContextProvider implements ArtboardAgentContextProvider {
  private pinned?: { workspaceId: string; branchId: string; revisionId: string; revisionNumber: number };
  constructor(
    private readonly getOpened: () => OpenArtboardDocument | undefined,
    private readonly getSelection: () => ArtboardAgentSelection,
  ) {}

  pinRevision(opened: OpenArtboardDocument) {
    this.pinned = {
      workspaceId: opened.revision.workspace.id,
      branchId: opened.branch.id,
      revisionId: opened.revision.id,
      revisionNumber: opened.revision.revisionNumber,
    };
  }

  async getContext(request: {
    workspaceId: string;
    branchId: string;
    expectedRevisionId?: string;
    expectedRevisionNumber?: number;
  }): Promise<RevisionBoundArtboardAgentContext> {
    const opened = this.getOpened();
    if (!opened) throw new Error("Der Artboard-Workspace ist nicht mehr geöffnet.");
    const workspace = opened.revision.workspace;
    if (workspace.id !== request.workspaceId || opened.branch.id !== request.branchId) {
      throw new Error("Der angeforderte Artboard-Kontext gehört nicht zum geöffneten Dokument.");
    }
    const pinned = this.pinned?.workspaceId === request.workspaceId && this.pinned.branchId === request.branchId ? this.pinned : undefined;
    const expectedRevisionId = request.expectedRevisionId ?? pinned?.revisionId;
    const expectedRevisionNumber = request.expectedRevisionNumber ?? pinned?.revisionNumber;
    if (expectedRevisionId !== undefined && opened.revision.id !== expectedRevisionId
      || expectedRevisionNumber !== undefined && opened.revision.revisionNumber !== expectedRevisionNumber) {
      throw new Error("Das Artboard wurde seit diesem Agentenlauf geändert. Die exakte Revision ist nicht mehr aktuell.");
    }
    return {
      workspace: clone(workspace),
      branchId: opened.branch.id,
      revision: { id: opened.revision.id, number: opened.revision.revisionNumber },
      selection: clone(this.getSelection()),
    };
  }
}

export function selectionForWorkspace(opened: OpenArtboardDocument, selection: ArtboardAgentSelection): ArtboardAgentSelection {
  const workspace = opened.revision.workspace;
  const activeBoardId = workspace.boards[selection.activeBoardId] ? selection.activeBoardId : workspace.activeBoardId;
  const boardIds = selection.boardIds.filter((id) => Boolean(workspace.boards[id]));
  const layerIds = selection.layerIds.filter((id) => Object.values(workspace.boards).some((board) => Boolean(board.document.layers[id])));
  return { activeBoardId, boardIds: boardIds.length ? [...new Set(boardIds)] : [activeBoardId], layerIds: [...new Set(layerIds)] };
}

export function assertAgentBatchMatchesHead(opened: OpenArtboardDocument, batch: ArtboardOperationBatch) {
  if (batch.expectedRevisionId !== opened.revision.id
    || batch.expectedRevisionNumber !== opened.revision.revisionNumber) {
    throw new Error("Das Artboard wurde seit diesem Vorschlag geändert. Bitte den Vorschlag neu erstellen.");
  }
  if (!batch.operations.length) throw new Error("Der Agentenvorschlag enthält keine anwendbaren Änderungen.");
}
