import type { ArtboardOperationBatch, ArtboardWorkspaceOperation } from "../artboard-workspace/types";

export type ProposalDiffItem = {
  id: string;
  label: string;
  kind: "add" | "change" | "remove";
  boardName?: string;
  before?: string;
  after?: string;
};

/** A paid follow-up which always needs a separate, visible user confirmation. */
export type ArtboardImageGenerationIntent = {
  id: string;
  provider: "fal.ai";
  boardId: string;
  prompt: string;
  role: string;
  aspectRatio: string;
  referenceBindingIds: string[];
  requiresExplicitConfirmation: true;
};

export type ResolvedArtboardProposal = {
  proposalId: string;
  summary: string;
  batch: ArtboardOperationBatch;
  changes: ProposalDiffItem[];
  warnings?: string[];
  followUpIntents?: ArtboardImageGenerationIntent[];
};

export type ProposalOperationReceipt = {
  operationId: string;
  payloadFingerprint: string;
  result: unknown;
};

export type PersistedArtboardProposal = {
  proposalId: string;
  workspaceId: string;
  branchId: string;
  expectedRevisionId: string;
  expectedRevisionNumber: number;
  state: "draft" | "frozen";
  operations: ArtboardWorkspaceOperation[];
  imageGenerationIntents: ArtboardImageGenerationIntent[];
  receipts: ProposalOperationReceipt[];
  createdAt: string;
  updatedAt: string;
  resolved?: ResolvedArtboardProposal;
};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ASPECT_RATIO = /^\d{1,2}:\d{1,2}$/;
const ALLOWED_OPERATION_TYPES = new Set([
  "rename-board", "set-board-format", "set-board-paint", "update-layer",
  "set-layer-tree", "delete-layers", "reorder-layer", "create-board", "delete-board",
]);

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
};

function exactObject(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} ist ungültig.`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw new Error(`${label} enthält unbekannte Felder.`);
  return record;
}

function validId(value: unknown): value is string { return typeof value === "string" && ID.test(value); }
function boundedJson(value: unknown, max: number, label: string) {
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { throw new Error(`${label} ist nicht serialisierbar.`); }
  if (new TextEncoder().encode(serialized).byteLength > max) throw new Error(`${label} ist zu groß.`);
}

function validateIntent(value: unknown) {
  const intent = exactObject(value, ["id", "provider", "boardId", "prompt", "role", "aspectRatio", "referenceBindingIds", "requiresExplicitConfirmation"], "Bildgenerierungsabsicht");
  if (!validId(intent.id) || intent.provider !== "fal.ai" || !validId(intent.boardId)
    || typeof intent.prompt !== "string" || intent.prompt.length < 1 || intent.prompt.length > 8_000
    || typeof intent.role !== "string" || intent.role.length < 1 || intent.role.length > 80
    || typeof intent.aspectRatio !== "string" || !ASPECT_RATIO.test(intent.aspectRatio)
    || !Array.isArray(intent.referenceBindingIds) || intent.referenceBindingIds.length > 20
    || intent.referenceBindingIds.some((id) => !validId(id)) || new Set(intent.referenceBindingIds).size !== intent.referenceBindingIds.length
    || intent.requiresExplicitConfirmation !== true) throw new Error("Persistierter Artboard-Vorschlag enthält eine ungültige Bildgenerierungsabsicht.");
}

function validateOperation(value: unknown) {
  const operation = exactObject(value, ["type", "boardId", "name", "format", "color", "layerId", "patch", "layers", "rootLayerIds", "layerIds", "direction", "board", "placement"], "Artboard-Operation");
  if (typeof operation.type !== "string" || !ALLOWED_OPERATION_TYPES.has(operation.type)) throw new Error("Persistierter Artboard-Vorschlag enthält eine nicht freigegebene Operation.");
  if(operation.type==="create-board") { const board=exactObject(operation.board,["id","name","activeRevisionId","document","inputSnapshot","ancestry","createdAt"],"Vorschlags-Board");const placement=exactObject(operation.placement,["x","y"],"Vorschlags-Platzierung");if(!validId(board.id)||typeof placement.x!=="number"||!Number.isFinite(placement.x)||typeof placement.y!=="number"||!Number.isFinite(placement.y))throw new Error("Persistierter Artboard-Vorschlag enthält ein ungültiges neues Board."); }
  else if(!validId(operation.boardId))throw new Error("Persistierter Artboard-Vorschlag enthält eine Operation ohne Board-ID.");
  boundedJson(operation, 256 * 1024, "Artboard-Operation");
}

export function validatePersistedArtboardProposal(value: unknown): asserts value is PersistedArtboardProposal {
  const proposal = exactObject(value, ["proposalId", "workspaceId", "branchId", "expectedRevisionId", "expectedRevisionNumber", "state", "operations", "imageGenerationIntents", "receipts", "createdAt", "updatedAt", "resolved"], "Persistierter Artboard-Vorschlag") as Partial<PersistedArtboardProposal>;
  boundedJson(value, 512 * 1024, "Persistierter Artboard-Vorschlag");
  if (![proposal.proposalId, proposal.workspaceId, proposal.branchId, proposal.expectedRevisionId].every((item) => typeof item === "string" && ID.test(item))
    || !Number.isInteger(proposal.expectedRevisionNumber) || proposal.expectedRevisionNumber! < 0
    || !["draft", "frozen"].includes(String(proposal.state))
    || !Array.isArray(proposal.operations) || proposal.operations.length > 80
    || !Array.isArray(proposal.imageGenerationIntents) || proposal.imageGenerationIntents.length > 24
    || !Array.isArray(proposal.receipts) || proposal.receipts.length > 96
    || typeof proposal.createdAt !== "string" || !Number.isFinite(Date.parse(proposal.createdAt))
    || typeof proposal.updatedAt !== "string" || !Number.isFinite(Date.parse(proposal.updatedAt))
    || Date.parse(proposal.updatedAt) < Date.parse(proposal.createdAt)
    || proposal.state === "draft" && proposal.resolved !== undefined
    || proposal.state === "frozen" && (!proposal.resolved || proposal.resolved.proposalId !== proposal.proposalId)) throw new Error("Persistierter Artboard-Vorschlag ist beschädigt oder überschreitet sein Budget.");
  proposal.operations.forEach(validateOperation);
  proposal.imageGenerationIntents.forEach(validateIntent);
  const receiptIds = new Set<string>();
  for (const receipt of proposal.receipts) {
    exactObject(receipt, ["operationId", "payloadFingerprint", "result"], "Operationsbeleg");
    if (!receipt || typeof receipt.operationId !== "string" || !ID.test(receipt.operationId) || typeof receipt.payloadFingerprint !== "string" || receipt.payloadFingerprint.length > 64 * 1024 || receiptIds.has(receipt.operationId)) throw new Error("Persistierter Artboard-Vorschlag enthält ungültige Operationsbelege.");
    boundedJson(receipt.result, 64 * 1024, "Operationsergebnis");
    receiptIds.add(receipt.operationId);
  }
  if (proposal.state === "frozen") {
    const resolved = exactObject(proposal.resolved, ["proposalId", "summary", "batch", "changes", "warnings", "followUpIntents"], "Aufgelöster Artboard-Vorschlag");
    const batch = exactObject(resolved.batch, ["operationId", "expectedRevisionId", "expectedRevisionNumber", "operations"], "Proposal-Batch");
    if (!validId(resolved.proposalId) || resolved.proposalId !== proposal.proposalId
      || typeof resolved.summary !== "string" || resolved.summary.length > 2_000
      || !validId(batch.operationId) || batch.expectedRevisionId !== proposal.expectedRevisionId || batch.expectedRevisionNumber !== proposal.expectedRevisionNumber
      || canonical(batch.operations) !== canonical(proposal.operations)
      || !Array.isArray(resolved.changes) || resolved.changes.length > 120
      || resolved.warnings !== undefined && (!Array.isArray(resolved.warnings) || resolved.warnings.length > 24 || resolved.warnings.some((item) => typeof item !== "string" || item.length > 500))
      || canonical(resolved.followUpIntents ?? []) !== canonical(proposal.imageGenerationIntents)) throw new Error("Aufgelöster Artboard-Vorschlag stimmt nicht mit seinem unveränderlichen Entwurf überein.");
  }
}

/** Enforces append-only drafts and immutable frozen proposals across windows/process restarts. */
export function assertProposalTransition(previous: PersistedArtboardProposal, next: PersistedArtboardProposal) {
  validatePersistedArtboardProposal(previous); validatePersistedArtboardProposal(next);
  if (canonical(previous) === canonical(next)) return;
  if (previous.state === "frozen") throw new Error("Ein abgeschlossener Artboard-Vorschlag ist unveränderlich.");
  if (previous.proposalId !== next.proposalId || previous.workspaceId !== next.workspaceId || previous.branchId !== next.branchId
    || previous.expectedRevisionId !== next.expectedRevisionId || previous.expectedRevisionNumber !== next.expectedRevisionNumber || previous.createdAt !== next.createdAt
    || next.operations.length < previous.operations.length || canonical(next.operations.slice(0, previous.operations.length)) !== canonical(previous.operations)
    || next.imageGenerationIntents.length < previous.imageGenerationIntents.length || canonical(next.imageGenerationIntents.slice(0, previous.imageGenerationIntents.length)) !== canonical(previous.imageGenerationIntents)
    || next.receipts.length !== previous.receipts.length + 1 || canonical(next.receipts.slice(0, previous.receipts.length)) !== canonical(previous.receipts)
    || Date.parse(next.updatedAt) < Date.parse(previous.updatedAt)) throw new Error("Der Artboard-Vorschlag kollidiert mit einer neueren persistenten Version.");
}
