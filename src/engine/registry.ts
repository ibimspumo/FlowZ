import type { NodeModule } from './node-module';
import type { JsonValue } from '../domain/project';

type ModuleId<M> = M extends { id: infer Id } ? Id : never;
type CheckedNodeModules<Modules extends readonly unknown[]> = {
  readonly [Index in keyof Modules]: Modules[Index] extends {
    id: infer Id extends string;
    defaultConfig: infer Config extends Record<string, JsonValue>;
  }
    ? Modules[Index] extends NodeModule<Id, Config> ? Modules[Index] : never
    : never;
};

export type NodeRegistry<Modules extends readonly unknown[]> = {
  readonly modules: Modules;
  readonly byId: Readonly<{ [Id in ModuleId<Modules[number]> & string]: Extract<Modules[number], { id: Id }> }>;
  get(id: string): Modules[number] | undefined;
};

/** A registry whose literal module ids remain available to TypeScript. */
export function defineNodeRegistry<const Modules extends readonly unknown[]>(
  ...modules: Modules & CheckedNodeModules<Modules>
): NodeRegistry<Modules> {
  const entries = new Map<string, Modules[number]>();
  for (const module of modules as readonly NodeModule[]) {
    if (entries.has(module.id)) throw new Error(`Duplicate node module id: ${module.id}`);
    if (!module.id.trim()) throw new Error('Node module id must not be empty');
    if (!Number.isSafeInteger(module.version) || module.version < 1) throw new Error(`Invalid version for ${module.id}`);
    if (typeof module.View !== 'function') throw new Error(`Node module ${module.id} requires a View`);
    if (typeof module.Icon !== 'function') throw new Error(`Node module ${module.id} requires an Icon`);
    const inputIds = module.inputs.map((port) => port.id);
    const outputIds = module.outputs.map((port) => port.id);
    if (new Set(inputIds).size !== inputIds.length) throw new Error(`Duplicate input port id in ${module.id}`);
    if (new Set(outputIds).size !== outputIds.length) throw new Error(`Duplicate output port id in ${module.id}`);
    if (module.validateConfig && !module.validateConfig(module.defaultConfig)) {
      throw new Error(`Invalid default config in ${module.id}`);
    }
    entries.set(module.id, module as Modules[number]);
  }

  return {
    modules,
    byId: Object.fromEntries(entries) as NodeRegistry<Modules>['byId'],
    get: (id) => entries.get(id) as Modules[number] | undefined,
  };
}
