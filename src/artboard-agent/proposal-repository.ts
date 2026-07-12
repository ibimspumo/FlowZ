import { invoke } from "@tauri-apps/api/core";
import { assertProposalTransition, validatePersistedArtboardProposal, type PersistedArtboardProposal } from "./proposals";

export interface ArtboardProposalRepository {
  findProposal(proposalId: string): Promise<PersistedArtboardProposal | undefined>;
  saveProposal(proposal: PersistedArtboardProposal): Promise<void>;
  deleteProposal(proposalId: string): Promise<void>;
}

export class MemoryArtboardProposalRepository implements ArtboardProposalRepository {
  readonly proposals = new Map<string, PersistedArtboardProposal>();
  async findProposal(proposalId: string) {
    const value = this.proposals.get(proposalId);
    return value ? structuredClone(value) : undefined;
  }
  async saveProposal(proposal: PersistedArtboardProposal) {
    validatePersistedArtboardProposal(proposal);
    const previous = this.proposals.get(proposal.proposalId);
    if (previous) assertProposalTransition(previous, proposal);
    this.proposals.set(proposal.proposalId, structuredClone(proposal));
  }
  async deleteProposal(proposalId: string) {
    if (this.proposals.get(proposalId)?.state === "frozen") throw new Error("Ein abgeschlossener Artboard-Vorschlag ist unveränderlich.");
    this.proposals.delete(proposalId);
  }
}

export class TauriArtboardProposalRepository implements ArtboardProposalRepository {
  async findProposal(proposalId: string) {
    const value = (await invoke<PersistedArtboardProposal | null>("artboard_agent_proposal_find", { proposalId })) ?? undefined;
    if (value) validatePersistedArtboardProposal(value);
    return value;
  }
  async saveProposal(proposal: PersistedArtboardProposal) {
    validatePersistedArtboardProposal(proposal);
    await invoke<void>("artboard_agent_proposal_save", { proposal });
  }
  async deleteProposal(proposalId: string) {
    await invoke<void>("artboard_agent_proposal_delete", { proposalId });
  }
}
