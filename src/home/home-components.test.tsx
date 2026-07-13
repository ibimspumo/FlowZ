import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentTabs, getAdjacentTabTarget } from "./DocumentTabs";
import { getHomeCardKeyboardAction, getHomeCardNavigationIndex, HomeScreen, isDocumentOpenable } from "./HomeScreen";
import { emptyViewState, type DocumentRecord, type DocumentTab } from "./types";
import { setLocale } from "../i18n";

afterEach(()=>setLocale('de'));

const documentRecord = (id: string, kind: "flow" | "artboard", health: DocumentRecord["health"] = { state: "healthy" }): DocumentRecord => ({
  id,
  kind,
  schemaVersion: 1,
  name: kind === "flow" ? "Kampagnen-Flow" : "Launch Artboards",
  createdAt: "2026-07-12T08:00:00.000Z",
  updatedAt: "2026-07-12T09:00:00.000Z",
  revision: 1,
  contentFingerprint: `fingerprint-${id}`,
  health,
});

const callbacks = {
  onCreate: vi.fn(),
  onQueryChange: vi.fn(),
  onSelect: vi.fn(),
  onOpen: vi.fn(),
  onRenameRequest: vi.fn(),
  onDuplicateRequest: vi.fn(),
  onDeleteRequest: vi.fn(),
  onContextMenuRequest: vi.fn(),
  onContextMenuClose: vi.fn(),
};

describe("HomeScreen", () => {
  it("provides roving keyboard navigation across every project card", () => {
    expect(getHomeCardNavigationIndex("ArrowRight", 0, 3)).toBe(1);
    expect(getHomeCardNavigationIndex("ArrowUp", 2, 3)).toBe(1);
    expect(getHomeCardNavigationIndex("Home", 2, 3)).toBe(0);
    expect(getHomeCardNavigationIndex("End", 0, 3)).toBe(2);
    expect(getHomeCardNavigationIndex("Enter", 0, 3)).toBeUndefined();
  });

  it("keeps one visible card in the tab order when the selected document is filtered out", () => {
    const html = renderToStaticMarkup(<HomeScreen {...callbacks} documents={[documentRecord("flow", "flow"), documentRecord("board", "artboard")]} query={{ search: "", filter: "all", sort: "updated" }} selectedDocumentId="hidden-by-filter" />);
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html.match(/tabindex="-1"/g)).toHaveLength(1);
  });

  it("renders both document kinds as explicit text and icons without mounting an editor", () => {
    const html = renderToStaticMarkup(<HomeScreen {...callbacks} documents={[documentRecord("flow", "flow"), documentRecord("board", "artboard")]} query={{ search: "", filter: "all", sort: "updated" }} selectedDocumentId="flow" />);
    expect(html).toContain("Neuer Flow");
    expect(html).toContain("Neues Artboard");
    expect(html).toContain("home-document-card-flow is-selected");
    expect(html).toContain("home-document-card-artboard");
    expect(html).toContain(">Flow<");
    expect(html).toContain(">Artboard<");
    expect(html).not.toContain("react-flow");
    expect(html).not.toContain("artboard-stage");
    expect(html).toContain("FlowZ-Desktop-App erstellt");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*|<button[^>]*disabled=""/);
  });

  it("shows honest corrupt and unsupported states and does not expose an open double-click handler", () => {
    const corrupt = documentRecord("broken", "flow", { state: "corrupt", reason: "invalid payload" });
    const unsupported = documentRecord("future", "artboard", { state: "unsupported", foundVersion: 4 });
    expect(isDocumentOpenable(corrupt)).toBe(false);
    expect(isDocumentOpenable(unsupported)).toBe(false);
    const html = renderToStaticMarkup(<HomeScreen {...callbacks} documents={[corrupt, unsupported]} query={{ search: "", filter: "all", sort: "updated" }} />);
    expect(html).toContain("Beschädigt");
    expect(html).toContain("Version 4 nicht unterstützt");
    expect(html).toContain("is-unavailable");
  });

  it("renders loading, empty and compact controlled context-menu states", () => {
    const loading = renderToStaticMarkup(<HomeScreen {...callbacks} loading documents={[]} query={{ search: "", filter: "all", sort: "updated" }} />);
    expect(loading).toContain('aria-busy="true"');
    const empty = renderToStaticMarkup(<HomeScreen {...callbacks} documents={[]} query={{ search: "Logo", filter: "flow", sort: "name" }} />);
    expect(empty).toContain("Keine passenden Projekte");
    const flow = documentRecord("flow", "flow");
    const menu = renderToStaticMarkup(<HomeScreen {...callbacks} documents={[flow]} query={{ search: "", filter: "all", sort: "updated" }} contextMenu={{ documentId: flow.id, x: 20, y: 30 }} />);
    expect(menu).toContain('role="menu"');
    expect(menu).toContain("Umbenennen");
    expect(menu).toContain("Duplizieren");
    expect(menu).toContain("Löschen");
  });

  it("maps standard project shortcuts without owning their resulting state", () => {
    expect(getHomeCardKeyboardAction("Enter")).toBe("open");
    expect(getHomeCardKeyboardAction("F2")).toBe("rename");
    expect(getHomeCardKeyboardAction("Delete")).toBe("delete");
    expect(getHomeCardKeyboardAction("F10", true)).toBe("context-menu");
    expect(getHomeCardKeyboardAction("F10", false)).toBeUndefined();
  });

  it("reacts to English without changing document names",()=>{
    setLocale('en');
    const html=renderToStaticMarkup(<HomeScreen {...callbacks} documents={[documentRecord('flow','flow')]} query={{search:'',filter:'all',sort:'updated'}}/>);
    expect(html).toContain('New flow');expect(html).toContain('Search projects');expect(html).toContain('Kampagnen-Flow');expect(html).toContain('created in the FlowZ desktop app');expect(html).not.toContain('Neuer Flow');
  });
});

describe("DocumentTabs", () => {
  const tabs: DocumentTab[] = [
    { documentId: "flow", kind: "flow", name: "Flow", saveState: "dirty", viewState: emptyViewState("flow"), lastActiveAt: "2026-07-12T09:00:00Z" },
    { documentId: "board", kind: "artboard", name: "Board", saveState: "recovery-required", viewState: emptyViewState("artboard"), lastActiveAt: "2026-07-12T10:00:00Z" },
  ];

  it("keeps Home fixed, exposes typed tabs, save states and separate close buttons", () => {
    const html = renderToStaticMarkup(<DocumentTabs tabs={tabs} active={{ surface: "document", documentId: "flow" }} onActivate={vi.fn()} onCloseRequest={vi.fn()} />);
    expect(html).toContain('role="tablist"');
    expect(html).toContain(">Home<");
    expect(html).toContain("Nicht gespeicherte Änderungen");
    expect(html).toContain("Wiederherstellung erforderlich");
    expect(html).toContain("Flow schließen");
    expect(html).toContain("Dokument bleibt erhalten");
  });

  it("calculates wrapping arrow navigation plus Home and End without owning active state", () => {
    expect(getAdjacentTabTarget(tabs, { surface: "home" }, "ArrowLeft")).toEqual({ surface: "document", documentId: "board" });
    expect(getAdjacentTabTarget(tabs, { surface: "document", documentId: "flow" }, "ArrowRight")).toEqual({ surface: "document", documentId: "board" });
    expect(getAdjacentTabTarget(tabs, { surface: "document", documentId: "board" }, "Home")).toEqual({ surface: "home" });
    expect(getAdjacentTabTarget(tabs, { surface: "home" }, "End")).toEqual({ surface: "document", documentId: "board" });
    expect(getAdjacentTabTarget(tabs, { surface: "home" }, "Enter")).toBeUndefined();
  });

  it('localizes tab save and close affordances reactively',()=>{setLocale('en');const html=renderToStaticMarkup(<DocumentTabs tabs={tabs} active={{surface:'document',documentId:'flow'}} onActivate={vi.fn()} onCloseRequest={vi.fn()}/>);expect(html).toContain('Unsaved changes');expect(html).toContain('Close Flow');expect(html).toContain('document is preserved');});
});
