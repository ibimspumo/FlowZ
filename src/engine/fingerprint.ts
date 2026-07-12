import type { JsonValue } from '../domain/project';

function canonicalize(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Fingerprints only support finite numbers');
    return Object.is(value, -0) ? '0' : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('Cannot fingerprint cyclic data');
    seen.add(value);
    const result = `[${value.map((item) => canonicalize(item, seen)).join(',')}]`;
    seen.delete(value);
    return result;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) throw new TypeError('Cannot fingerprint cyclic data');
    seen.add(value);
    const record = value as Record<string, unknown>;
    const result = `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key], seen)}`).join(',')}}`;
    seen.delete(value);
    return result;
  }
  throw new TypeError(`Unsupported fingerprint value: ${typeof value}`);
}

export function canonicalStringify(value: JsonValue | Record<string, unknown>): string {
  return canonicalize(value, new WeakSet());
}

export async function sha256Fingerprint(value: JsonValue | Record<string, unknown>): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalStringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export type FingerprintBinding = {
  edgeId: string;
  sourceNodeId: string;
  sourcePortId: string;
  targetNodeId: string;
  targetPortId: string;
  order: number;
  activeResultId: string;
  outputId: string;
  /** Exactly one non-empty content identity. Empty lists use an inline hash of their canonical value. */
  contentIdentity:
    | { kind: 'inlineHash'; inlineHash: string }
    | { kind: 'blobHash'; blobHash: string }
    | { kind: 'orderedItemHashes'; itemHashes: readonly [string, ...string[]] };
};

export type NodeFingerprintInput = {
  moduleId: string;
  moduleVersion: number;
  config: Record<string, JsonValue>;
  provider?: string;
  model?: string;
  bindings: readonly FingerprintBinding[];
};

export function createNodeFingerprintPayload(input: NodeFingerprintInput): Record<string, JsonValue> {
  const compareCodePoints = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
  for (const binding of input.bindings) {
    const identity = binding.contentIdentity;
    if (!identity || typeof identity !== 'object') throw new TypeError('Fingerprint content identity is required');
    const hashes = identity.kind === 'inlineHash' ? [identity.inlineHash]
      : identity.kind === 'blobHash' ? [identity.blobHash]
        : identity.kind === 'orderedItemHashes' && Array.isArray(identity.itemHashes) ? [...identity.itemHashes] : [];
    if (hashes.length === 0 || hashes.some((hash) => typeof hash !== 'string' || !hash.trim())) {
      throw new TypeError('Fingerprint content hashes must not be empty');
    }
  }
  const bindings = [...input.bindings].sort((a, b) =>
    compareCodePoints(a.targetPortId, b.targetPortId) || a.order - b.order || compareCodePoints(a.edgeId, b.edgeId));
  return {
    moduleId: input.moduleId,
    moduleVersion: input.moduleVersion,
    config: input.config,
    provider: input.provider ?? null,
    model: input.model ?? null,
    bindings: bindings.map((binding) => {
      let contentIdentity: Record<string, JsonValue>;
      if (binding.contentIdentity.kind === 'inlineHash') {
        contentIdentity = { kind: 'inlineHash', inlineHash: binding.contentIdentity.inlineHash };
      } else if (binding.contentIdentity.kind === 'blobHash') {
        contentIdentity = { kind: 'blobHash', blobHash: binding.contentIdentity.blobHash };
      } else {
        contentIdentity = { kind: 'orderedItemHashes', itemHashes: [...binding.contentIdentity.itemHashes] };
      }
      return {
        edgeId: binding.edgeId, sourceNodeId: binding.sourceNodeId, sourcePortId: binding.sourcePortId,
        targetNodeId: binding.targetNodeId, targetPortId: binding.targetPortId, order: binding.order,
        activeResultId: binding.activeResultId, outputId: binding.outputId, contentIdentity,
      };
    }),
  };
}
