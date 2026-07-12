import type { NodeProps } from "@xyflow/react";
import { canonicalNodeRegistry } from "../nodes";
import { useFlowStore } from "../store";
import type { FlowNode } from "../types";
import { AppNodeHost } from "./AppNodeHost";

/**
 * Thin canvas adapter. Product behavior belongs to the registered module Body;
 * this component only joins React Flow's runtime props with the canonical graph
 * node consumed by AppNodeHost.
 */
export function ModuleNodeComponent(props: NodeProps<FlowNode>) {
  const graphNode = useFlowStore((state) =>
    state.document?.graph.nodes.find((node) => node.id === props.id),
  );
  const module = canonicalNodeRegistry.forKind(props.data.kind);

  return (
    <AppNodeHost
      module={module}
      node={graphNode}
      selected={props.selected}
      status={props.data.status}
      runtimeProps={props}
    />
  );
}
