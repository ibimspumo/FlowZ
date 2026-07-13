export type ArtboardAgentProvider = "openrouter" | "codex-local";

export type ArtboardAgentModel = {
  provider: ArtboardAgentProvider;
  id: string;
  name: string;
  inputModalities: ("text" | "image")[];
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  isDefault?: boolean;
  hidden?: boolean;
};

export type AgentProviderStatus =
  | { state: "ready"; accountLabel?: string }
  | { state: "auth-required" }
  | { state: "unavailable"; reason: string }
  | { state: "incompatible"; reason: string };

export type AgentSessionKey = {
  workspaceId: string;
  branchId: string;
  conversationId: string;
  provider: ArtboardAgentProvider;
  toolContractVersion: string;
};

export type PersistedAgentSession = AgentSessionKey & {
  providerSessionId: string;
  modelId: string;
  reasoningEffort?: string;
  lastTurnId?: string;
  /** One bounded canonical checkpoint, never an operation history. */
  manualContextCheckpoint?: ArtboardManualContextCheckpoint;
};

export type ArtboardManualContextCheckpoint = {
  schemaVersion: 1;
  revision: { id?: string; number: number };
  boards: ArtboardManualBoardSnapshot[];
  truncated?: boolean;
};

export type ArtboardManualBoardSnapshot = {
  id: string;
  name?: string;
  placement?: { x?: number; y?: number };
  format?: { preset?: string; width?: number; height?: number };
  background?: unknown;
  rootLayerIds: string[];
  layerCount?: number;
  bindingCount?: number;
  layers: ArtboardManualLayerSnapshot[];
  bindings: unknown[];
  truncated?: boolean;
};

export type ArtboardManualLayerSnapshot = {
  id: string;
  type?: string;
  name?: string;
  parentId?: string;
  index: number;
  properties: Record<string, unknown>;
};

export type ArtboardAgentRunState =
  | "idle"
  | "submitting"
  | "streaming"
  | "tool-executing"
  | "cancel-requested"
  | "interrupted"
  | "finalizing"
  | "proposal-ready"
  | "applying"
  | "rejecting"
  | "applied"
  | "rejected"
  | "failed"
  | "process-lost"
  | "recovering"
  | "unknown";

export type AgentRunSnapshot = AgentSessionKey & {
  runId: string;
  providerSessionId: string;
  providerTurnId?: string;
  modelId: string;
  reasoningEffort?: string;
  inputRevision: number;
  selectedBoardRevisionIds: string[];
  state: ArtboardAgentRunState;
  submittedAt: string;
  proposalId?: string;
  error?: string;
};

export type AgentEvent =
  | { type: "status"; status: ArtboardAgentRunState }
  | { type: "text-delta"; text: string }
  | { type: "provider-turn-started"; providerTurnId: string }
  | { type: "tool-started"; tool: string; operationId: string }
  | { type: "tool-completed"; tool: string; operationId: string; success: boolean }
  | { type: "proposal-updated"; proposalId: string }
  | { type: "usage"; inputTokens?: number; outputTokens?: number; costMicrounits?: number; generationId?: string }
  | { type: "completed"; proposalId: string }
  | { type: "interrupted" }
  | { type: "failed"; error: string };

export interface ArtboardAgentAdapter {
  readonly provider: ArtboardAgentProvider;
  probe(): Promise<AgentProviderStatus>;
  listModels(): Promise<ArtboardAgentModel[]>;
  latestRun(key: AgentSessionKey): Promise<AgentRunSnapshot | undefined>;
  saveRun(run: AgentRunSnapshot): Promise<void>;
  openSession(input: AgentSessionKey & { modelId: string; reasoningEffort?: string; previousProviderSessionId?: string }): Promise<PersistedAgentSession>;
  runTurn(input: AgentRunSnapshot, userText: string, onEvent: (event: AgentEvent) => void): Promise<{ providerTurnId: string }>;
  cancel(runId: string): Promise<void>;
  recover(run: AgentRunSnapshot): Promise<AgentRunSnapshot>;
  close(): Promise<void>;
}

export type AgentToolResult = {
  content: unknown;
  /** Local, bounded visual evidence for Codex dynamic-tool output. Never persisted. */
  imageDataUrl?: string;
  /** Set by proposal-only write tools. The operation batch is not applied here. */
  proposalId?: string;
};

export interface ArtboardAgentToolExecutor {
  execute(tool: import("./tool-contract").ToolInvocation): Promise<AgentToolResult>;
}

export function selectableArtboardModels(models: readonly ArtboardAgentModel[], requiresVision: boolean): ArtboardAgentModel[] {
  return models.filter((model) => !model.hidden && model.inputModalities.includes("text") && (!requiresVision || model.inputModalities.includes("image")));
}
