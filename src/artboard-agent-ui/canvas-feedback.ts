import { ARTBOARD_FORMATS, findBoardPlacement, type ArtboardBoard, type ArtboardFormat, type ArtboardWorkspace } from "../nodes/brand/artboard-domain";
import { renderArtboardSvg } from "../nodes/brand/artboard-renderer";
import { applyWorkspaceOperations } from "../artboard-workspace/repository";
import { fitCanvasRectangles } from "../artboard-workspace/canvas-navigation";
import type { ArtboardAgentControllerState, ArtboardAgentSelection } from "./types";

export type AgentCanvasGhostBoard = {
  id: string;
  name?: string;
  kind?: "new" | "variant";
  format: ArtboardFormat;
  placement: { x: number; y: number };
  phase: "working" | "preview";
  board?: ArtboardBoard;
};

export type AgentCanvasFeedback = {
  phase: "working" | "preview" | "applying";
  boardIds: string[];
  ghostBoards: AgentCanvasGhostBoard[];
  removedBoardIds?: string[];
  renderError?: string;
};

export type AgentCanvasViewportFit = { zoom: number; pan: { x: number; y: number } };

const MUTATING_TOOLS = new Set([
  "create_board", "duplicate_board_as_variant", "delete_board", "create_layers", "update_layers", "delete_layers",
  "duplicate_layers", "reorder_layers", "set_board_properties", "bind_layer_resource",
]);

const activeRunStates = new Set(["submitting", "streaming", "tool-executing", "finalizing", "recovering"]);

function dimensionsFromPrompt(prompt: string, fallback: ArtboardFormat): ArtboardFormat {
  const matches = [...prompt.matchAll(/(\d{2,5})\s*(?:x|×|✕)\s*(\d{2,5})/gi)];
  const match = matches.at(-1);
  if (!match) return fallback;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 64 || height < 64 || width > 32_768 || height > 32_768) return fallback;
  const matchingPreset = (Object.entries(ARTBOARD_FORMATS) as [ArtboardFormat["preset"], { width: number; height: number }][])
    .find(([, dimensions]) => dimensions.width === width && dimensions.height === height)?.[0];
  return { preset: matchingPreset ?? fallback.preset, width, height };
}

function proposalFeedback(state: ArtboardAgentControllerState, workspace: ArtboardWorkspace): AgentCanvasFeedback | undefined {
  const proposal = state.proposal;
  if (!proposal) return undefined;
  try {
    const createdIds = new Set(proposal.batch.operations.filter((operation) => operation.type === "create-board").map((operation) => operation.board.id));
    const removedIds = new Set(proposal.batch.operations.filter((operation) => operation.type === "delete-board").map((operation) => operation.boardId));
    if (!state.applying && [...createdIds].some((id) => Boolean(workspace.boards[id]))) {
      throw new Error("Ein vorgeschlagenes Artboard verwendet eine bereits belegte ID.");
    }
    const candidate = state.applying && [...createdIds].every((id) => Boolean(workspace.boards[id]))
      ? workspace
      : applyWorkspaceOperations(workspace, proposal.batch.operations);
    const touchedIds = new Set<string>();
    for (const operation of proposal.batch.operations) {
      if (operation.type === "create-board") touchedIds.add(operation.board.id);
      else if ("boardId" in operation) touchedIds.add(operation.boardId);
    }
    const ghostBoards: AgentCanvasGhostBoard[] = [];
    const boardIds: string[] = [];
    for (const boardId of touchedIds) {
      if (removedIds.has(boardId)) {
        const original = workspace.boards[boardId];
        if (!original) throw new Error(`Das zu entfernende Artboard ${boardId} ist nicht mehr vorhanden.`);
        renderArtboardSvg(original.document, (hash) => `flowz-media:${hash}`);
        boardIds.push(boardId);
        continue;
      }
      const board = candidate.boards[boardId];
      const placement = candidate.placements[boardId];
      if (!board || !placement) throw new Error(`Vorschau für Artboard ${boardId} konnte nicht aufgebaut werden.`);
      // Exercise the same canonical renderer used by export before enabling
      // Apply. The transport URL is irrelevant for structural validation.
      renderArtboardSvg(board.document, (hash) => `flowz-media:${hash}`);
      ghostBoards.push({
        id: `agent-preview-${board.id}`,
        name: board.name,
        format: board.document.format,
        placement,
        phase: "preview",
        board,
      });
      if (!createdIds.has(boardId)) boardIds.push(boardId);
    }
    return {
      phase: state.applying ? "applying" : "preview",
      boardIds,
      ghostBoards,
      removedBoardIds: [...removedIds],
    };
  } catch (error) {
    return {
      phase: "preview",
      boardIds: [],
      ghostBoards: [],
      renderError: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Derives a strictly ephemeral canvas hint from the visible agent state.
 * It never writes to the workspace and therefore cannot bypass proposal review.
 */
export function deriveAgentCanvasFeedback(
  state: ArtboardAgentControllerState,
  workspace: ArtboardWorkspace,
  selection: ArtboardAgentSelection,
): AgentCanvasFeedback | undefined {
  if (state.runState === "failed" || state.runState === "interrupted" || state.runState === "process-lost") return undefined;
  const proposal = proposalFeedback(state, workspace);
  if (proposal) return proposal;
  if (!activeRunStates.has(state.runState)) return undefined;

  const currentRunTools = state.run?.runId ? state.tools.filter((tool) => tool.runId === state.run!.runId) : [];
  const runningMutations = currentRunTools.filter((tool) => tool.state === "running" && MUTATING_TOOLS.has(tool.tool));
  const creationActivity = [...currentRunTools].reverse().find((tool) => (tool.tool === "create_board" || tool.tool === "duplicate_board_as_variant") && tool.state !== "failed");
  if (!runningMutations.length && !creationActivity) return undefined;
  const latest = runningMutations.at(-1);
  const sourceId = selection.activeBoardId && workspace.boards[selection.activeBoardId]
    ? selection.activeBoardId
    : workspace.activeBoardId;
  const source = workspace.boards[sourceId];
  const boardIds = !latest || latest.tool === "create_board" || creationActivity?.tool === "create_board"
    ? []
    : selection.boardIds.filter((id) => Boolean(workspace.boards[id]));
  const createsBoard = Boolean(creationActivity);
  if (!createsBoard || !source) return { phase: "working", boardIds, ghostBoards: [], ...(latest?.tool === "delete_board" ? { removedBoardIds: boardIds } : {}) };

  const lastUserPrompt = [...state.messages].reverse().find((message) => message.role === "user")?.text ?? "";
  const format = dimensionsFromPrompt(lastUserPrompt, source.document.format);
  const placement = findBoardPlacement(workspace, format, source.id);
  return {
    phase: "working",
    boardIds,
    ghostBoards: [{
      id: `agent-working-${state.run?.runId ?? creationActivity!.id}`,
      kind: creationActivity!.tool === "duplicate_board_as_variant" ? "variant" : "new",
      format,
      placement,
      phase: "working",
    }],
  };
}

/** Fits the source and transient candidate into the unobscured canvas area. */
export function fitAgentCanvasFeedback(
  feedback: AgentCanvasFeedback,
  workspace: ArtboardWorkspace,
  viewport: { width: number; height: number },
): AgentCanvasViewportFit | undefined {
  if (feedback.renderError || feedback.phase !== "preview" || !feedback.ghostBoards.length) return undefined;
  const rectangles = feedback.ghostBoards.map((ghost) => ({ ...ghost.placement, width: ghost.format.width, height: ghost.format.height }));
  const sourceIds = new Set([workspace.activeBoardId, ...feedback.boardIds]);
  for (const id of sourceIds) {
    const board = workspace.boards[id];
    const placement = workspace.placements[id];
    if (board && placement) rectangles.push({ ...placement, width: board.document.format.width, height: board.document.format.height });
  }
  if (!rectangles.length || viewport.width <= 0 || viewport.height <= 0) return undefined;
  // On desktop the floating agent occupies the right side. Keep the actual
  // candidate out from underneath it; compact layouts use the whole canvas.
  return fitCanvasRectangles(rectangles, viewport, { margin: 48, rightInset: viewport.width >= 1000 ? 452 : 48, maxZoom: 1 });
}
