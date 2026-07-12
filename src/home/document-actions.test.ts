import { describe, expect, it } from "vitest";
import { emptySession, reduceSession } from "./session";
import { catalogRecordToDocument, newOperationId, operationIdForDuplicateAttempt, reconcileSessionWithCatalog, removeDocumentEverywhere, replaceDocumentEverywhere, validateDocumentName } from "./document-actions";

const flow = catalogRecordToDocument({ id: "flow", kind: "flow", name: "Flow", revision: 3, fingerprint: "abc", health: "healthy", updatedAt: "2026-07-12T10:00:00Z" });
const board = catalogRecordToDocument({ id: "board", kind: "artboard", name: "Board", revision: 2, health: "healthy", updatedAt: "2026-07-12T11:00:00Z" });

describe("document catalog action state", () => {
  it("normalizes backend records without inventing an invalid revision", () => {
    expect(flow).toMatchObject({ kind: "flow", revision: 3, contentFingerprint: "abc", health: { state: "healthy" } });
    expect(catalogRecordToDocument({ id: "bad", kind: "artboard", health: "corrupt" }).health).toEqual({ state: "corrupt", reason: "Das Artboard-Dokument ist beschädigt." });
  });

  it("renames catalog and open tab together and removes a deleted active tab", () => {
    let session = reduceSession(emptySession(), { type: "open", document: flow, at: flow.updatedAt });
    const renamed = { ...flow, name: "Neu", revision: 4 };
    const replacement = replaceDocumentEverywhere([flow, board], session, renamed);
    expect(replacement.catalog[0].name).toBe("Neu");
    expect(replacement.session.openDocuments[0].name).toBe("Neu");
    session = reduceSession(replacement.session, { type: "open", document: board, at: board.updatedAt });
    const removed = removeDocumentEverywhere(replacement.catalog, session, "board");
    expect(removed.catalog.map((item) => item.id)).toEqual(["flow"]);
    expect(removed.session.active).toEqual({ surface: "document", documentId: "flow" });
  });

  it("reconciles tabs after a reference-aware backend delete and validates dialog names", () => {
    const session = reduceSession(reduceSession(emptySession(), { type: "open", document: flow, at: flow.updatedAt }), { type: "open", document: board, at: board.updatedAt });
    expect(reconcileSessionWithCatalog(session, [{ ...flow, name: "Aktualisiert" }])).toMatchObject({ active: { surface: "home" }, openDocuments: [{ documentId: "flow", name: "Aktualisiert" }] });
    expect(validateDocumentName("   ")).toBeTruthy();
    expect(validateDocumentName("Guter Name")).toBeUndefined();
    expect(newOperationId()).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("reuses a duplicate operation id only for an identical retry payload", () => {
    const previous = { operationId: "stable", name: "Kopie", revision: 3 };
    expect(operationIdForDuplicateAttempt(previous, { name: "Kopie", revision: 3 }, () => "new")).toBe("stable");
    expect(operationIdForDuplicateAttempt(previous, { name: "Andere Kopie", revision: 3 }, () => "new")).toBe("new");
    expect(operationIdForDuplicateAttempt(previous, { name: "Kopie", revision: 4 }, () => "new")).toBe("new");
  });
});
