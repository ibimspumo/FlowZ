import { describe, expect, it } from "vitest";
import { activeFlowWorkspaceId, appShortcut, boundedSession, cycledTarget, flowSummaryToDocument, HOME_SESSION_STORAGE_KEY, loadStoredSession, persistStoredSession } from "./app-shell";
import { emptySession, reduceSession } from "./session";
import { emptyViewState, type AppSession, type DocumentRecord } from "./types";

const flow = (id: string): DocumentRecord => ({ id, kind: "flow", schemaVersion: 1, name: id, createdAt: "2026-07-12T08:00:00Z", updatedAt: "2026-07-12T09:00:00Z", revision: 1, contentFingerprint: id, health: { state: "healthy" } });

describe("home app shell orchestration", () => {
  it("starts at Home, deduplicates opening and closing a tab never removes the catalog document", () => {
    const catalog = [flow("one")];
    let session = emptySession();
    expect(session.active).toEqual({ surface: "home" });
    session = reduceSession(session, { type: "open", document: catalog[0], at: catalog[0].updatedAt });
    session = reduceSession(session, { type: "open", document: catalog[0], at: catalog[0].updatedAt });
    expect(session.openDocuments).toHaveLength(1);
    session = reduceSession(session, { type: "close", documentId: "one" });
    expect(session.openDocuments).toHaveLength(0);
    expect(catalog).toHaveLength(1);
  });

  it("maps health honestly and retains at most eight mounted document descriptors", () => {
    expect(flowSummaryToDocument({ id: "bad", diagnosis: "corrupt", message: "broken" }).health).toEqual({ state: "corrupt", reason: "broken" });
    const tabs = Array.from({ length: 10 }, (_, index) => ({ documentId: String(index), kind: "flow" as const, name: String(index), saveState: "saved" as const, viewState: emptyViewState("flow"), lastActiveAt: `2026-07-12T${String(index).padStart(2, "0")}:00:00Z` }));
    const bounded = boundedSession({ schemaVersion: 1, openDocuments: tabs, active: { surface: "document", documentId: "9" } });
    expect(bounded.openDocuments.map((tab) => tab.documentId)).toEqual(["2", "3", "4", "5", "6", "7", "8", "9"]);
  });

  it("persists one bounded JSON value and restores only catalog-backed tabs", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const document = flow("one");
    const session = reduceSession(emptySession(), { type: "open", document, at: document.updatedAt });
    expect(persistStoredSession(storage, session)).toBe(true);
    expect(values.has(HOME_SESSION_STORAGE_KEY)).toBe(true);
    expect(loadStoredSession(storage, [document])).toEqual({ ...session, active: { surface: "home" } });
    expect(loadStoredSession(storage, [])).toEqual(emptySession());
  });

  it("maps shell shortcuts without intercepting unrelated combinations", () => {
    const keyboard = (key: string, metaKey = false, ctrlKey = false, shiftKey = false) => appShortcut({ key, metaKey, ctrlKey, shiftKey, altKey: false });
    expect(keyboard("1", true)).toEqual({ type: "activate-home" });
    expect(keyboard("2", true)).toEqual({ type: "activate-tab", index: 0 });
    expect(keyboard("Tab", false, true, true)).toEqual({ type: "cycle-tabs", direction: -1 });
    expect(keyboard("w", true)).toEqual({ type: "close-active" });
    expect(keyboard("n", true)).toEqual({ type: "new-flow" });
    expect(keyboard("n")).toBeUndefined();
  });

  it("cycles across Home and documents while only identifying one active target", () => {
    const documents = [flow("one"), flow("two")];
    let session: AppSession = emptySession();
    for (const document of documents) session = reduceSession(session, { type: "open", document, at: document.updatedAt });
    expect(cycledTarget(session, 1)).toEqual({ surface: "home" });
    expect(cycledTarget({ ...session, active: { surface: "home" } }, 1)).toEqual({ surface: "document", documentId: "one" });
    expect(activeFlowWorkspaceId(session)).toBe("two");
    expect(activeFlowWorkspaceId({ ...session, active: { surface: "home" } })).toBeUndefined();
  });
});
