import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { TauriArtboardAgentRepository } from "./tauri-repository";

describe("Tauri Artboard agent repository contract", () => {
  beforeEach(() => invoke.mockReset().mockResolvedValue(null));

  it("sends only the exact persisted session identity to Rust", async () => {
    const repository = new TauriArtboardAgentRepository();
    await repository.findSession({
      workspaceId: "workspace-1",
      branchId: "branch-main",
      conversationId: "chat-1",
      provider: "codex-local",
      toolContractVersion: "artboard-tools-v1",
      modelId: "must-not-cross-the-session-key-boundary",
      reasoningEffort: "high",
    } as never);

    expect(invoke).toHaveBeenCalledWith("artboard_agent_session_find", {
      key: {
        workspaceId: "workspace-1",
        branchId: "branch-main",
        conversationId: "chat-1",
        provider: "codex-local",
        toolContractVersion: "artboard-tools-v1",
      },
    });
  });

  it("restores the latest run only through the exact conversation key", async () => {
    const repository = new TauriArtboardAgentRepository();
    await repository.findLatestRun({ workspaceId: "workspace-1", branchId: "branch-main", conversationId: "chat-2", provider: "codex-local", toolContractVersion: "flowz-artboard-tools-v2" });
    expect(invoke).toHaveBeenCalledWith("artboard_agent_run_find_latest", { key: { workspaceId: "workspace-1", branchId: "branch-main", conversationId: "chat-2", provider: "codex-local", toolContractVersion: "flowz-artboard-tools-v2" } });
  });
});
