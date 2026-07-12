import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { CodexAppServerTransport, CodexServerEvent } from "./codex-adapter";

export class TauriCodexAppServerTransport implements CodexAppServerTransport {
  private startup?: Promise<void>; private unlisten?: UnlistenFn; private readonly listeners = new Set<(event: CodexServerEvent) => void>();
  start(): Promise<void> {
    return this.startup ??= (async () => {
      this.unlisten = await listen<unknown>("codex-app-server-event", ({ payload }) => {
        if (!payload || typeof payload !== "object" || !("method" in payload)) return;
        for (const listener of this.listeners) listener(payload as CodexServerEvent);
      });
      try { await invoke<void>("codex_agent_start"); } catch (error) { this.unlisten?.(); this.unlisten = undefined; this.startup = undefined; throw error; }
    })();
  }
  async request<T>(method: string, params: Record<string, unknown>): Promise<T> { await this.start(); return invoke<T>("codex_agent_request", { request: { method, params } }); }
  async respond(id: string | number, result: unknown) { await invoke<void>("codex_agent_respond", { response: { id, result } }); }
  subscribe(listener: (event: CodexServerEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async scratchDirectory(workspaceId: string) { const result = await invoke<{ path: string }>("codex_agent_scratch", { workspaceId }); return result.path; }
  async close() { this.unlisten?.(); this.unlisten = undefined; this.listeners.clear(); if (this.startup) await invoke<void>("codex_agent_close"); this.startup = undefined; }
}
