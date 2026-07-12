import {
  DefaultNodeIcon,
  DefaultNodeView,
  defineAppNodeModule,
  type AppNodeModule,
} from "../engine/node-module";
import type { NodeKind } from "../types";
import { coreAppNodeModules } from "./core/modules";
import { contextAppNodeModules } from "./context/modules";
import { aiAppNodeModules } from "./ai/modules";
import { imageAppNodeModules } from "./image/modules";
import { videoAppNodeModules } from "./video/modules";
import { brandAppNodeModules } from "./brand/modules";
export { MODULE_ID_BY_KIND, persistedModuleIdForKind } from "./module-ids";
export {
  assetVersionDirectMediaBinding,
  projectResultDirectMediaBinding,
  resolveDirectMediaInputs,
  type DirectMediaBinding,
  type DirectMediaResolution,
} from "./direct-media";

// Registry storage is intentionally type-erased; each module retains its exact
// config type at definition and validates again at the execution boundary.
export type AnyAppNodeModule = AppNodeModule<string, string, any>;

const UNSUPPORTED_MODULE_ID = "system.unsupported";

const unsupportedModule = defineAppNodeModule({
  id: UNSUPPORTED_MODULE_ID,
  version: 1,
  persistable: false,
  visibility: "unsupported",
  metadata: {
    kind: "unsupported",
    label: { key: "node.unsupported.label", fallback: "Nicht unterstützter Node" },
    description: { key: "node.unsupported.description", fallback: "Modul ist in dieser FlowZ-Version nicht verfügbar" },
    category: { key: "category.System", fallback: "System" },
  },
  inputs: [], outputs: [], defaultConfig: {},
  validateConfig: (config): config is Record<string, never> => Object.keys(config).length === 0,
  Icon: DefaultNodeIcon, Body: DefaultNodeView,
  viewAdapter: { kind: "module" },
  execution: { kind: "native", execute: async () => { throw new Error("Unsupported modules cannot execute."); } },
});

const modules: readonly AnyAppNodeModule[] = [
  ...coreAppNodeModules,
  ...contextAppNodeModules,
  ...aiAppNodeModules,
  ...imageAppNodeModules,
  ...videoAppNodeModules,
  ...brandAppNodeModules,
  unsupportedModule,
];

export type CanonicalNodeRegistry = {
  modules: readonly AnyAppNodeModule[];
  byId: Readonly<Record<string, AnyAppNodeModule>>;
  byKind: Readonly<Record<NodeKind, AnyAppNodeModule>>;
  get: (moduleId: string) => AnyAppNodeModule | undefined;
  forKind: (kind: NodeKind) => AnyAppNodeModule;
};

export function defineCanonicalNodeRegistry(
  entries: readonly AnyAppNodeModule[],
): CanonicalNodeRegistry {
  const byId: Record<string, AnyAppNodeModule> = {};
  const byKind = {} as Record<NodeKind, AnyAppNodeModule>;
  for (const module of entries) {
    const kind = module.metadata.kind as NodeKind;
    if (byId[module.id]) throw new Error(`Duplicate app module id: ${module.id}`);
    if (byKind[kind]) throw new Error(`Duplicate app module kind: ${kind}`);
    if (!Number.isSafeInteger(module.version) || module.version < 1)
      throw new Error(`Invalid app module version: ${module.id}`);
    const inputIds = module.inputs.map((item) => item.id);
    const outputIds = module.outputs.map((item) => item.id);
    if (new Set(inputIds).size !== inputIds.length)
      throw new Error(`Duplicate input port in ${module.id}`);
    if (new Set(outputIds).size !== outputIds.length)
      throw new Error(`Duplicate output port in ${module.id}`);
    if (!module.validateConfig(module.defaultConfig))
      throw new Error(`Invalid default config in ${module.id}`);
    byId[module.id] = module;
    byKind[kind] = module;
  }
  return Object.freeze({
    modules: Object.freeze([...entries]),
    byId: Object.freeze(byId),
    byKind: Object.freeze(byKind),
    get: (moduleId: string) => byId[moduleId],
    forKind: (kind: NodeKind) => byKind[kind],
  });
}

/** Single source of truth consumed by canvas, adapters, templates and persistence. */
export const canonicalNodeRegistry = defineCanonicalNodeRegistry(modules);

export function moduleIdForKind(kind: NodeKind): string | undefined {
  const module = canonicalNodeRegistry.byKind[kind];
  return module?.persistable ? module.id : undefined;
}

export function kindForModuleId(moduleId: string): NodeKind | undefined {
  return canonicalNodeRegistry.get(moduleId)?.metadata.kind as NodeKind | undefined;
}
