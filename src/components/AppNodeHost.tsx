import type { GraphNode } from "../domain/project";
import { assertAppNodeCompatibility } from "../engine/node-module";
import type { AnyAppNodeModule } from "../nodes";
import type { NodeStatus } from "../types";
import { NodeShell } from "./NodeShell";

export function AppNodeHost({
  module,
  node,
  selected,
  status,
  runtimeProps,
}: {
  module: AnyAppNodeModule;
  node?: GraphNode;
  selected: boolean;
  status: NodeStatus;
  runtimeProps?: unknown;
}) {
  if (!node) throw new Error(`Graph node is missing for module ${module.id}.`);
  const viewNode = nodeForModuleView(module, node);
  const Body = module.Body;
  const body = <Body node={viewNode} selected={selected} runtimeProps={runtimeProps} />;
  if (module.viewAdapter.layout === "complete") return body;
  return (
    <NodeShell
      selected={selected}
      status={status}
      slots={{ body }}
    />
  );
}

/**
 * Unknown persisted modules are deliberately represented by the non-executable
 * unsupported module. Its view receives a canonical, empty config so untrusted
 * persisted data cannot impersonate a registered module or crash the canvas.
 * Every executable module remains strictly compatibility checked.
 */
export function nodeForModuleView(module: AnyAppNodeModule, node: GraphNode): GraphNode {
  try {
    assertAppNodeCompatibility(module, node);
    return node;
  } catch (error) {
    if (module.visibility !== "unsupported") throw error;
    return {
      ...node,
      moduleId: module.id,
      moduleVersion: module.version,
      config: module.defaultConfig,
    };
  }
}
