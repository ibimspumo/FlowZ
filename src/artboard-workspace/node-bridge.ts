export const ARTBOARD_NODE_OPEN_EVENT = "flowz:artboard-node-open";
export const ARTBOARD_NODE_LINK_EVENT = "flowz:artboard-node-link";

export type ArtboardNodeUpstream = {
  fingerprint: string;
  palette: string[];
  fonts: string[];
  images: string[];
};

export type ArtboardNodeRequest = {
  flowId: string;
  nodeId: string;
  workspaceId?: string;
  upstream: ArtboardNodeUpstream;
};

/** The shell owns navigation and document selection; flow nodes only publish intent. */
export function requestArtboardNodeOpen(request: ArtboardNodeRequest): void {
  window.dispatchEvent(new CustomEvent(ARTBOARD_NODE_OPEN_EVENT, { detail: request }));
}

export function requestArtboardNodeLink(request: ArtboardNodeRequest): void {
  window.dispatchEvent(new CustomEvent(ARTBOARD_NODE_LINK_EVENT, { detail: request }));
}

export type ArtboardNodeBinding = {
  flowId: string;
  nodeId: string;
  workspaceId: string;
  workspaceName: string;
  revisionId: string;
  revisionNumber: number;
  inputSnapshotId: string;
  linkedInputSignature: string;
  /** Exact SVG produced by renderArtboardSvg for the active board. */
  previewSvg: string;
  activeImageHash?: string;
  selectedImageHashes: string[];
};
