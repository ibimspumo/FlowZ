import { describe, expect, it } from "vitest";
import { outputDisplayValue } from "./extracted-provider-views";
import { runtimeValuesFromDisplay } from "./runtime-display-values";

describe("runtime display list semantics", () => {
  it("materializes one typed image list instead of text scalars", () => {
    const first = "a".repeat(64), second = "b".repeat(64);
    expect(runtimeValuesFromDisplay([`flowz-cas:${first}`, `flowz-cas:${second}`], "imageList")).toEqual([{
      kind: "list",
      itemType: "image",
      items: [{ type: "image", assetId: first }, { type: "image", assetId: second }],
    }]);
  });

  it("keeps text variants as a real display list", () => {
    expect(outputDisplayValue({
      kind: "list",
      itemType: "text",
      items: [{ type: "text", value: "Alpha" }, { type: "text", value: "Beta" }],
    })).toEqual(["Alpha", "Beta"]);
  });

  it("parses JSON list items without losing their artifact shape", () => {
    expect(runtimeValuesFromDisplay(['{"kind":"brand"}'], "jsonList")).toEqual([{
      kind: "list",
      itemType: "json",
      items: [{ type: "json", value: { kind: "brand" } }],
    }]);
  });
});
