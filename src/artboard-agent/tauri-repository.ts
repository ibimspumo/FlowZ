import { invoke } from "@tauri-apps/api/core";
import type { AgentRunUsage, ArtboardAgentRepository } from "./repository";
import type { AgentRunSnapshot, PersistedAgentSession } from "./types";

export class TauriArtboardAgentRepository implements ArtboardAgentRepository {
  async findSession(key: Pick<PersistedAgentSession, "workspaceId" | "branchId" | "provider" | "toolContractVersion">) { return (await invoke<PersistedAgentSession | null>("artboard_agent_session_find", { key })) ?? undefined; }
  async saveSession(session: PersistedAgentSession) { await invoke<void>("artboard_agent_session_save", { session }); }
  async saveRun(run: AgentRunSnapshot) { await invoke<void>("artboard_agent_run_save", { run }); }
  async saveUsage(usage: AgentRunUsage) { await invoke<void>("artboard_agent_usage_save", { usage }); }
}
