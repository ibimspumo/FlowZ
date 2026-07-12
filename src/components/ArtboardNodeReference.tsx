import { ExternalLink, Frame, Link2, RefreshCw } from "lucide-react";
import { mediaUrl } from "../persistence/media";
import type { FlowNodeData } from "../types";
import { requestArtboardNodeLink, requestArtboardNodeOpen, type ArtboardNodeUpstream } from "../artboard-workspace/node-bridge";
import { artboardLinkFreshness, safeArtboardPreviewSvg } from "../artboard-workspace/node-reference";
import { useI18n } from "../i18n";

type Props = {
  flowId: string;
  nodeId: string;
  data: FlowNodeData;
  upstream: ArtboardNodeUpstream;
};

const svgSource = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

export function ArtboardNodeReference({ flowId, nodeId, data, upstream }: Props) {
  const {t}=useI18n();
  const freshness = artboardLinkFreshness(data, upstream.fingerprint);
  const request = { flowId, nodeId, workspaceId: data.artboardWorkspaceId, upstream };
  const previewSvg = safeArtboardPreviewSvg(data.artboardPreviewSvg);
  const preview = previewSvg ? svgSource(previewSvg) : data.artboardActiveImageHash ? mediaUrl(data.artboardActiveImageHash) : undefined;
  return <section className="artboard-node-reference" aria-label={t('artboardNode.region')}>
    <button type="button" className="artboard-node-preview" disabled={!data.artboardWorkspaceId} onClick={() => requestArtboardNodeOpen(request)} aria-label={t('artboardNode.open')}>
      {preview ? <img src={preview} alt={t('artboardNode.preview')} /> : <span><Frame size={24} /><small>{t('artboardNode.none')}</small></span>}
    </button>
    <div className="artboard-node-reference-row">
      <div><strong>{data.artboardWorkspaceName || t('artboardNode.choose')}</strong><small className={`artboard-node-freshness is-${freshness}`}>{freshness === "fresh" ? t('artboardNode.fresh') : freshness === "upstream-changed" ? t('artboardNode.changed') : t('artboardNode.unlinked')}</small></div>
      {data.artboardWorkspaceId ? <button type="button" className="icon-button" onClick={() => requestArtboardNodeOpen(request)} aria-label={t('artboardNode.open')} title={t('artboardNode.open')}><ExternalLink size={15} /></button> : null}
    </div>
    <button type="button" className="secondary artboard-node-link" onClick={() => requestArtboardNodeLink(request)}>{freshness === "upstream-changed" ? <RefreshCw size={14} /> : <Link2 size={14} />}{data.artboardWorkspaceId ? t('artboardNode.change') : t('artboardNode.link')}</button>
  </section>;
}
