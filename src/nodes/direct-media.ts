import type { JsonValue } from "../domain/project";

const CAS_HASH = /^[a-f0-9]{64}$/;
const IMAGE_MEDIA_TYPE = /^image\/[a-z0-9.+-]{1,80}$/;
const ID = /^[^\u0000-\u001f\u007f]{1,512}$/;

export type DirectMediaSource =
  | {
      kind: "asset-version";
      assetId: string;
      versionId: string;
      version: number;
    }
  | {
      kind: "project-result";
      projectId: string;
      projectRevision: number;
      resultId: string;
    };

/**
 * Immutable, reload-safe media binding stored in the target node config.
 * It deliberately contains only CAS/provenance identities: never file paths,
 * object URLs, remote URLs or Data URLs.
 */
export type DirectMediaBinding = {
  schemaVersion: 1;
  kind: "image";
  blobHash: string;
  mediaType: string;
  priority: "fallback" | "override";
  source: DirectMediaSource;
};

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && [...keys].sort().every((key, index) => key === actual[index]);
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isDirectMediaBinding(value: unknown): value is DirectMediaBinding {
  if (!record(value) || !exactKeys(value, ["schemaVersion", "kind", "blobHash", "mediaType", "priority", "source"])) return false;
  if (value.schemaVersion !== 1 || value.kind !== "image" || typeof value.blobHash !== "string" || !CAS_HASH.test(value.blobHash)
    || typeof value.mediaType !== "string" || !IMAGE_MEDIA_TYPE.test(value.mediaType)
    || !["fallback", "override"].includes(String(value.priority)) || !record(value.source)) return false;
  const source = value.source;
  if (source.kind === "asset-version") {
    return exactKeys(source, ["kind", "assetId", "versionId", "version"])
      && typeof source.assetId === "string" && ID.test(source.assetId)
      && typeof source.versionId === "string" && ID.test(source.versionId)
      && typeof source.version === "number" && Number.isSafeInteger(source.version) && source.version >= 1;
  }
  return source.kind === "project-result"
    && exactKeys(source, ["kind", "projectId", "projectRevision", "resultId"])
    && typeof source.projectId === "string" && ID.test(source.projectId)
    && typeof source.projectRevision === "number" && Number.isSafeInteger(source.projectRevision) && source.projectRevision >= 0
    && typeof source.resultId === "string" && ID.test(source.resultId);
}

export function directMediaBindingFromConfig(config: Record<string, JsonValue>): DirectMediaBinding | undefined {
  const value = config.directMedia;
  if (value === undefined) return;
  if (!isDirectMediaBinding(value)) throw new Error("Die direkte Bildreferenz ist ungültig oder nicht revisionssicher.");
  return value;
}

export type DirectMediaResolution = {
  values: string[];
  source: "cable" | "local-fallback" | "local-override" | "none";
  /** Non-zero means an intentional override shadowed connected values. */
  shadowedCableCount: number;
};

/** Central precedence contract shared by execution and future UI indicators. */
export function resolveDirectMediaInputs(
  connected: readonly string[],
  binding: DirectMediaBinding | undefined,
): DirectMediaResolution {
  if (binding?.priority === "override") {
    return { values: [`flowz-cas:${binding.blobHash}`], source: "local-override", shadowedCableCount: connected.length };
  }
  if (connected.length) return { values: [...connected], source: "cable", shadowedCableCount: 0 };
  if (binding) return { values: [`flowz-cas:${binding.blobHash}`], source: "local-fallback", shadowedCableCount: 0 };
  return { values: [], source: "none", shadowedCableCount: 0 };
}

export function directMediaConfigField(value: JsonValue): boolean {
  return isDirectMediaBinding(value);
}

export const DIRECT_MEDIA_TARGETS = new Set([
  "imageAnalysis", "imageUpscale", "backgroundRemoval", "imageTransform",
  "imageTrimTransparent", "imageGeneration", "logoDesign",
]);

export function assetVersionDirectMediaBinding(
  asset: { assetId: string; versionId: string; version: number; kind: string },
  reference: { versionId: string; blobHash?: string; mediaType?: string },
  priority: DirectMediaBinding["priority"] = "fallback",
): DirectMediaBinding {
  const candidate = {
    schemaVersion: 1 as const, kind: "image" as const,
    blobHash: reference.blobHash ?? "", mediaType: reference.mediaType ?? "",
    priority,
    source: { kind: "asset-version" as const, assetId: asset.assetId, versionId: asset.versionId, version: asset.version },
  };
  if (asset.kind !== "image" || reference.versionId !== asset.versionId || !isDirectMediaBinding(candidate)) {
    throw new Error("Die Asset-Version besitzt keine gültige lokale CAS-Bildreferenz.");
  }
  return candidate;
}

export function projectResultDirectMediaBinding(
  projectId: string,
  projectRevision: number,
  result: { resultId: string; blobHash?: string; mediaType?: string },
  priority: DirectMediaBinding["priority"] = "fallback",
): DirectMediaBinding {
  const candidate = {
    schemaVersion: 1 as const, kind: "image" as const,
    blobHash: result.blobHash ?? "", mediaType: result.mediaType ?? "",
    priority,
    source: { kind: "project-result" as const, projectId, projectRevision, resultId: result.resultId },
  };
  if (!isDirectMediaBinding(candidate)) throw new Error("Der Dateiimport besitzt keine gültige lokale CAS-Bildreferenz.");
  return candidate;
}
