import type { DocumentKind, DocumentRecord } from "./types";

export type CatalogFilter = "all" | DocumentKind;
export type CatalogSort = "updated" | "name" | "opened";

export type CatalogQuery = {
  search: string;
  filter: CatalogFilter;
  sort: CatalogSort;
};

const normalized = (value: string) => value.trim().toLocaleLowerCase();
const timestamp = (value?: string) => value ? Date.parse(value) || 0 : 0;

export function selectCatalog(records: readonly DocumentRecord[], query: CatalogQuery): DocumentRecord[] {
  const needle = normalized(query.search);
  return records
    .filter((record) => query.filter === "all" || record.kind === query.filter)
    .filter((record) => !needle || normalized(record.name).includes(needle))
    .slice()
    .sort((left, right) => {
      if (query.sort === "name") return left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true }) || left.id.localeCompare(right.id);
      const leftTime = query.sort === "opened" ? timestamp(left.lastOpenedAt) : timestamp(left.updatedAt);
      const rightTime = query.sort === "opened" ? timestamp(right.lastOpenedAt) : timestamp(right.updatedAt);
      return rightTime - leftTime || left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
    });
}

export interface DocumentCatalogRepository {
  list(): Promise<readonly DocumentRecord[]>;
  create(kind: DocumentKind, name: string): Promise<DocumentRecord>;
  rename(documentId: string, expectedRevision: number, name: string): Promise<DocumentRecord>;
  duplicate(documentId: string, expectedRevision: number): Promise<DocumentRecord>;
  delete(documentId: string, expectedRevision: number): Promise<void>;
}

export function upsertCatalogRecord(records: readonly DocumentRecord[], next: DocumentRecord): DocumentRecord[] {
  const index = records.findIndex((record) => record.id === next.id);
  if (index < 0) return [...records, next];
  if (records[index].kind !== next.kind) throw new Error("Ein Dokumenttyp darf sich nicht ändern.");
  const copy = records.slice();
  copy[index] = next;
  return copy;
}
