import { describe, expect, it } from "vitest";
import { policyOptions } from "./NodePolicyControl";

const labels = { manual: "Manual", automatic: "Automatic", frozen: "Frozen" };
describe("node update policy", () => {
  it("never offers accidental automatic execution for expensive visual nodes", () => {
    expect(policyOptions("imageGeneration", labels).map((item) => item.value)).toEqual(["manual", "frozen"]);
    expect(policyOptions("videoGeneration", labels).map((item) => item.value)).toEqual(["manual", "frozen"]);
    expect(policyOptions("textGeneration", labels).map((item) => item.value)).toEqual(["manual", "auto", "frozen"]);
  });
});
