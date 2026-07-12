import { describe, expect, it } from "vitest";
import { selectCatalog, upsertCatalogRecord } from "./catalog";
import { createFlowCoverModel, LatestCoverJob } from "./flow-cover";
import { emptySession, reduceSession, restoreSession } from "./session";
import { emptyViewState, hasCurrentCover, type DocumentRecord, type DocumentTab } from "./types";

const record = (id: string, kind: "flow" | "artboard" = "flow", index = 0): DocumentRecord => ({
  id,
  kind,
  schemaVersion: 1,
  name: `${kind === "flow" ? "Flow" : "Artboard"} ${index}`,
  createdAt: "2026-07-12T10:00:00.000Z",
  updatedAt: new Date(Date.UTC(2026, 6, 12, 10, index)).toISOString(),
  lastOpenedAt: new Date(Date.UTC(2026, 6, 12, 9, index)).toISOString(),
  revision: 1,
  contentFingerprint: `fingerprint-${id}`,
  health: { state: "healthy" },
});

describe("home catalog foundation", () => {
  it("filters and sorts a large lightweight catalog without loading document payloads", () => {
    const records = Array.from({ length: 500 }, (_, index) => record(`document-${index}`, index % 2 ? "flow" : "artboard", index));
    const result = selectCatalog(records, { search: "Flow", filter: "flow", sort: "updated" });
    expect(result).toHaveLength(250);
    expect(result[0].updatedAt >= result.at(-1)!.updatedAt).toBe(true);
    expect(records[0].id).toBe("document-0");
  });

  it("keeps document identity and kind stable when catalog records are updated", () => {
    const flow = record("one");
    expect(upsertCatalogRecord([flow], { ...flow, name: "Neu", revision: 2 })[0].name).toBe("Neu");
    expect(() => upsertCatalogRecord([flow], { ...flow, kind: "artboard" })).toThrow(/Dokumenttyp/);
  });

  it("accepts a cover only for the exact document fingerprint", () => {
    const flow = record("one");
    const cover = { blobHash: "a".repeat(64), contentFingerprint: flow.contentFingerprint, width: 512, height: 320, mediaType: "image/webp" as const, generatedAt: flow.updatedAt };
    expect(hasCurrentCover({ ...flow, cover })).toBe(true);
    expect(hasCurrentCover({ ...flow, cover: { ...cover, contentFingerprint: "old" } })).toBe(false);
  });
});

describe("document session", () => {
  it("deduplicates tabs, preserves typed view state and close never deletes a document", () => {
    const flow = record("flow-1");
    let session = reduceSession(emptySession(), { type: "open", document: flow, at: flow.updatedAt });
    session = reduceSession(session, { type: "open", document: flow, at: flow.lastOpenedAt! });
    expect(session.openDocuments).toHaveLength(1);
    const view = { ...emptyViewState("flow"), viewport: { x: 20, y: -10, zoom: 1.4 } };
    session = reduceSession(session, { type: "update-view", documentId: flow.id, viewState: view });
    expect(session.openDocuments[0].viewState).toEqual(view);
    session = reduceSession(session, { type: "close", documentId: flow.id });
    expect(session).toEqual(emptySession());
  });

  it("fails closed when a dirty, saving or failed tab is closed", () => {
    const flow = record("flow-1");
    for (const saveState of ["dirty", "saving", "error"] as const) {
      let session = reduceSession(emptySession(), { type: "open", document: flow, at: flow.updatedAt });
      session = reduceSession(session, { type: "save-state", documentId: flow.id, saveState });
      expect(reduceSession(session, { type: "close", documentId: flow.id })).toBe(session);
      expect(reduceSession(session, { type: "close", documentId: flow.id, discardDirty: true }).openDocuments).toHaveLength(saveState === "saving" ? 1 : 0);
    }
  });

  it("restores at most eight recent healthy documents and skips missing or corrupt ones", () => {
    const catalog = Array.from({ length: 12 }, (_, index) => record(`document-${index}`, index % 2 ? "flow" : "artboard", index));
    catalog[2] = { ...catalog[2], health: { state: "corrupt", reason: "test" } };
    const openDocuments: DocumentTab[] = catalog.map((document) => ({ documentId: document.id, kind: document.kind, name: document.name, saveState: "dirty", viewState: emptyViewState(document.kind), lastActiveAt: document.updatedAt }));
    openDocuments.push({ documentId: "missing", kind: "flow", name: "Missing", saveState: "saved", viewState: emptyViewState("flow"), lastActiveAt: "2026-07-12T12:00:00.000Z" });
    const restored = restoreSession({ schemaVersion: 1, openDocuments, active: { surface: "document", documentId: "missing" } }, catalog);
    expect(restored.session.openDocuments).toHaveLength(8);
    expect(restored.session.openDocuments.every((tab) => tab.saveState === "recovery-required")).toBe(true);
    expect(restored.session.active).toEqual({ surface: "home" });
    expect(restored.skippedDocumentIds).toEqual(expect.arrayContaining(["document-2", "missing"]));
  });

  it("ignores corrupt session roots and rejects cross-kind view state", () => {
    expect(restoreSession({ schemaVersion: 99 }, [record("flow-1")]).session).toEqual(emptySession());
    const flow = record("flow-1");
    expect(restoreSession({ schemaVersion: 1, openDocuments: [{ documentId: flow.id, kind: "flow", name: flow.name, saveState: "saved", viewState: { kind: "flow", viewport: { x: "bad", y: 0, zoom: 1 } }, lastActiveAt: flow.updatedAt }], active: { surface: "home" } }, [flow]).session.openDocuments).toEqual([]);
    const session = reduceSession(emptySession(), { type: "open", document: flow, at: flow.updatedAt });
    expect(() => reduceSession(session, { type: "update-view", documentId: flow.id, viewState: emptyViewState("artboard") })).toThrow(/Ansichtszustand/);
  });
});

describe("lightweight flow cover", () => {
  it("is deterministic and ignores edges whose nodes do not exist", () => {
    const input = { nodes: [{ id: "b", x: 200, y: 30, width: 100, height: 80, color: "#00AAAA" }, { id: "a", x: 0, y: 0, width: 100, height: 80, color: "#AA00AA" }], edges: [{ sourceId: "a", targetId: "b", color: "#FFFFFF" }, { sourceId: "missing", targetId: "b", color: "#FFFFFF" }], groups: [] };
    const first = createFlowCoverModel(input);
    const second = createFlowCoverModel({ ...input, nodes: input.nodes.slice().reverse() });
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.edges).toHaveLength(1);
    expect(first.viewBox).toEqual({ x: -32, y: -32, width: 364, height: 174 });
  });

  it("uses complete tie breakers for parallel edges and identical groups", () => {
    const base = { nodes: [{ id: "a", x: 0, y: 0, width: 100, height: 80, color: "#111111" }, { id: "b", x: 200, y: 0, width: 100, height: 80, color: "#222222" }], edges: [{ sourceId: "a", targetId: "b", color: "#FFFFFF" }, { sourceId: "a", targetId: "b", color: "#00FFFF" }], groups: [{ x: 0, y: 0, width: 300, height: 100, color: "#FF00FF" }, { x: 0, y: 0, width: 300, height: 100, color: "#00FFFF" }] };
    const reversed = { nodes: base.nodes, edges: base.edges.slice().reverse(), groups: base.groups.slice().reverse() };
    expect(createFlowCoverModel(base).fingerprint).toBe(createFlowCoverModel(reversed).fingerprint);
  });

  it("makes stale asynchronous cover jobs lose latest-wins arbitration", () => {
    const jobs = new LatestCoverJob();
    const first = jobs.begin();
    const second = jobs.begin();
    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);
    jobs.cancel();
    expect(second.isCurrent()).toBe(false);
  });
});
