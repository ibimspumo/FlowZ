import type { JsonValue } from './project';

export type ScalarValueType = 'text' | 'image' | 'video' | 'audio' | 'webpage' | 'json';

export type ValueType =
  | { kind: 'scalar'; scalar: ScalarValueType }
  | { kind: 'list'; item: ScalarValueType };

export type TextValue = { type: 'text'; value: string };
export type MediaValue = {
  type: 'image' | 'video' | 'audio';
  assetId: string;
  mimeType?: string;
};
export type WebpageValue = { type: 'webpage'; url: string; title?: string };
export type JsonScalarValue = { type: 'json'; value: JsonValue };

export type ScalarValue = TextValue | MediaValue | WebpageValue | JsonScalarValue;

/** Runtime-only data. RuntimeValue must never be embedded in ProjectDocument. */
export type RuntimeValue =
  | { kind: 'scalar'; value: ScalarValue }
  | { kind: 'list'; itemType: ScalarValueType; items: ScalarValue[] };

export type InputCardinality = 'one' | 'many';

export const scalarType = (scalar: ScalarValueType): ValueType => ({ kind: 'scalar', scalar });
export const listType = (item: ScalarValueType): ValueType => ({ kind: 'list', item });

const SCALAR_VALUE_TYPES: ReadonlySet<string> = new Set(['text', 'image', 'video', 'audio', 'webpage', 'json']);

export function isScalarValueType(value: unknown): value is ScalarValueType {
  return typeof value === 'string' && SCALAR_VALUE_TYPES.has(value);
}

export function isValueType(value: unknown): value is ValueType {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { kind?: unknown; scalar?: unknown; item?: unknown };
  return candidate.kind === 'scalar'
    ? isScalarValueType(candidate.scalar)
    : candidate.kind === 'list' && isScalarValueType(candidate.item);
}

export function runtimeValueType(value: RuntimeValue): ValueType {
  return value.kind === 'scalar'
    ? { kind: 'scalar', scalar: value.value.type }
    : { kind: 'list', item: value.itemType };
}

export function isScalarValue(value: unknown, expectedType?: ScalarValueType): value is ScalarValue {
  if (!isPlainRecord(value) || typeof value.type !== 'string') return false;
  const candidate = value as Record<string, unknown>;
  if (expectedType && candidate.type !== expectedType) return false;
  if (candidate.type === 'text') return hasOnlyKeys(candidate, ['type', 'value']) && typeof candidate.value === 'string';
  if (candidate.type === 'image' || candidate.type === 'video' || candidate.type === 'audio') {
    return hasOnlyKeys(candidate, ['type', 'assetId', 'mimeType'])
      && typeof candidate.assetId === 'string' && candidate.assetId.trim().length > 0
      && (candidate.mimeType === undefined || typeof candidate.mimeType === 'string');
  }
  if (candidate.type === 'webpage') {
    return hasOnlyKeys(candidate, ['type', 'url', 'title'])
      && typeof candidate.url === 'string' && candidate.url.trim().length > 0
      && (candidate.title === undefined || typeof candidate.title === 'string');
  }
  return candidate.type === 'json' && hasOnlyKeys(candidate, ['type', 'value']) && 'value' in candidate && isJsonValue(candidate.value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isPlainRecord(value) && Object.values(value).every(isJsonValue);
}

export function isRuntimeValue(value: unknown): value is RuntimeValue {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, value.kind === 'scalar' ? ['kind', 'value'] : ['kind', 'itemType', 'items'])) return false;
  const candidate = value as { kind?: unknown; value?: unknown; itemType?: unknown; items?: unknown };
  if (candidate.kind === 'scalar') return isScalarValue(candidate.value);
  if (candidate.kind !== 'list' || !isScalarValueType(candidate.itemType) || !Array.isArray(candidate.items)) return false;
  const itemType = candidate.itemType;
  return candidate.items.every((item) => isScalarValue(item, itemType));
}

export function listValue<T extends ScalarValueType>(itemType: T, items: ScalarValue[]): RuntimeValue {
  if (!items.every((item) => isScalarValue(item, itemType))) {
    throw new TypeError(`List contains an item that is not ${itemType}`);
  }
  return { kind: 'list', itemType, items };
}
