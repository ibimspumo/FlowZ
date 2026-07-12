import { describe, expect, it } from "vitest";
import { abandonUnknownAgentRun, mayExecuteDynamicTool, mustNotResubmitAfterRestart, transitionAgentRun } from "./state-machine";
import { validateToolInvocation } from "./tool-contract";
import { selectableArtboardModels, type AgentRunSnapshot } from "./types";

const run = (state: AgentRunSnapshot["state"] = "idle"): AgentRunSnapshot => ({
  runId: "run-1", workspaceId: "workspace-1", branchId: "branch-main", provider: "codex-local", toolContractVersion: "v1", providerSessionId: "thread-1", modelId: "model-1", inputRevision: 1, selectedBoardRevisionIds: ["revision-1"], state, submittedAt: "2026-07-12T10:00:00.000Z",
});

describe("provider-neutral artboard agent", () => {
  it("filters provider models by visibility and real modalities", () => {
    const models = [
      { provider: "codex-local" as const, id: "vision", name: "Vision", inputModalities: ["text", "image"] as ("text" | "image")[] },
      { provider: "codex-local" as const, id: "text", name: "Text", inputModalities: ["text"] as ("text" | "image")[] },
      { provider: "codex-local" as const, id: "hidden", name: "Hidden", inputModalities: ["text", "image"] as ("text" | "image")[], hidden: true },
    ];
    expect(selectableArtboardModels(models, true).map((model) => model.id)).toEqual(["vision"]);
    expect(selectableArtboardModels(models, false).map((model) => model.id)).toEqual(["vision", "text"]);
  });

  it("does not allow a restart to resubmit an ambiguous active turn", () => {
    expect(mustNotResubmitAfterRestart(run("streaming"))).toBe(true);
    expect(mustNotResubmitAfterRestart(run("unknown"))).toBe(true);
    expect(mustNotResubmitAfterRestart(run("idle"))).toBe(false);
    expect(() => transitionAgentRun(run("unknown"), "idle")).toThrow(/Ungültiger/);
    expect(abandonUnknownAgentRun(run("unknown"), { confirmedByUser: true }).state).toBe("idle");
  });

  it("keeps cancellation and proposal transitions explicit", () => {
    const submitting = transitionAgentRun(run(), "submitting");
    const streaming = transitionAgentRun(submitting, "streaming");
    expect(mayExecuteDynamicTool(streaming)).toBe(true);
    expect(transitionAgentRun(streaming, "cancel-requested").state).toBe("cancel-requested");
    expect(() => transitionAgentRun(run("finalizing"), "proposal-ready")).toThrow(/Proposal-ID/);
    expect(transitionAgentRun(run("finalizing"), "proposal-ready", { proposalId: "proposal-1" }).proposalId).toBe("proposal-1");
  });
});

describe("artboard dynamic tool validation", () => {
  const layer = { id: "layer-1", type: "text", name: "Titel", locked: false, visible: true, geometry: { x: 0, y: 0, width: 200, height: 80, rotation: 0 }, text: "Hallo FlowZ", color: "#FFFFFF", fontSize: 48, align: "left" };
  const write = { tool: "update_layers", arguments: { workspaceId: "workspace-1", branchId: "branch-main", proposalId: "proposal-1", operationId: "operation-1", expectedRevision: 4, boardId: "board-1", layers: [layer] } };
  it("accepts a bounded idempotent proposal mutation", () => {
    expect(validateToolInvocation(write, { calls: 0, mutations: 0 }).nextBudget).toEqual({ calls: 1, mutations: 1 });
  });
  it("rejects unknown tools, hidden network/code payloads and oversized layer batches", () => {
    expect(() => validateToolInvocation({ tool: "shell", arguments: {} }, { calls: 0, mutations: 0 })).toThrow(/Unbekanntes/);
    expect(() => validateToolInvocation({ ...write, arguments: { ...write.arguments, layers: [null] } }, { calls: 0, mutations: 0 })).toThrow(/layers ist ungültig/);
    expect(() => validateToolInvocation({ ...write, arguments: { ...write.arguments, layers: [{ ...layer, geometry: { ...layer.geometry, width: -1 } }] } }, { calls: 0, mutations: 0 })).toThrow(/geometry.width/);
    expect(() => validateToolInvocation({ ...write, arguments: { ...write.arguments, layers: Array.from({ length: 21 }, (_, index) => ({ ...layer, id: `layer-${index}` })) } }, { calls: 0, mutations: 0 })).toThrow(/layers ist ungültig/);
    expect(() => validateToolInvocation({ ...write, arguments: { ...write.arguments, layers: [{ ...layer, text: "https://example.com" }] } }, { calls: 0, mutations: 0 })).toThrow(/keine URLs/);
  });
  it("enforces the per-turn call budget", () => {
    expect(() => validateToolInvocation({ tool: "get_selection", arguments: { workspaceId: "workspace-1", branchId: "branch-main" } }, { calls: 24, mutations: 0 })).toThrow(/Werkzeugbudget/);
  });
});
