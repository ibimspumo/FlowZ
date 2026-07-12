import { shallow } from "zustand/vanilla/shallow";
import { describe, expect, it } from "vitest";
import type { FlowEdge, FlowNode } from "../types";
import { selectInputSources, selectLocalEdges } from "./flow-node-selectors";

const node = (id: string, value = id) =>
  ({ id, data: { kind: "textInput", label: id, status: "idle", updatePolicy: "manual", value } }) as FlowNode;

describe("FlowNode local graph subscriptions", () => {
  it("keeps an unrelated node drag shallow-equal for a heavy node", () => {
    const edge = { id: "e", source: "source", target: "heavy" } as FlowEdge;
    const before = [node("source"), node("heavy"), node("other")];
    const after = [before[0], before[1], { ...before[2], position: { x: 90, y: 40 } }];
    expect(shallow(selectLocalEdges([edge], "heavy"), selectLocalEdges([edge], "heavy"))).toBe(true);
    expect(shallow(selectInputSources(before, [edge], "heavy"), selectInputSources(after, [edge], "heavy"))).toBe(true);
  });

  it("invalidates when a connected source value changes", () => {
    const edge = { id: "e", source: "source", target: "heavy" } as FlowEdge;
    const source = node("source", "before");
    expect(shallow(selectInputSources([source], [edge], "heavy"), selectInputSources([{ ...source, data: { ...source.data, value: "after" } }], [edge], "heavy"))).toBe(false);
  });
});
