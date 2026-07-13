import { describe, expect, it } from "vitest";
import type { ProjectDocument } from "../domain";
import type { FlowEdge, FlowNode, NodeKind } from "../types";
import { moduleForKind } from "../app/adapters";
import { keyboardConnectionExists, keyboardPortCandidates } from "./KeyboardPortAction";

function node(id: string, kind: NodeKind, outputValues?: Record<string, unknown>): FlowNode {
  return {
    id,
    type: kind,
    position: { x: 0, y: 0 },
    data: { kind, label: id, status: "idle", updatePolicy: "manual", outputValues },
  } as FlowNode;
}

function document(nodes: readonly FlowNode[], edges: readonly FlowEdge[]): ProjectDocument {
  return {
    schemaVersion: 2, id: "project", name: "Keyboard", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    graph: {
      nodes: nodes.map((item) => ({ id: item.id, moduleId: moduleForKind(item.data.kind), moduleVersion: 1, position: item.position, config: {}, updatePolicy: "manual" })),
      edges: edges.map((edge) => ({ id: edge.id, sourceNodeId: edge.source, sourcePortId: edge.sourceHandle ?? "", targetNodeId: edge.target, targetPortId: edge.targetHandle ?? "", order: edge.data?.order ?? 0 })),
      groups: [],
    },
    canvas: { viewport: { x: 0, y: 0, zoom: 1 } },
  };
}

describe("keyboard port connection mode", () => {
  it("offers only type-compatible ports and prepares the complete connection", () => {
    const nodes = [node("source", "textInput"), node("text", "textGeneration"), node("image", "imageGeneration")];
    const candidates = keyboardPortCandidates({ nodes, edges: [], originNodeId: "source", originPortId: "text", direction: "output", dataType: "text" });
    expect(candidates.map((item) => `${item.nodeId}:${item.portId}`)).toEqual(["image:prompt", "text:prompt"]);
    expect(candidates[0]?.connection).toMatchObject({ source: "source", sourceHandle: "text", target: "image", targetHandle: "prompt" });
    expect(candidates.some((item) => item.portId === "reference")).toBe(false);
  });

  it("keeps multiple inputs canonical and replaces occupied scalar inputs", () => {
    const nodes = [node("a", "textInput"), node("b", "textInput"), node("generation", "textGeneration"), node("transform", "imageTransform")];
    const edges = [{ id: "edge", source: "a", sourceHandle: "text", target: "generation", targetHandle: "prompt" }] as FlowEdge[];
    const multiple = keyboardPortCandidates({ nodes, edges, originNodeId: "b", originPortId: "text", direction: "output", dataType: "text" });
    expect(multiple.find((item) => item.nodeId === "generation")?.connection.targetHandle).toBe("prompt");

    const imageNodes = [node("image-a", "imageInput"), node("image-b", "imageInput"), node("transform", "imageTransform")];
    const occupied = [{ id: "image-edge", source: "image-a", sourceHandle: "image", target: "transform", targetHandle: "image" }] as FlowEdge[];
    const replacement = keyboardPortCandidates({ nodes: imageNodes, edges: occupied, originNodeId: "image-b", originPortId: "image", direction: "output", dataType: "image" }).find((item) => item.nodeId === "transform");
    expect(replacement).toMatchObject({ replacingEdgeId: "image-edge", connection: { source: "image-b", target: "transform", targetHandle: "image" } });
    const replacedEdges = [{ ...occupied[0], source: "image-b" }];
    expect(keyboardConnectionExists(replacedEdges, replacement!)).toBe(true);
  });

  it("does not offer a type-compatible connection that would close a graph cycle", () => {
    const nodes = [node("a", "textGeneration"), node("b", "textGeneration")];
    const edges = [{ id: "a-to-b", source: "a", sourceHandle: "text", target: "b", targetHandle: "prompt" }] as FlowEdge[];
    const candidates = keyboardPortCandidates({ nodes, edges, document: document(nodes, edges), originNodeId: "b", originPortId: "text", direction: "output", dataType: "text" });
    expect(candidates.some((item) => item.nodeId === "a" && item.portId === "prompt")).toBe(false);
  });

  it("does not offer nominally different Brand artifacts that merely share JSON",()=>{
    const nodes=[node("brief","brandBrief"),node("audience","audienceAnalysis"),node("domains","domainCheck"),node("fonts","fontPairing"),node("palette","colorPalette"),node("artboard","artboard")];
    const fromBrief=keyboardPortCandidates({nodes,edges:[],originNodeId:"brief",originPortId:"brief",direction:"output",dataType:"json"});
    expect(fromBrief.map((item)=>`${item.nodeId}:${item.portId}`)).toEqual(["audience:brief","fonts:brief","palette:brief"]);
    expect(fromBrief.some((item)=>item.nodeId==="domains")).toBe(false);
    const fromPalette=keyboardPortCandidates({nodes,edges:[],originNodeId:"palette",originPortId:"palette",direction:"output",dataType:"json"});
    expect(fromPalette.map((item)=>`${item.nodeId}:${item.portId}`)).toEqual(["artboard:palette"]);
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
