import { describe, expect, it } from "vitest";
import { resolveLogoBrief } from "./logo-module";

describe("logo direct brief priority", () => {
  it("uses the connected brief before a local fallback", () => {
    expect(resolveLogoBrief(["connected"], "local", false)).toEqual({ values: ["connected"], source: "connected" });
  });

  it("uses a conscious local override and resets safely to the connection", () => {
    expect(resolveLogoBrief(["connected"], "local", true)).toEqual({ values: ["local"], source: "override" });
    expect(resolveLogoBrief(["connected"], "local", false)).toEqual({ values: ["connected"], source: "connected" });
  });

  it("uses local content only as fallback and reports a missing brief", () => {
    expect(resolveLogoBrief([], "local", false)).toEqual({ values: ["local"], source: "local" });
    expect(resolveLogoBrief([], "  ", true)).toEqual({ values: [], source: "missing" });
  });
});
