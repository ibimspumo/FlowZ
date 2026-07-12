import type { AgentRunSnapshot, PersistedAgentSession } from "./types";

export type AgentRunUsage = {
  runId: string;
  providerTurnId?: string;
  inputTokens?: number;
  outputTokens?: number;
  costMicrounits?: number;
  generationId?: string;
};

export interface ArtboardAgentRepository {
  findSession(key: Pick<PersistedAgentSession, "workspaceId" | "branchId" | "provider" | "toolContractVersion">): Promise<PersistedAgentSession | undefined>;
  saveSession(session: PersistedAgentSession): Promise<void>;
  saveRun(run: AgentRunSnapshot): Promise<void>;
  saveUsage(usage: AgentRunUsage): Promise<void>;
}

export class MemoryArtboardAgentRepository implements ArtboardAgentRepository {
  readonly sessions = new Map<string, PersistedAgentSession>();
  readonly runs = new Map<string, AgentRunSnapshot>();
  readonly usage = new Map<string, AgentRunUsage>();
  private key(value: Pick<PersistedAgentSession, "workspaceId" | "branchId" | "provider" | "toolContractVersion">) {
    return `${value.workspaceId}\u0000${value.branchId}\u0000${value.provider}\u0000${value.toolContractVersion}`;
  }
  async findSession(key: Pick<PersistedAgentSession, "workspaceId" | "branchId" | "provider" | "toolContractVersion">) { return this.sessions.get(this.key(key)); }
  async saveSession(session: PersistedAgentSession) { this.sessions.set(this.key(session), structuredClone(session)); }
  async saveRun(run: AgentRunSnapshot) { this.runs.set(run.runId, structuredClone(run)); }
  async saveUsage(usage: AgentRunUsage) { this.usage.set(usage.runId, { ...this.usage.get(usage.runId), ...structuredClone(usage) }); }
}
