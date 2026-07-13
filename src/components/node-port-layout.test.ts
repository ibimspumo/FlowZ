import { describe, expect, it } from "vitest";
import {
  nodePortRailRowCount,
  nodePortRailStyle,
  nodePortSocketStyle,
} from "./node-port-layout";

describe("node port rail layout", () => {
  it("reserves independent rows for the busier side", () => {
    expect(nodePortRailRowCount(4, 1)).toBe(4);
    expect(nodePortRailRowCount(1, 3)).toBe(3);
  });

  it("includes sparse variant output row offsets", () => {
    expect(nodePortRailRowCount(1, 2, [0, 3])).toBe(6);
  });

  it("positions sockets relative to the rail instead of the header", () => {
    expect(nodePortSocketStyle(0)).toEqual({ top: "5px" });
    expect(nodePortSocketStyle(2)).toEqual({ top: "57px" });
    expect(nodePortRailStyle(3)).toEqual({ minHeight: "88px" });
  });
});
