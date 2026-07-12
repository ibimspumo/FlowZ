import type { GraphNode } from "../domain/project";
import {
  assertAppNodeCompatibility,
  executeAppNodeModule,
  type NodeExecutionContext,
  type NodeExecutionResult,
} from "../engine/node-module";
import type { AnyAppNodeModule } from ".";

/**
 * Single app execution boundary. Concrete modules own their executor; the
 * dispatcher contains no knowledge of node kinds.
 */
export async function dispatchAppNodeExecution(
  module: AnyAppNodeModule,
  node: GraphNode,
  context: NodeExecutionContext,
): Promise<NodeExecutionResult> {
  assertAppNodeCompatibility(module, node);
  return executeAppNodeModule(module, node, context);
}
