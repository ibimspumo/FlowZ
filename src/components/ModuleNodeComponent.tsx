import type { NodeProps } from "@xyflow/react";
import { canonicalNodeRegistry } from "../nodes";
import { useFlowStore } from "../store";
import type { FlowNode } from "../types";
import { AppNodeHost } from "./AppNodeHost";
import { RecoveryBoundary } from "./RecoveryBoundary";

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

  // The store removes the canonical graph entry before React Flow necessarily
  // finishes unmounting its visual node. Treat that short-lived state as a
  // completed removal instead of attempting to render an invalid host.
  if (!graphNode) return null;

  return (
    <RecoveryBoundary scope="node" resetKey={`${props.id}:${graphNode.moduleVersion}`} label={props.data.label}>
      <AppNodeHost
        module={module}
        node={graphNode}
        selected={props.selected}
        status={props.data.status}
        runtimeProps={props}
      />
    </RecoveryBoundary>
  );
}
