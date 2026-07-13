import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { ARTBOARD_DOCUMENT_VERSION, ARTBOARD_WORKSPACE_VERSION, type ArtboardWorkspace as Workspace } from "../nodes/brand/artboard-domain";
import { ArtboardWorkspace, shouldHandleArtboardCanvasShortcut } from "./ArtboardWorkspace";
import { clampLayerGeometry, compareBoardIds, operationBatch, orderedBoardSelection, releaseGesturePreview, updateGesturePreview } from "./operations";
import { setLocale } from "../i18n";

afterEach(()=>setLocale('de'));

const board = (id: string) => ({
  id, name: `Board ${id}`, activeRevisionId: `revision-${id}`,
  document: { schemaVersion: ARTBOARD_DOCUMENT_VERSION, id: `document-${id}`, name: `Board ${id}`, format: { preset: "instagram-post" as const, width: 1080, height: 1080 }, paint: { kind: "solid" as const, color: "#FFFFFF" }, rootLayerIds: ["text"], layers: { text: { id: "text", type: "text" as const, name: "Headline", locked: false, visible: true, version: 1, geometry: { x: 80, y: 80, width: 800, height: 200, rotation: 0 }, text: "FlowZ", color: "#111111", fontSize: 90, align: "left" as const } }, bindings: {}, tokenRefs: {} },
  inputSnapshot: { id: `snapshot-${id}`, createdAt: "2026-07-12T12:00:00.000Z", bindings: {} }, ancestry: { branchId: "branch-main" }, createdAt: "2026-07-12T12:00:00.000Z",
});

const workspace: Workspace = { schemaVersion: ARTBOARD_WORKSPACE_VERSION, id: "workspace-1", name: "Launch Campaign", boards: { a: board("a"), b: board("b") }, placements: { a: { x: 100, y: 100 }, b: { x: 1400, y: 100 } }, selectedBoardIds: ["a", "b"], activeBoardId: "a", pasteboard: { margin: 100, gap: 220, grid: 20 } };

describe("artboard workspace UI foundation", () => {
  it("leaves Tab and interactive controls to the browser focus order", () => {
    expect(shouldHandleArtboardCanvasShortcut("Tab", true, false)).toBe(false);
    expect(shouldHandleArtboardCanvasShortcut("ArrowRight", true, true)).toBe(false);
    expect(shouldHandleArtboardCanvasShortcut("ArrowRight", false, false)).toBe(false);
    expect(shouldHandleArtboardCanvasShortcut("ArrowRight", true, false)).toBe(true);
  });
  it("keeps active board separate from ordered multi-selection", () => {
    expect(orderedBoardSelection(workspace, "a", true)).toEqual({ activeBoardId: "b", selectedBoardIds: ["b"] });
    expect(orderedBoardSelection({ ...workspace, selectedBoardIds: ["a"] }, "b", true)).toEqual({ activeBoardId: "b", selectedBoardIds: ["a", "b"] });
    expect(compareBoardIds(workspace)).toEqual(["a", "b"]);
  });

  it("emits revision-safe operation envelopes", () => {
    const batch = operationBatch({ id: "revision-a", number: 4 }, [{ type: "rename-workspace", name: "Next" }]);
    expect(batch.expectedRevisionId).toBe("revision-a");
    expect(batch.expectedRevisionNumber).toBe(4);
    expect(batch.operationId).toMatch(/^manual-/);
  });

  it("clamps manual layer changes to the board", () => {
    const layer = workspace.boards.a.document.layers.text;
    expect(clampLayerGeometry(layer, { x: 1000, y: -20, width: 500 }, { width: 1080, height: 1080 })).toMatchObject({ x: 580, y: 0, width: 500 });
  });

  it("keeps a long drag local and persists exactly its final state on release", () => {
    let preview: Parameters<typeof updateGesturePreview>[0];
    for (let index = 0; index < 100; index += 1) {
      preview = updateGesturePreview(preview, { type: "move-board", boardId: "a", x: index * 20, y: 100 });
      expect(releaseGesturePreview(undefined)).toEqual([]);
    }
    expect(releaseGesturePreview(preview)).toEqual([{ type: "move-board", boardId: "a", x: 1980, y: 100 }]);
  });

  it("renders product controls, panels and boards without a placeholder agent", () => {
    const html = renderToStaticMarkup(<ArtboardWorkspace workspace={workspace} revision={{ id: "revision-a", number: 1 }} onBack={() => undefined} onApplyOperations={() => undefined} onSelectionChange={() => undefined} onCreateBoard={() => undefined} onDuplicateBoard={() => undefined} onCreateVariant={() => undefined} onIgnoreUpstreamUpdate={() => undefined} onUpdateBoardInputs={() => undefined} onUndo={() => undefined} onRedo={() => undefined} onExport={() => undefined} />);
    expect(html).toContain("Zum Start");
    expect(html).toContain("Artboard-Werkzeuge");
    expect(html).toContain("Board a");
    expect(html).toContain('accept="image/*"');
    expect(html).toContain("Artboard entfernen");
    expect(html).not.toContain("Agent-Modell und Einstellungen");
    expect(html).not.toContain("dialog");
  });

  it('renders English UI chrome while preserving board content',()=>{setLocale('en');const html=renderToStaticMarkup(<ArtboardWorkspace workspace={workspace} revision={{id:'revision-a',number:1}} onBack={()=>undefined} onApplyOperations={()=>undefined} onSelectionChange={()=>undefined} onCreateBoard={()=>undefined} onDuplicateBoard={()=>undefined} onCreateVariant={()=>undefined} onIgnoreUpstreamUpdate={()=>undefined} onUpdateBoardInputs={()=>undefined} onUndo={()=>undefined} onRedo={()=>undefined} onExport={()=>undefined}/>);expect(html).toContain('Back to home');expect(html).toContain('Artboard tools');expect(html).toContain('Board a');});

  it("disables removal when only the final board remains", () => {
    const one = { ...workspace, boards: { a: workspace.boards.a }, placements: { a: workspace.placements.a }, activeBoardId: "a", selectedBoardIds: ["a"] };
    const html = renderToStaticMarkup(<ArtboardWorkspace workspace={one} revision={{id:"revision-a",number:1}} onBack={()=>undefined} onApplyOperations={()=>undefined} onSelectionChange={()=>undefined} onCreateBoard={()=>undefined} onDuplicateBoard={()=>undefined} onCreateVariant={()=>undefined} onIgnoreUpstreamUpdate={()=>undefined} onUpdateBoardInputs={()=>undefined} onUndo={()=>undefined} onRedo={()=>undefined} onExport={()=>undefined}/>);
    expect(html).toMatch(/disabled=""[^>]*title="Das letzte Artboard kann nicht entfernt werden\.|title="Das letzte Artboard kann nicht entfernt werden\."[^>]*disabled=""/);
  });
});
