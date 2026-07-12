import type { ArtboardLayer, ArtboardWorkspace } from "../nodes/brand/artboard-domain";
import type { ArtboardOperationBatch, ArtboardWorkspaceOperation } from "./types";

let sequence = 0;

export function artboardOperationId(prefix = "manual"): string {
  sequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${sequence.toString(36)}`;
}

export function operationBatch(
  revision: { id: string; number: number },
  operations: ArtboardWorkspaceOperation[],
  prefix?: string,
): ArtboardOperationBatch {
  return {
    operationId: artboardOperationId(prefix),
    expectedRevisionId: revision.id,
    expectedRevisionNumber: revision.number,
    operations,
  };
}

export function clampLayerGeometry(
  layer: ArtboardLayer,
  patch: Partial<ArtboardLayer["geometry"]>,
  board: { width: number; height: number },
) {
  const current = layer.geometry;
  const width = Math.max(1, Math.min(board.width, patch.width ?? current.width));
  const height = Math.max(1, Math.min(board.height, patch.height ?? current.height));
  const x = Math.max(0, Math.min(board.width - width, patch.x ?? current.x));
  const y = Math.max(0, Math.min(board.height - height, patch.y ?? current.y));
  return { x, y, width, height, rotation: patch.rotation ?? current.rotation };
}

export function orderedBoardSelection(
  workspace: ArtboardWorkspace,
  boardId: string,
  additive: boolean,
): { activeBoardId: string; selectedBoardIds: string[] } {
  if (!additive) return { activeBoardId: boardId, selectedBoardIds: [boardId] };
  const current = workspace.selectedBoardIds;
  const selectedBoardIds = current.includes(boardId)
    ? current.filter((id) => id !== boardId)
    : [...current, boardId];
  return {
    activeBoardId: selectedBoardIds.includes(boardId)
      ? boardId
      : selectedBoardIds.at(-1) ?? workspace.activeBoardId,
    selectedBoardIds,
  };
}

export function compareBoardIds(workspace: ArtboardWorkspace): string[] {
  const selected = workspace.selectedBoardIds.filter((id) => workspace.boards[id]);
  return selected.length >= 2 && selected.length <= 4 ? selected : [];
}

/** Pointer moves replace a local preview. Only releasing turns its latest value into one persisted gesture. */
export function updateGesturePreview(
  _current: ArtboardWorkspaceOperation | undefined,
  next: ArtboardWorkspaceOperation,
): ArtboardWorkspaceOperation {
  return next;
}

export function releaseGesturePreview(
  preview: ArtboardWorkspaceOperation | undefined,
): ArtboardWorkspaceOperation[] {
  return preview ? [preview] : [];
}

const normalizedRotation = (value: number) => {
  const rotation = ((value + 180) % 360 + 360) % 360 - 180;
  return Object.is(rotation, -0) ? 0 : rotation;
};

/** Removes a group at any depth while preserving its visual rotation and inherited state. */
export function ungroupLayerTree(workspace: ArtboardWorkspace, boardId: string, groupId: string) {
  const board = workspace.boards[boardId];
  const group = board?.document.layers[groupId];
  if (!board || group?.type !== "group") throw new Error(`Gruppe ${groupId} fehlt.`);
  const layers = structuredClone(board.document.layers);
  const nextGroup = layers[groupId];
  if (nextGroup.type !== "group") throw new Error(`Gruppe ${groupId} fehlt.`);
  const parent = Object.values(layers).find((layer) => layer.type === "group" && layer.childIds.includes(groupId));
  const siblings = parent?.type === "group" ? parent.childIds : [...board.document.rootLayerIds];
  const index = siblings.indexOf(groupId);
  if (index < 0) throw new Error(`Gruppe ${groupId} ist nicht erreichbar.`);
  const radians = nextGroup.geometry.rotation * Math.PI / 180;
  const cx = nextGroup.geometry.x + nextGroup.geometry.width / 2;
  const cy = nextGroup.geometry.y + nextGroup.geometry.height / 2;
  for (const childId of nextGroup.childIds) {
    const child = layers[childId];
    const childCx = child.geometry.x + child.geometry.width / 2;
    const childCy = child.geometry.y + child.geometry.height / 2;
    const dx = childCx - cx; const dy = childCy - cy;
    const rotatedCx = cx + dx * Math.cos(radians) - dy * Math.sin(radians);
    const rotatedCy = cy + dx * Math.sin(radians) + dy * Math.cos(radians);
    child.geometry = {
      ...child.geometry,
      x: rotatedCx - child.geometry.width / 2,
      y: rotatedCy - child.geometry.height / 2,
      rotation: normalizedRotation(child.geometry.rotation + nextGroup.geometry.rotation),
    };
    child.locked = nextGroup.locked || child.locked;
    child.visible = nextGroup.visible && child.visible;
    child.version += 1;
  }
  siblings.splice(index, 1, ...nextGroup.childIds);
  if (parent?.type === "group") parent.childIds = siblings;
  delete layers[groupId];
  return { rootLayerIds: parent ? [...board.document.rootLayerIds] : siblings, layers };
}
