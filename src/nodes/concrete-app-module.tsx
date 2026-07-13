import type { JsonValue } from "../domain/project";
import type { GraphNode } from "../domain/project";
import { DefaultNodeIcon, defineAppNodeModule, type NodeExecutionContext, type NodeExecutionResult, type NodeViewProps } from "../engine/node-module";
import type { NodeDefinition, NodeKind } from "../types";
import { MODULE_ID_BY_KIND } from "./module-ids";
import { lazy, Suspense, type ComponentType } from "react";
import { valueTypeForDataType } from "../domain/values";

export function lazyModuleBody(loader: () => Promise<{ default: ComponentType<any> }>) {
  const LazyBody = lazy(loader);
  return function ModuleOwnedLazyBody(props: NodeViewProps<any>) {
    return <Suspense fallback={<div className="node-content" role="status" aria-label="Node wird geladen" />}><LazyBody {...props}/></Suspense>;
  };
}

export function defineConcreteAppNodeModule<const Kind extends Exclude<NodeKind, "unsupported">, Config extends Record<string, JsonValue>>(
  kind: Kind,
  definition: NodeDefinition,
  options: {
    validateConfig: (config: Record<string, JsonValue>) => config is Config;
    execute: (node: GraphNode & { config: Config }, context: NodeExecutionContext) => Promise<NodeExecutionResult>;
    Body: import("react").ComponentType<NodeViewProps<Config>>;
  },
) {
  if (definition.kind !== kind) throw new Error(`Node specification mismatch for ${kind}.`);
  const port = (direction: "input" | "output", item: NodeDefinition["inputs"][number] | NodeDefinition["outputs"][number]) => ({
    id: item.id, label: item.label, labelKey: `node.${kind}.port.${item.id}`, dataType: item.type, valueType: valueTypeForDataType(item.type, item.artifact),
    ...(direction === "input" && "optional" in item && item.optional ? { optional: true } : {}),
    ...(direction === "input" && "multiple" in item ? { multiple: item.multiple } : {}),
    ...(direction === "input" && "multiple" in item && item.multiple ? { cardinality: "many" as const } : {}),
  });
  const defaultConfig = definition.defaults as Config;
  const Body = options.Body;
  return defineAppNodeModule({
    id: MODULE_ID_BY_KIND[kind], version: 1, persistable: true, visibility: definition.hidden ? "hidden" : "public",
    metadata: { kind, label: { key: `node.${kind}.label`, fallback: definition.label }, description: { key: `node.${kind}.description`, fallback: definition.description }, category: { key: `category.${definition.category}`, fallback: definition.category } },
    inputs: definition.inputs.map((item) => port("input", item)), outputs: definition.outputs.map((item) => port("output", item)),
    defaultConfig, validateConfig: options.validateConfig, Icon: DefaultNodeIcon, Body, viewAdapter: { kind: "module", layout: "complete" },
    execution: { kind: "native", execute: options.execute },
  });
}
