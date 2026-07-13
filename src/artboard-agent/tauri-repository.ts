import { invoke } from "@tauri-apps/api/core";
import { agentSessionKey, type AgentRunUsage, type ArtboardAgentRepository } from "./repository";
import type { AgentRunSnapshot, AgentSessionKey, PersistedAgentSession } from "./types";

export class TauriArtboardAgentRepository implements ArtboardAgentRepository {
  async findSession(key: AgentSessionKey) { return (await invoke<PersistedAgentSession | null>("artboard_agent_session_find", { key: agentSessionKey(key) })) ?? undefined; }
  async findLatestRun(key: AgentSessionKey) { return (await invoke<AgentRunSnapshot | null>("artboard_agent_run_find_latest", { key: agentSessionKey(key) })) ?? undefined; }
  async saveSession(session: PersistedAgentSession) { await invoke<void>("artboard_agent_session_save", { session }); }
  async saveRun(run: AgentRunSnapshot) { await invoke<void>("artboard_agent_run_save", { run }); }
  async saveUsage(usage: AgentRunUsage) { await invoke<void>("artboard_agent_usage_save", { usage }); }
}
