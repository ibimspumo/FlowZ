import { Link2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Connection } from "@xyflow/react";
import type { ProjectDocument } from "../domain";
import { connectionCreatesCycle, flowEdgeToGraph, nextInputOrder } from "../app/adapters";
import { nodeSpecifications } from "../nodes/module-specifications";
import { localizedCanonicalNodeLabel, localizedPortLabel } from "../i18n-schema";
import { useI18n } from "../i18n";
import { useFlowStore } from "../store";
import type { DataType, FlowEdge, FlowNode, NodeKind } from "../types";
import { areProductPortsCompatible } from "../engine/compatibility";

export type KeyboardPortDirection = "input" | "output";

export type KeyboardPortCandidate = {
  nodeId: string;
  nodeLabel: string;
  portId: string;
  portLabel: string;
  connection: Connection;
  /** Occupied scalar inputs are replaced through the store's validated
   * reconnect path, matching pointer interaction semantics. */
  replacingEdgeId?: string;
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
  nodes, edges, document, originNodeId, originPortId, direction, dataType,
}: {
  nodes: readonly FlowNode[];
  edges: readonly FlowEdge[];
  document?: ProjectDocument;
  originNodeId: string;
  originPortId: string;
  direction: KeyboardPortDirection;
  dataType: DataType;
}): KeyboardPortCandidate[] {
  const candidates: KeyboardPortCandidate[] = [];
  const originKind=nodes.find((node)=>node.id===originNodeId)?.data.kind??"unsupported";
  const originDefinition=nodeSpecifications[originKind];
  const originPort=direction==="output"
    ? originDefinition.outputs.find((port)=>port.id===originPortId)
    : originDefinition.inputs.find((port)=>port.id===originPortId);
  const originContract=originPort??{id:originPortId,label:originPortId,type:dataType};
  const addCandidate = (candidate: KeyboardPortCandidate) => {
    const connection = candidate.connection;
    if (document && connection.source && connection.sourceHandle && connection.target && connection.targetHandle) {
      const targetPort = baseHandle(connection.targetHandle);
      const graphCandidate = flowEdgeToGraph({
        id: candidate.replacingEdgeId ?? "keyboard-candidate",
        source: connection.source,
        sourceHandle: connection.sourceHandle,
        target: connection.target,
        targetHandle: targetPort,
      }, nextInputOrder(document, connection.target, targetPort, candidate.replacingEdgeId));
      if (connectionCreatesCycle(document, graphCandidate, candidate.replacingEdgeId)) return;
    }
    candidates.push(candidate);
  };
  const originInput = direction === "input"
    ? nodeSpecifications[nodes.find((node) => node.id === originNodeId)?.data.kind ?? "unsupported"].inputs.find((port) => port.id === originPortId)
    : undefined;
  const originOccupied = direction === "input" && !originInput?.multiple
    ? edges.find((edge) => edge.target === originNodeId && baseHandle(edge.targetHandle) === originPortId)
    : undefined;
  for (const node of nodes) {
    if (node.id === originNodeId || node.data.kind === "unsupported") continue;
    const definition = nodeSpecifications[node.data.kind];
    const nodeLabel = String(node.data.label ?? definition.label);
    if (direction === "output") {
      for (const port of definition.inputs.filter((item) => areProductPortsCompatible(originContract,item))) {
        const occupied = !port.multiple ? edges.find((edge) => edge.target === node.id && baseHandle(edge.targetHandle) === port.id) : undefined;
        addCandidate({
          nodeId: node.id,
          nodeLabel,
          portId: port.id,
          portLabel: port.label,
          // Multiple cables share the canonical rendered handle. Their stable
          // order is assigned by the graph store when the connection is saved.
          connection: { source: originNodeId, sourceHandle: originPortId, target: node.id, targetHandle: port.id },
          ...(occupied ? { replacingEdgeId: occupied.id } : {}),
        });
      }
    } else {
      for (const port of definition.outputs.filter((item) => areProductPortsCompatible(item,originContract) && outputIsAvailable(node, item.id, item.type, edges))) {
        addCandidate({
          nodeId: node.id,
          nodeLabel,
          portId: port.id,
          portLabel: port.label,
          connection: { source: node.id, sourceHandle: port.id, target: originNodeId, targetHandle: originPortId },
          ...(originOccupied ? { replacingEdgeId: originOccupied.id } : {}),
        });
      }
    }
  }
  return candidates.sort((left, right) => left.nodeLabel.localeCompare(right.nodeLabel) || left.portLabel.localeCompare(right.portLabel));
}

export function keyboardConnectionExists(edges: readonly FlowEdge[], candidate: KeyboardPortCandidate): boolean {
  const { connection } = candidate;
  return edges.some((edge) =>
    (!candidate.replacingEdgeId || edge.id === candidate.replacingEdgeId)
    && edge.source === connection.source
    && baseHandle(edge.sourceHandle) === baseHandle(connection.sourceHandle)
    && edge.target === connection.target
    && baseHandle(edge.targetHandle) === baseHandle(connection.targetHandle));
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
  const projectDocument = useFlowStore((state) => state.document);
  const connect = useFlowStore((state) => state.connect);
  const reconnect = useFlowStore((state) => state.reconnect);
  const [open, setOpen] = useState(false);
  const [connectionError, setConnectionError] = useState<string>();
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const originDefinition = nodeSpecifications[nodeKind];
  const originNode = nodes.find((node) => node.id === nodeId);
  const originLabel = localizedCanonicalNodeLabel(originNode?.data.labelId, nodeKind, String(originNode?.data.label ?? originDefinition.label));
  const label = localizedPortLabel(portId, dataType, portLabel);
  const candidates = useMemo(() => keyboardPortCandidates({ nodes, edges, document: projectDocument, originNodeId: nodeId, originPortId: portId, direction, dataType }), [nodes, edges, projectDocument, nodeId, portId, direction, dataType]);

  useEffect(() => {
    if (!open) return;
    dialog.current?.querySelector<HTMLButtonElement>(".keyboard-port-candidate")?.focus();
  }, [open]);

  const close = () => { setOpen(false); queueMicrotask(() => trigger.current?.focus()); };
  const choose = (candidate: KeyboardPortCandidate) => {
    setConnectionError(undefined);
    if (candidate.replacingEdgeId) {
      const occupied = useFlowStore.getState().edges.find((edge) => edge.id === candidate.replacingEdgeId);
      if (!occupied) { setConnectionError(t("connection.rejected")); return; }
      reconnect(occupied, candidate.connection);
    } else {
      connect(candidate.connection);
    }
    const current = useFlowStore.getState();
    if (!keyboardConnectionExists(current.edges, candidate)) {
      setConnectionError(current.saveError ?? t("connection.rejected"));
      return;
    }
    close();
  };
  return <>
    <button
      ref={trigger}
      type="button"
      className="keyboard-port-trigger nodrag nopan"
      aria-label={t(direction === "output" ? "connection.fromOutput" : "connection.toInput", { port: label, node: originLabel })}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => { setConnectionError(undefined); setOpen(true); }}
    ><Link2 size={10} aria-hidden="true" /></button>
    {open && createPortal(<div className="keyboard-port-backdrop" onPointerDown={close}>
      <section ref={dialog} className="keyboard-port-dialog" role="dialog" aria-modal="true" aria-labelledby={`keyboard-port-${nodeId}-${portId}`} onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); close(); } }}>
        <header><div><strong id={`keyboard-port-${nodeId}-${portId}`}>{t("connection.title")}</strong><span>{originLabel} · {label}</span></div><button type="button" className="icon-button" onClick={close} aria-label={t("common.close")}><X size={14} /></button></header>
        <p>{t(direction === "output" ? "connection.chooseInput" : "connection.chooseOutput")}</p>
        <div className="keyboard-port-candidates">
          {candidates.map((candidate) => <button className="keyboard-port-candidate" type="button" key={`${candidate.nodeId}:${candidate.portId}`} onClick={() => choose(candidate)}>
            <strong>{localizedCanonicalNodeLabel(nodes.find((node) => node.id === candidate.nodeId)?.data.labelId, nodes.find((node) => node.id === candidate.nodeId)?.data.kind ?? "unsupported", candidate.nodeLabel)}</strong>
            <span>{localizedPortLabel(candidate.portId, dataType, candidate.portLabel)}</span>
          </button>)}
          {!candidates.length ? <div className="keyboard-port-empty">{t("connection.noCompatible")}</div> : null}
        </div>
        {connectionError ? <div className="node-error" role="alert">{connectionError}</div> : null}
        <footer><button type="button" className="secondary" onClick={close}>{t("common.cancel")}</button></footer>
      </section>
    </div>, document.body)}
  </>;
}
