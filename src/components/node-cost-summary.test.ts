import { describe, expect, it } from "vitest";
import { lifetimeNodeCost } from "./NodeCostSummary";

describe("node cost summary", () => {
  it("counts one provider charge only once across sibling variants", () => {
    expect(lifetimeNodeCost([
      { id: "a", runId: "group", costRunId: "charge", createdAt: "now", value: "A", cost: .04 },
      { id: "b", runId: "group", costRunId: "charge", createdAt: "now", value: "B", cost: .04 },
      { id: "c", runId: "second", createdAt: "later", value: "C", cost: .01 },
    ])).toBeCloseTo(.05);
  });
});
