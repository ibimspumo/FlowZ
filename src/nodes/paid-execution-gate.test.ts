import { describe, expect, it, vi } from "vitest";
import { PaidExecutionConflictError, hasPaidNodeLease, pendingPaidRunState, runPaidNodeOnce } from "./paid-execution-gate";

describe("paid node execution gate", () => {
  it("coalesces same-tick node, Enter and group execution before a run ID can be allocated", async () => {
    let finish!: () => void;
    const operation = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const request = { projectId: "project", nodeId: "node", contract: "fingerprint", operation };

    const click = runPaidNodeOnce(request);
    const enter = runPaidNodeOnce(request);
    const group = runPaidNodeOnce(request);
    expect(click).toBe(enter);
    expect(enter).toBe(group);
    expect(operation).not.toHaveBeenCalled();
    expect(hasPaidNodeLease("project", "node")).toBe(true);

    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(1));
    finish();
    await Promise.all([click, enter, group]);
    expect(hasPaidNodeLease("project", "node")).toBe(false);
  });

  it("blocks a changed contract only while active and permits the next deliberate run", async () => {
    let finish!: () => void;
    const first = runPaidNodeOnce({ projectId: "project", nodeId: "changed-node", contract: "old", operation: () => new Promise<void>((resolve) => { finish = resolve; }) });
    await expect(runPaidNodeOnce({ projectId: "project", nodeId: "changed-node", contract: "new", operation: vi.fn() })).rejects.toBeInstanceOf(PaidExecutionConflictError);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function")); finish(); await first;
    const next = vi.fn(async () => undefined);
    await runPaidNodeOnce({ projectId: "project", nodeId: "changed-node", contract: "new", operation: next });
    expect(next).toHaveBeenCalledOnce();
  });

  it("releases failed and unknown operations without replaying them", async () => {
    const unknown = vi.fn(async () => { throw new Error("FLOWZ_SUBMIT_UNKNOWN: uncertain"); });
    const first = runPaidNodeOnce({ projectId: "project", nodeId: "unknown", contract: "same", operation: unknown });
    const parallel = runPaidNodeOnce({ projectId: "project", nodeId: "unknown", contract: "same", operation: unknown });
    await expect(first).rejects.toThrow("uncertain");
    await expect(parallel).rejects.toThrow("uncertain");
    expect(unknown).toHaveBeenCalledOnce();
    expect(hasPaidNodeLease("project", "unknown")).toBe(false);
  });

  it("keeps restart journal states fail-closed", () => {
    expect(pendingPaidRunState("submit_unknown")).toBe("unknown");
    expect(pendingPaidRunState("cancel_requested")).toBe("cancel-requested");
    expect(pendingPaidRunState("in_progress")).toBe("in-flight");
  });
});
