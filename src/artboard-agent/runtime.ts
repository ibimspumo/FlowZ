import { createTauriArtboardAgentAdapterFactory } from "./adapter-factory";
import { TauriArtboardProposalRepository } from "./proposal-repository";
import { createProposalResolver, PersistentArtboardAgentToolExecutor, type ArtboardAgentContextProvider } from "./tool-executor";
import { TauriArtboardAgentRepository } from "./tauri-repository";

/** Complete productive runtime without any App/surface dependency. Apply deliberately remains a UI callback. */
export function createTauriArtboardAgentRuntime(contextProvider: ArtboardAgentContextProvider) {
  const agentRepository = new TauriArtboardAgentRepository();
  const proposalRepository = new TauriArtboardProposalRepository();
  const toolExecutor = new PersistentArtboardAgentToolExecutor(contextProvider, proposalRepository);
  return {
    adapterFactory: createTauriArtboardAgentAdapterFactory(agentRepository),
    toolExecutor,
    proposalRepository,
    resolveProposal: createProposalResolver(proposalRepository),
  };
}
