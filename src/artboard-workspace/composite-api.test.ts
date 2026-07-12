import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

describe("Artboard composite persistence client", () => {
  beforeEach(() => {
    invoke.mockReset();
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  });

  it("sends binary bytes and exact revision/selection metadata without data URLs", async () => {
    invoke.mockResolvedValue([]);
    const { persistArtboardComposites } = await import("../api");
    const request = {
      operationId: "operation-1", projectId: "project-1", nodeId: "node-1",
      workspaceId: "workspace-1", revisionId: "revision-3",
      composites: [{ boardId: "board-1", active: true, selectedIndex: 0, pngBytes: [137, 80, 78, 71] }],
    };
    await persistArtboardComposites(request);
    expect(invoke).toHaveBeenCalledWith("artboard_composites_persist", { request });
    expect(JSON.stringify(invoke.mock.calls[0])).not.toContain("data:image");
  });
});
