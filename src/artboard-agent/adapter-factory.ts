import { CodexLocalArtboardAgentAdapter } from "./codex-adapter";
import { OpenRouterArtboardAgentAdapter } from "./openrouter-adapter";
import type { ArtboardAgentRepository } from "./repository";
import { TauriArtboardAgentRepository } from "./tauri-repository";
import { TauriCodexAppServerTransport } from "./tauri-codex-transport";
import { TauriOpenRouterAgentTransport } from "./tauri-openrouter-transport";
import type { ArtboardAgentAdapter, ArtboardAgentProvider, ArtboardAgentToolExecutor } from "./types";

export interface TauriAgentAdapterFactory {
  create(provider: ArtboardAgentProvider, executor: ArtboardAgentToolExecutor): ArtboardAgentAdapter;
}

/** Product adapter factory. Proposal execution remains injected and therefore revision-bound by the surface. */
export class TauriArtboardAgentAdapterFactory implements TauriAgentAdapterFactory {
  constructor(private readonly repository: ArtboardAgentRepository = new TauriArtboardAgentRepository()) {}
  create(provider: ArtboardAgentProvider, executor: ArtboardAgentToolExecutor): ArtboardAgentAdapter {
    if (provider === "openrouter") return new OpenRouterArtboardAgentAdapter(new TauriOpenRouterAgentTransport(), this.repository, executor);
    return new CodexLocalArtboardAgentAdapter(new TauriCodexAppServerTransport(), this.repository, executor);
  }
}

export function createTauriArtboardAgentAdapterFactory(repository?: ArtboardAgentRepository): TauriAgentAdapterFactory {
  return new TauriArtboardAgentAdapterFactory(repository);
}
