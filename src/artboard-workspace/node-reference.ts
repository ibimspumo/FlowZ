import type { FlowNodeData } from "../types";

export const ARTBOARD_REFERENCE_VERSION = 1 as const;
const CAS_HASH = /^[a-f0-9]{64}$/;

export type ArtboardWorkspaceReference = {
  artifact: "flowz.artboard-workspace-ref";
  version: typeof ARTBOARD_REFERENCE_VERSION;
  workspaceId: string;
  revisionId: string;
  revisionNumber: number;
  inputSnapshotId: string;
};

export function artboardWorkspaceReference(data: Pick<FlowNodeData, "artboardWorkspaceId" | "artboardRevisionId" | "artboardRevisionNumber" | "artboardInputSnapshotId">): ArtboardWorkspaceReference | undefined {
  if (!data.artboardWorkspaceId || !data.artboardRevisionId || data.artboardRevisionNumber == null || !data.artboardInputSnapshotId) return;
  return { artifact: "flowz.artboard-workspace-ref", version: ARTBOARD_REFERENCE_VERSION, workspaceId: data.artboardWorkspaceId, revisionId: data.artboardRevisionId, revisionNumber: data.artboardRevisionNumber, inputSnapshotId: data.artboardInputSnapshotId };
}

export function artboardNodeOutputs(data: FlowNodeData): Record<string, string | string[] | undefined> {
  const reference = artboardWorkspaceReference(data);
  const selected = (data.artboardSelectedImageHashes ?? []).filter((hash) => CAS_HASH.test(hash)).map((hash) => `flowz-cas:${hash}`);
  return {
    artboard: reference ? JSON.stringify(reference) : undefined,
    image: data.artboardActiveImageHash && CAS_HASH.test(data.artboardActiveImageHash) ? `flowz-cas:${data.artboardActiveImageHash}` : undefined,
    images: selected,
  };
}

/** Imported project data never gets to turn arbitrary SVG into an image source. */
export function safeArtboardPreviewSvg(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 500_000 || !/^<svg\b/i.test(value.trim())) return;
  // This field is durable/importable project data. Keep the accepted subset
  // aligned with the canonical renderer instead of trusting the SVG image
  // sandbox as the only defence against active or remote content.
  if (/<(?:script|foreignObject|iframe|object|embed|audio|video|style|link|meta|animate(?:Motion|Transform)?|set|use)\b/i.test(value)) return;
  if (/\bon[a-z]+\s*=|\bstyle\s*=/i.test(value)) return;
  const references = [...value.matchAll(/\b(?:href|src)\s*=\s*["']([^"']*)["']/gi)].map((match) => match[1]);
  if (references.some((reference) => !/^flowz-media:\/\/localhost\/[a-f0-9]{64}$/i.test(reference))) return;
  const cssUrls = [...value.matchAll(/url\s*\(\s*([^)]*)\s*\)/gi)].map((match) => match[1].replace(/["']/g, "").trim());
  if (cssUrls.some((reference) => !/^#[A-Za-z0-9._:-]+$/.test(reference))) return;
  return value;
}

export function artboardLinkFreshness(data: FlowNodeData, upstreamSignature: string): "unlinked" | "fresh" | "upstream-changed" {
  if (!artboardWorkspaceReference(data)) return "unlinked";
  return data.artboardLinkedInputSignature === upstreamSignature ? "fresh" : "upstream-changed";
}
