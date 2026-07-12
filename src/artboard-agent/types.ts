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
  provider: ArtboardAgentProvider;
  toolContractVersion: string;
};

export type PersistedAgentSession = AgentSessionKey & {
  providerSessionId: string;
  modelId: string;
  reasoningEffort?: string;
  lastTurnId?: string;
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
  openSession(input: AgentSessionKey & { modelId: string; reasoningEffort?: string; previousProviderSessionId?: string }): Promise<PersistedAgentSession>;
  runTurn(input: AgentRunSnapshot, userText: string, onEvent: (event: AgentEvent) => void): Promise<{ providerTurnId: string }>;
  cancel(runId: string): Promise<void>;
  recover(run: AgentRunSnapshot): Promise<AgentRunSnapshot>;
  close(): Promise<void>;
}

export type AgentToolResult = {
  content: unknown;
  /** Set by proposal-only write tools. The operation batch is not applied here. */
  proposalId?: string;
};

export interface ArtboardAgentToolExecutor {
  execute(tool: import("./tool-contract").ToolInvocation): Promise<AgentToolResult>;
}

export function selectableArtboardModels(models: readonly ArtboardAgentModel[], requiresVision: boolean): ArtboardAgentModel[] {
  return models.filter((model) => !model.hidden && model.inputModalities.includes("text") && (!requiresVision || model.inputModalities.includes("image")));
}
