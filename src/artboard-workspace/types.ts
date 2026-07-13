import type {
  ArtboardBoard,
  ArtboardFormat,
  ArtboardInputSnapshot,
  ArtboardLayer,
  ArtboardPreset,
  ArtboardWorkspace,
} from "../nodes/brand/artboard-domain";
import type { ArtboardAgentContext, ArtboardAgentSelection, AgentAdapterFactory, ProposalResolver, ResolvedArtboardProposal, ArtboardDesignAgentProps } from "../artboard-agent-ui";
import type { ArtboardAgentToolExecutor } from "../artboard-agent";

export type ArtboardWorkspaceOperation =
  | { type: "rename-workspace"; name: string }
  | { type: "rename-board"; boardId: string; name: string }
  | { type: "set-board-format"; boardId: string; format: ArtboardFormat }
  | { type: "set-board-paint"; boardId: string; color: string }
  | { type: "move-board"; boardId: string; x: number; y: number }
  | { type: "update-layer"; boardId: string; layerId: string; patch: Partial<ArtboardLayer> }
  | { type: "create-layer"; boardId: string; layer: ArtboardLayer; rootIndex: number }
  | { type: "set-layer-tree"; boardId: string; rootLayerIds: string[]; layers: Record<string, ArtboardLayer> }
  | { type: "delete-layers"; boardId: string; layerIds: string[] }
  | { type: "reorder-layer"; boardId: string; layerId: string; direction: "forward" | "backward" }
  | { type: "create-board"; board: ArtboardBoard; placement: { x: number; y: number } }
  | { type: "delete-board"; boardId: string }
  | { type: "set-board-inputs"; boardId: string; snapshot: ArtboardInputSnapshot };

export type ArtboardOperationBatch = {
  operationId: string;
  expectedRevisionId: string;
  expectedRevisionNumber: number;
  operations: ArtboardWorkspaceOperation[];
};

export type ArtboardAssetItem = {
  id: string;
  versionId: string;
  name: string;
  kind: "image" | "palette" | "font" | "text";
  previewUrl?: string;
  detail?: string;
  casHash?: string;
};

export type ArtboardAgentRequest = {
  message: string;
  boardIds: string[];
  layerIds: string[];
  backend?: { provider: string; modelId: string };
};

export type ArtboardWorkspaceProps = {
  workspace: ArtboardWorkspace;
  revision: { id: string; number: number };
  canUndo?: boolean;
  canRedo?: boolean;
  isBusy?: boolean;
  assets?: ArtboardAssetItem[];
  assetTotal?: number;
  assetsLoading?: boolean;
  onLoadMoreAssets?: () => void;
  upstreamUpdates?: Record<string, ArtboardInputSnapshot>;
  resolveAsset?: (hash: string) => string;
  onBack: () => void;
  onApplyOperations: (batch: ArtboardOperationBatch) => void | Promise<void>;
  onSelectionChange: (activeBoardId: string, selectedBoardIds: string[]) => void;
  onCreateBoard: (preset: ArtboardPreset, sourceBoardId?: string) => void;
  onDuplicateBoard: (boardId: string) => void;
  onCreateVariant: (boardId: string, snapshot?: ArtboardInputSnapshot) => void;
  onIgnoreUpstreamUpdate: (boardId: string, snapshot: ArtboardInputSnapshot) => void;
  onUpdateBoardInputs: (boardId: string, snapshot: ArtboardInputSnapshot) => void;
  onUndo: () => void;
  onRedo: () => void;
  onExport: (boardIds: string[]) => void;
  onInsertAsset?: (asset: ArtboardAssetItem, destination?: {boardId?:string;layerId?:string;x?:number;y?:number}) => void;
  onImportImage?: (file:File,destination?:{boardId?:string;layerId?:string;x?:number;y?:number})=>void|Promise<void>;
  agent?: {
    branchId: string;
    adapterFactory: AgentAdapterFactory;
    toolExecutor: ArtboardAgentToolExecutor;
    resolveProposal: ProposalResolver;
    prepareContext: () => Promise<ArtboardAgentContext>;
    onApplyProposal: (batch: ArtboardOperationBatch, proposal: ResolvedArtboardProposal) => void | Promise<void>;
    onSelectionChange: (selection: ArtboardAgentSelection) => void;
    onOpenProviderSettings?: () => void;
    pendingFollowUps?: ResolvedArtboardProposal["followUpIntents"];
    pendingFollowUpProposalId?: string;
    onConfirmFollowUp?: ArtboardDesignAgentProps["onConfirmFollowUp"];
    onOpenFalSettings?:()=>void;
    onDismissFollowUps?: () => void;
  };
};

export type SelectedLayer = { boardId: string; layerId: string };
export type WorkspacePanel = "layers" | "assets" | "inputs";

export const ARTBOARD_PRESET_OPTIONS: { value: ArtboardPreset; label: string }[] = [
  { value: "instagram-post", label: "Instagram Post · 1080 × 1080" },
  { value: "instagram-story", label: "Instagram Story · 1080 × 1920" },
  { value: "youtube-thumbnail", label: "YouTube Thumbnail · 1920 × 1080" },
  { value: "meta-ad", label: "Meta Ad · 1200 × 628" },
];

export type BoardViewProps = {
  board: ArtboardBoard;
  placement: { x: number; y: number };
};
