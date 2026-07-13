import type { NodeDefinition, NodeKind } from "./types";
import { canonicalNodeRegistry, type AnyAppNodeModule } from "./nodes";

export function definitionFromAppModule(module: AnyAppNodeModule): NodeDefinition {
  const kind = module.metadata.kind as NodeKind;
  return {
    kind,
    label: module.metadata.label.fallback,
    description: module.metadata.description.fallback,
    category: module.metadata.category.fallback as NodeDefinition["category"],
    inputs: module.inputs.map((port) => ({
      id: port.id,
      label: port.label,
      type: port.dataType as NodeDefinition["inputs"][number]["type"],
      ...(port.valueType.artifact ? { artifact: port.valueType.artifact } : {}),
      ...(port.optional ? { optional: true } : {}),
      ...(port.multiple !== undefined ? { multiple: port.multiple } : {}),
    })),
    outputs: module.outputs.map((port) => ({
      id: port.id,
      label: port.label,
      type: port.dataType as NodeDefinition["outputs"][number]["type"],
      ...(port.valueType.artifact ? { artifact: port.valueType.artifact } : {}),
    })),
    defaults: module.defaultConfig,
    ...(module.visibility === "hidden" ? { hidden: true } : {}),
  };
}

export const registry = Object.freeze(
  Object.fromEntries(
    canonicalNodeRegistry.modules.map((module) => [module.metadata.kind, definitionFromAppModule(module)]),
  ),
) as Readonly<Record<NodeKind, NodeDefinition>>;

export const typeColors = {
  text: "var(--type-text)", image: "var(--type-image)", video: "var(--type-video)", audio: "var(--type-audio)", json: "var(--type-json)",
  textList: "var(--type-list)", imageList: "var(--type-list)", videoList: "var(--type-list)", audioList: "var(--type-list)", jsonList: "var(--type-json-list)", list: "var(--type-list)",
};
