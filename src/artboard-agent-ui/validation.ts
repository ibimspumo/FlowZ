import type { ArtboardWorkspaceOperation } from "../artboard-workspace/types";
import { applyWorkspaceOperations } from "../artboard-workspace/repository";
import { validateArtboardWorkspace } from "../nodes/brand/artboard-domain";
import type { ArtboardAgentContext, ResolvedArtboardProposal } from "./types";

const operationTypes = new Set<ArtboardWorkspaceOperation["type"]>([
  "rename-workspace", "rename-board", "set-board-format", "set-board-paint", "move-board",
  "update-layer", "create-layer", "set-layer-tree", "delete-layers", "reorder-layer", "create-board", "delete-board", "set-board-inputs",
]);

export function proposalRevisionError(proposal: ResolvedArtboardProposal, context: ArtboardAgentContext): string | undefined {
  if (proposal.batch.expectedRevisionId !== context.revision.id || proposal.batch.expectedRevisionNumber !== context.revision.number) {
    return "Das Artboard wurde seit diesem Vorschlag geändert. Bitte den Vorschlag neu erstellen.";
  }
  return undefined;
}

export function validateResolvedProposal(value: ResolvedArtboardProposal, context: ArtboardAgentContext): ResolvedArtboardProposal {
  if (!value || typeof value !== "object") throw new Error("Der Vorschlag konnte nicht gelesen werden.");
  if (!value.proposalId || typeof value.proposalId !== "string") throw new Error("Dem Vorschlag fehlt eine gültige ID.");
  if (!value.summary || typeof value.summary !== "string" || value.summary.length > 2_000) throw new Error("Die Vorschlagszusammenfassung ist ungültig.");
  const batch = value.batch;
  if (!batch || typeof batch !== "object" || typeof batch.operationId !== "string" || !batch.operationId) throw new Error("Der Änderungssatz ist ungültig.");
  if (!Array.isArray(batch.operations) || batch.operations.length > 80) throw new Error("Der Änderungssatz enthält zu viele oder ungültige Operationen.");
  const followUps = value.followUpIntents ?? [];
  if (!batch.operations.length && !followUps.length) throw new Error("Der Vorschlag enthält weder anwendbare Änderungen noch einen getrennten Folgeauftrag.");
  if (!Array.isArray(followUps) || followUps.length > 24 || followUps.some((intent) =>
    !intent || intent.provider !== "fal.ai" || intent.requiresExplicitConfirmation !== true
    || typeof intent.id !== "string" || typeof intent.boardId !== "string"
    || typeof intent.prompt !== "string" || !intent.prompt.trim()
    || typeof intent.role !== "string" || !intent.role.trim()
    || !Array.isArray(intent.referenceBindingIds)
  )) throw new Error("Der Vorschlag enthält einen ungültigen kostenpflichtigen Folgeauftrag.");
  const revisionError = proposalRevisionError(value, context);
  if (revisionError) throw new Error(revisionError);

  const createdBoards = new Set<string>();
  const deletedBoards = new Set<string>();
  for (const operation of batch.operations as unknown[]) {
    if (!operation || typeof operation !== "object" || !("type" in operation) || typeof operation.type !== "string" || !operationTypes.has(operation.type as ArtboardWorkspaceOperation["type"])) {
      throw new Error("Der Vorschlag enthält eine unbekannte Artboard-Operation.");
    }
    const candidate = operation as ArtboardWorkspaceOperation;
    if (candidate.type === "create-board") {
      if (!candidate.board?.id || context.workspace.boards[candidate.board.id] || createdBoards.has(candidate.board.id)) throw new Error("Ein neues Artboard besitzt keine eindeutige ID.");
      createdBoards.add(candidate.board.id);
      continue;
    }
    if (candidate.type === "delete-board") {
      if (deletedBoards.has(candidate.boardId)) throw new Error("Ein Artboard kann in einem Vorschlag nur einmal entfernt werden.");
      if (!context.workspace.boards[candidate.boardId] && !createdBoards.has(candidate.boardId)) throw new Error("Der Vorschlag entfernt ein nicht vorhandenes Artboard.");
      deletedBoards.add(candidate.boardId);
      continue;
    }
    if ("boardId" in candidate && deletedBoards.has(candidate.boardId)) throw new Error("Der Vorschlag ändert ein bereits entferntes Artboard.");
    if ("boardId" in candidate && !context.workspace.boards[candidate.boardId] && !createdBoards.has(candidate.boardId)) {
      throw new Error("Der Vorschlag verweist auf ein nicht vorhandenes Artboard.");
    }
  }
  if (!Array.isArray(value.changes) || value.changes.length > 120 || value.changes.some((item) => !item || typeof item.id !== "string" || typeof item.label !== "string" || !["add", "change", "remove"].includes(item.kind))) {
    throw new Error("Die visuelle Änderungsliste ist ungültig.");
  }
  if (batch.operations.length) {
    const candidate = applyWorkspaceOperations(context.workspace, batch.operations);
    validateArtboardWorkspace(candidate);
  }
  return structuredClone(value);
}
