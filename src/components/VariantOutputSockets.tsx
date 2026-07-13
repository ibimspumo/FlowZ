import { Handle, Position } from "@xyflow/react";
import type { FlowNodeData, NodeKind } from "../types";
import { mediaUrl } from "../persistence/media";
import { useI18n } from "../i18n";
import { KeyboardPortAction } from "./KeyboardPortAction";
import { nodePortSocketStyle } from "./node-port-layout";

export function variantOutputItems(data: FlowNodeData) {
  const configured = data.fanOutResultIds ?? [];
  const collection = data.collectionItems?.map((item) => item.id) ?? data.videoCollectionItems?.map((item) => item.id) ?? [];
  const ids = configured.length ? configured : collection;
  return ids.flatMap((id, index) => {
    const item = data.history?.find((candidate) => candidate.id === id) ?? data.collectionItems?.find((candidate) => candidate.id === id) ?? data.videoCollectionItems?.find((candidate) => candidate.id === id);
    if (!item) return [];
    const type = item.mediaType?.startsWith("video/") ? "video" as const : item.mediaType?.startsWith("image/") ? "image" as const : undefined;
    return type ? [{ id, index, type, blobHash: item.blobHash }] : [];
  });
}

export function VariantOutputSockets({ nodeId, kind, data, offset, colors }: { nodeId: string; kind: NodeKind; data: FlowNodeData; offset: number; colors: Record<string, string> }) {
  const { t } = useI18n(); const items = variantOutputItems(data);
  return <>{items.map((item) => {
    const label = t("history.variantOutput", { number: item.index + 1 }); const portId = `variant:${item.id}`;
    return <div key={portId} className="socket socket-out socket-variant" style={nodePortSocketStyle(offset + item.index)}>
      <span>{item.type === "image" && item.blobHash ? <img src={mediaUrl(item.blobHash)} alt="" loading="lazy" /> : null}{label}</span>
      <KeyboardPortAction nodeId={nodeId} nodeKind={kind} portId={portId} portLabel={label} dataType={item.type} direction="output" />
      <Handle type="source" position={Position.Right} id={portId} style={{ background: colors[item.type] }} />
    </div>;
  })}</>;
}
