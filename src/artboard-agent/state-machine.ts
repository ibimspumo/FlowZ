import type { AgentRunSnapshot, ArtboardAgentRunState } from "./types";

const transitions: Record<ArtboardAgentRunState, readonly ArtboardAgentRunState[]> = {
  idle: ["submitting"],
  submitting: ["streaming", "cancel-requested", "failed", "process-lost", "unknown"],
  streaming: ["tool-executing", "finalizing", "cancel-requested", "failed", "process-lost", "unknown"],
  "tool-executing": ["streaming", "finalizing", "cancel-requested", "failed", "process-lost", "unknown"],
  "cancel-requested": ["interrupted", "process-lost", "unknown"],
  interrupted: ["idle"],
  finalizing: ["proposal-ready", "failed", "process-lost", "unknown"],
  "proposal-ready": ["applying", "rejecting", "idle"],
  applying: ["idle", "failed", "process-lost", "unknown"],
  rejecting: ["idle", "failed", "process-lost", "unknown"],
  failed: ["idle", "recovering"],
  "process-lost": ["recovering", "unknown"],
  recovering: ["streaming", "tool-executing", "finalizing", "proposal-ready", "interrupted", "failed", "unknown"],
  unknown: ["recovering"],
};

export function transitionAgentRun(run: AgentRunSnapshot, next: ArtboardAgentRunState, patch: Partial<Pick<AgentRunSnapshot, "proposalId" | "error">> = {}): AgentRunSnapshot {
  if (!transitions[run.state].includes(next)) throw new Error(`Ungültiger Agent-Zustandswechsel: ${run.state} → ${next}.`);
  if (next === "proposal-ready" && !patch.proposalId && !run.proposalId) throw new Error("Ein fertiger Vorschlag benötigt eine Proposal-ID.");
  return { ...run, ...patch, state: next };
}

export function maySubmitAgentTurn(run: AgentRunSnapshot): boolean {
  return run.state === "idle";
}

export function mayExecuteDynamicTool(run: AgentRunSnapshot): boolean {
  return run.state === "streaming" || run.state === "tool-executing";
}

export function mustNotResubmitAfterRestart(run: AgentRunSnapshot): boolean {
  return !["idle", "interrupted", "proposal-ready", "failed"].includes(run.state);
}

export function abandonUnknownAgentRun(run: AgentRunSnapshot, confirmation: { confirmedByUser: true }): AgentRunSnapshot {
  if (run.state !== "unknown" || confirmation.confirmedByUser !== true) throw new Error("Nur ein bewusst bestätigter unbekannter Lauf darf aufgegeben werden.");
  return { ...run, state: "idle", error: undefined };
}
