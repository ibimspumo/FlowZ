import type {
  AgentProviderStatus,
  AgentRunSnapshot,
  ArtboardAgentAdapter,
  ArtboardAgentModel,
  ArtboardAgentProvider,
  ArtboardAgentRunState,
  ArtboardAgentToolExecutor,
} from "../artboard-agent";
import type { ArtboardOperationBatch } from "../artboard-workspace/types";
import type { ArtboardWorkspace } from "../nodes/brand/artboard-domain";
import type { ProposalDiffItem, ResolvedArtboardProposal } from "../artboard-agent/proposals";
import type { TranslationKey } from "../i18n";
export type { ProposalDiffItem, ResolvedArtboardProposal } from "../artboard-agent/proposals";

export type AgentAdapterFactory = {
  create(provider: ArtboardAgentProvider, executor: ArtboardAgentToolExecutor): ArtboardAgentAdapter | Promise<ArtboardAgentAdapter>;
};

export type ArtboardAgentSelection = {
  activeBoardId: string;
  boardIds: string[];
  layerIds: string[];
};

export type ArtboardAgentContext = {
  workspace: ArtboardWorkspace;
  branchId: string;
  revision: { id: string; number: number };
  selection: ArtboardAgentSelection;
};

export type ProposalResolver = (proposalId: string) => Promise<ResolvedArtboardProposal>;

export type AgentToolActivity = {
  id: string;
  tool: string;
  state: "running" | "complete" | "failed";
};

export type AgentConversationItem = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  translationKey?: TranslationKey;
  state?: "streaming" | "complete" | "error";
  createdAt: string;
};

export type ArtboardAgentUsage = {
  inputTokens?: number;
  outputTokens?: number;
  costMicrounits?: number;
  generationId?: string;
};

export type ProviderViewState = {
  status: AgentProviderStatus | { state: "probing" };
  models: ArtboardAgentModel[];
  error?: string;
};

export type ArtboardAgentControllerState = {
  provider: ArtboardAgentProvider;
  providers: Record<ArtboardAgentProvider, ProviderViewState>;
  modelId: string;
  reasoningEffort?: string;
  prompt: string;
  messages: AgentConversationItem[];
  tools: AgentToolActivity[];
  run?: AgentRunSnapshot;
  runState: ArtboardAgentRunState;
  proposal?: ResolvedArtboardProposal;
  usage: ArtboardAgentUsage;
  error?: string;
  applying: boolean;
};

export type ArtboardAgentControllerOptions = {
  context: ArtboardAgentContext;
  adapterFactory: AgentAdapterFactory;
  toolExecutor: ArtboardAgentToolExecutor;
  resolveProposal: ProposalResolver;
  onApplyProposal: (batch: ArtboardOperationBatch, proposal: ResolvedArtboardProposal) => void | Promise<void>;
  now?: () => Date;
  createId?: () => string;
};
