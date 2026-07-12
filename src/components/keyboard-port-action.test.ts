import { describe, expect, it } from "vitest";
import type { FlowEdge, FlowNode, NodeKind } from "../types";
import { keyboardPortCandidates } from "./KeyboardPortAction";

function node(id: string, kind: NodeKind, outputValues?: Record<string, unknown>): FlowNode {
  return {
    id,
    type: kind,
    position: { x: 0, y: 0 },
    data: { kind, label: id, status: "idle", updatePolicy: "manual", outputValues },
  } as FlowNode;
}

describe("keyboard port connection mode", () => {
  it("offers only type-compatible ports and prepares the complete connection", () => {
    const nodes = [node("source", "textInput"), node("text", "textGeneration"), node("image", "imageGeneration")];
    const candidates = keyboardPortCandidates({ nodes, edges: [], originNodeId: "source", originPortId: "text", direction: "output", dataType: "text" });
    expect(candidates.map((item) => `${item.nodeId}:${item.portId}`)).toEqual(["image:prompt", "text:prompt"]);
    expect(candidates[0]?.connection).toMatchObject({ source: "source", sourceHandle: "text", target: "image", targetHandle: "prompt::0" });
    expect(candidates.some((item) => item.portId === "reference")).toBe(false);
  });

  it("assigns the next multiple-input slot and omits occupied scalar inputs", () => {
    const nodes = [node("a", "textInput"), node("b", "textInput"), node("generation", "textGeneration"), node("transform", "imageTransform")];
    const edges = [{ id: "edge", source: "a", sourceHandle: "text", target: "generation", targetHandle: "prompt::0" }] as FlowEdge[];
    const multiple = keyboardPortCandidates({ nodes, edges, originNodeId: "b", originPortId: "text", direction: "output", dataType: "text" });
    expect(multiple.find((item) => item.nodeId === "generation")?.connection.targetHandle).toBe("prompt::1");

    const imageNodes = [node("image-a", "imageInput"), node("image-b", "imageInput"), node("transform", "imageTransform")];
    const occupied = [{ id: "image-edge", source: "image-a", sourceHandle: "image", target: "transform", targetHandle: "image" }] as FlowEdge[];
    expect(keyboardPortCandidates({ nodes: imageNodes, edges: occupied, originNodeId: "image-b", originPortId: "image", direction: "output", dataType: "image" }).some((item) => item.nodeId === "transform")).toBe(false);
  });

  it("connects an input backwards and exposes a list output only after it exists", () => {
    const target = node("target", "textGeneration");
    const emptyList = node("empty", "textGeneration", { texts: ["one"] });
    const populatedList = node("populated", "textGeneration", { texts: ["one", "two"] });
    const candidates = keyboardPortCandidates({ nodes: [target, emptyList, populatedList], edges: [], originNodeId: "target", originPortId: "textLists", direction: "input", dataType: "textList" });
    expect(candidates.map((item) => item.nodeId)).toEqual(["populated"]);
    expect(candidates[0]?.connection).toMatchObject({ source: "populated", sourceHandle: "texts", target: "target", targetHandle: "textLists" });
  });
});
