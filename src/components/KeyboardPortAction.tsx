import { Link2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Connection } from "@xyflow/react";
import { nodeSpecifications } from "../nodes/module-specifications";
import { localizedCanonicalNodeLabel, localizedPortLabel } from "../i18n-schema";
import { useI18n } from "../i18n";
import { useFlowStore } from "../store";
import type { DataType, FlowEdge, FlowNode, NodeKind } from "../types";

export type KeyboardPortDirection = "input" | "output";

export type KeyboardPortCandidate = {
  nodeId: string;
  nodeLabel: string;
  portId: string;
  portLabel: string;
  connection: Connection;
};

const baseHandle = (value: string | null | undefined) => value?.split("::")[0] ?? "";
const isListType = (value: string) => value.endsWith("List") || value === "list";

function outputIsAvailable(node: FlowNode, portId: string, type: DataType, edges: readonly FlowEdge[]) {
  if (!isListType(type)) return true;
  const value = node.data.outputValues?.[portId];
  return (Array.isArray(value) && value.length > 1)
    || edges.some((edge) => edge.source === node.id && baseHandle(edge.sourceHandle) === portId)
    || node.data.kind === "imageCollection" || node.data.kind === "videoCollection";
}

export function keyboardPortCandidates({
  nodes, edges, originNodeId, originPortId, direction, dataType,
}: {
  nodes: readonly FlowNode[];
  edges: readonly FlowEdge[];
  originNodeId: string;
  originPortId: string;
  direction: KeyboardPortDirection;
  dataType: DataType;
}): KeyboardPortCandidate[] {
  const candidates: KeyboardPortCandidate[] = [];
  for (const node of nodes) {
    if (node.id === originNodeId || node.data.kind === "unsupported") continue;
    const definition = nodeSpecifications[node.data.kind];
    const nodeLabel = String(node.data.label ?? definition.label);
    if (direction === "output") {
      for (const port of definition.inputs.filter((item) => item.type === dataType)) {
        const occupied = edges.filter((edge) => edge.target === node.id && baseHandle(edge.targetHandle) === port.id).length;
        if (!port.multiple && occupied > 0) continue;
        candidates.push({
          nodeId: node.id,
          nodeLabel,
          portId: port.id,
          portLabel: port.label,
          connection: { source: originNodeId, sourceHandle: originPortId, target: node.id, targetHandle: port.multiple ? `${port.id}::${occupied}` : port.id },
        });
      }
    } else {
      for (const port of definition.outputs.filter((item) => item.type === dataType && outputIsAvailable(node, item.id, item.type, edges))) {
        candidates.push({
          nodeId: node.id,
          nodeLabel,
          portId: port.id,
          portLabel: port.label,
          connection: { source: node.id, sourceHandle: port.id, target: originNodeId, targetHandle: originPortId },
        });
      }
    }
  }
  return candidates.sort((left, right) => left.nodeLabel.localeCompare(right.nodeLabel) || left.portLabel.localeCompare(right.portLabel));
}

export function KeyboardPortAction({ nodeId, nodeKind, portId, portLabel, dataType, direction }: {
  nodeId: string;
  nodeKind: NodeKind;
  portId: string;
  portLabel: string;
  dataType: DataType;
  direction: KeyboardPortDirection;
}) {
  const { t } = useI18n();
  const nodes = useFlowStore((state) => state.nodes);
  const edges = useFlowStore((state) => state.edges);
  const connect = useFlowStore((state) => state.connect);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const originDefinition = nodeSpecifications[nodeKind];
  const originNode = nodes.find((node) => node.id === nodeId);
  const originLabel = localizedCanonicalNodeLabel(originNode?.data.labelId, nodeKind, String(originNode?.data.label ?? originDefinition.label));
  const label = localizedPortLabel(portId, dataType, portLabel);
  const candidates = useMemo(() => keyboardPortCandidates({ nodes, edges, originNodeId: nodeId, originPortId: portId, direction, dataType }), [nodes, edges, nodeId, portId, direction, dataType]);

  useEffect(() => {
    if (!open) return;
    dialog.current?.querySelector<HTMLButtonElement>(".keyboard-port-candidate")?.focus();
  }, [open]);

  const close = () => { setOpen(false); queueMicrotask(() => trigger.current?.focus()); };
  return <>
    <button
      ref={trigger}
      type="button"
      className="keyboard-port-trigger nodrag nopan"
      aria-label={t(direction === "output" ? "connection.fromOutput" : "connection.toInput", { port: label, node: originLabel })}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => setOpen(true)}
    ><Link2 size={10} aria-hidden="true" /></button>
    {open && createPortal(<div className="keyboard-port-backdrop" onPointerDown={close}>
      <section ref={dialog} className="keyboard-port-dialog" role="dialog" aria-modal="true" aria-labelledby={`keyboard-port-${nodeId}-${portId}`} onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); close(); } }}>
        <header><div><strong id={`keyboard-port-${nodeId}-${portId}`}>{t("connection.title")}</strong><span>{originLabel} · {label}</span></div><button type="button" className="icon-button" onClick={close} aria-label={t("common.close")}><X size={14} /></button></header>
        <p>{t(direction === "output" ? "connection.chooseInput" : "connection.chooseOutput")}</p>
        <div className="keyboard-port-candidates">
          {candidates.map((candidate) => <button className="keyboard-port-candidate" type="button" key={`${candidate.nodeId}:${candidate.portId}`} onClick={() => { connect(candidate.connection); close(); }}>
            <strong>{localizedCanonicalNodeLabel(nodes.find((node) => node.id === candidate.nodeId)?.data.labelId, nodes.find((node) => node.id === candidate.nodeId)?.data.kind ?? "unsupported", candidate.nodeLabel)}</strong>
            <span>{localizedPortLabel(candidate.portId, dataType, candidate.portLabel)}</span>
          </button>)}
          {!candidates.length ? <div className="keyboard-port-empty">{t("connection.noCompatible")}</div> : null}
        </div>
        <footer><button type="button" className="secondary" onClick={close}>{t("common.cancel")}</button></footer>
      </section>
    </div>, document.body)}
  </>;
}
