import { describe, expect, it } from "vitest";
import { artboardLinkFreshness, artboardNodeOutputs, artboardWorkspaceReference, safeArtboardPreviewSvg } from "./node-reference";
import type { FlowNodeData } from "../types";

const linked = { kind: "artboard", label: "Artboard", status: "fresh", updatePolicy: "manual", artboardWorkspaceId: "workspace-1", artboardRevisionId: "revision-2", artboardRevisionNumber: 2, artboardInputSnapshotId: "snapshot-2", artboardLinkedInputSignature: "inputs-a", artboardActiveImageHash: "a".repeat(64), artboardSelectedImageHashes: ["b".repeat(64)] } satisfies FlowNodeData;

describe("first-class Artboard node reference", () => {
  it("emits only the workspace reference and curated image outputs", () => {
    expect(artboardWorkspaceReference(linked)).toEqual({ artifact: "flowz.artboard-workspace-ref", version: 1, workspaceId: "workspace-1", revisionId: "revision-2", revisionNumber: 2, inputSnapshotId: "snapshot-2" });
    expect(artboardNodeOutputs(linked)).toEqual({ artboard: JSON.stringify(artboardWorkspaceReference(linked)), image: `flowz-cas:${"a".repeat(64)}`, images: [`flowz-cas:${"b".repeat(64)}`] });
  });
  it("marks upstream changes without silently replacing the workspace snapshot", () => {
    expect(artboardLinkFreshness(linked, "inputs-a")).toBe("fresh");
    expect(artboardLinkFreshness(linked, "inputs-b")).toBe("upstream-changed");
    expect(artboardLinkFreshness({ ...linked, artboardWorkspaceId: undefined }, "inputs-a")).toBe("unlinked");
  });
  it("accepts canonical previews but rejects executable imported SVG", () => {
    expect(safeArtboardPreviewSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>')).toContain("<rect");
    expect(safeArtboardPreviewSvg(`<svg xmlns="http://www.w3.org/2000/svg"><image href="flowz-media://localhost/${"c".repeat(64)}"/></svg>`)).toContain("<image");
    expect(safeArtboardPreviewSvg('<svg><script>alert(1)</script></svg>')).toBeUndefined();
    expect(safeArtboardPreviewSvg('<svg onload="alert(1)"><rect width="1" height="1"/></svg>')).toBeUndefined();
    expect(safeArtboardPreviewSvg('<svg><style>@import "https://example.test/a.css"</style></svg>')).toBeUndefined();
    expect(safeArtboardPreviewSvg('<svg><use href="#remote"/></svg>')).toBeUndefined();
    expect(safeArtboardPreviewSvg('<svg><image href="data:image/svg+xml;base64,AAAA"/></svg>')).toBeUndefined();
  });
});
