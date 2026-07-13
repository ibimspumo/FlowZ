import type { AgentRunSnapshot, AgentSessionKey, PersistedAgentSession } from "./types";

export function agentSessionKey(value: AgentSessionKey): AgentSessionKey {
  return {
    workspaceId: value.workspaceId,
    branchId: value.branchId,
    conversationId: value.conversationId,
    provider: value.provider,
    toolContractVersion: value.toolContractVersion,
  };
}

export type AgentRunUsage = {
  runId: string;
  providerTurnId?: string;
  inputTokens?: number;
  outputTokens?: number;
  costMicrounits?: number;
  generationId?: string;
};

export interface ArtboardAgentRepository {
  findSession(key: AgentSessionKey): Promise<PersistedAgentSession | undefined>;
  findLatestRun(key: AgentSessionKey): Promise<AgentRunSnapshot | undefined>;
  saveSession(session: PersistedAgentSession): Promise<void>;
  saveRun(run: AgentRunSnapshot): Promise<void>;
  saveUsage(usage: AgentRunUsage): Promise<void>;
}

export class MemoryArtboardAgentRepository implements ArtboardAgentRepository {
  readonly sessions = new Map<string, PersistedAgentSession>();
  readonly runs = new Map<string, AgentRunSnapshot>();
  readonly usage = new Map<string, AgentRunUsage>();
  private key(value: AgentSessionKey) {
    const key = agentSessionKey(value);
    return `${key.workspaceId}\u0000${key.branchId}\u0000${key.conversationId}\u0000${key.provider}\u0000${key.toolContractVersion}`;
  }
  async findSession(key: AgentSessionKey) { const value=this.sessions.get(this.key(key));return value?structuredClone(value):undefined; }
  async findLatestRun(key: AgentSessionKey) {
    const exact = agentSessionKey(key);
    return [...this.runs.values()]
      .filter((run) => run.workspaceId === exact.workspaceId && run.branchId === exact.branchId && run.conversationId === exact.conversationId && run.provider === exact.provider && run.toolContractVersion === exact.toolContractVersion)
      .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0];
  }
  async saveSession(session: PersistedAgentSession) { this.sessions.set(this.key(session), structuredClone(session)); }
  async saveRun(run: AgentRunSnapshot) { this.runs.set(run.runId, structuredClone(run)); }
  async saveUsage(usage: AgentRunUsage) { this.usage.set(usage.runId, { ...this.usage.get(usage.runId), ...structuredClone(usage) }); }
}
