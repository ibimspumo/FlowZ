import type { JsonValue } from '../domain/project';
import type { RuntimeValue, ScalarValue, ScalarValueType } from '../domain/values';
import { isScalarValue, listValue } from '../domain/values';

export type DurableListItem = {
  resultId: string;
  type: ScalarValueType;
  contentIdentity: string;
};
export type DurableListManifest = { version: 1; itemType: ScalarValueType; items: DurableListItem[] };

/** Project JSON stores identities only. Payload bytes/text remain in the result library. */
export function createListManifest(itemType: ScalarValueType, items: readonly DurableListItem[]): DurableListManifest {
  if (items.some((item) => item.type !== itemType || !item.resultId.trim() || !item.contentIdentity.trim())) throw new TypeError('Ungültige oder gemischte Listenmanifest-Einträge.');
  return { version: 1, itemType, items: items.map((item) => ({ ...item })) };
}

export function listManifestToJson(manifest: DurableListManifest): JsonValue {
  return { version: manifest.version, itemType: manifest.itemType, items: manifest.items.map((item) => ({ ...item })) };
}

export async function reloadListManifest(manifest: DurableListManifest, load: (resultId: string) => Promise<ScalarValue | undefined>): Promise<RuntimeValue> {
  const loaded = await Promise.all(manifest.items.map((item) => load(item.resultId)));
  if (loaded.some((value) => !value)) throw new Error('Mindestens ein kuratiertes Listenelement ist nicht mehr verfügbar.');
  if (loaded.some((value) => !isScalarValue(value, manifest.itemType))) throw new Error('Ein gespeichertes Listenelement hat nicht mehr den erwarteten Typ.');
  return listValue(manifest.itemType, loaded as ScalarValue[]);
}

/** Deliberate fan-out keeps stable result IDs; a list is never silently coerced to its first item. */
export function fanOutList(manifest: DurableListManifest, value: RuntimeValue): ReadonlyArray<{ handleId: string; resultId: string; value: RuntimeValue }> {
  if (value.kind !== 'list' || value.itemType !== manifest.itemType || value.items.length !== manifest.items.length) throw new TypeError('Listenmanifest und Laufzeitwert passen nicht zusammen.');
  return value.items.map((item, index) => ({ handleId: `item:${manifest.items[index].resultId}`, resultId: manifest.items[index].resultId, value: { kind: 'scalar', value: item } }));
}
