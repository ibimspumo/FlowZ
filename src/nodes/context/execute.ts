import type { JsonValue } from '../../domain/project';
import type { RuntimeValue } from '../../domain/values';
import type { NodeExecutionServices, NodeModule } from '../../engine/node-module';
import type { FlowNodeData, NodeKind } from '../../types';
import { contextNodeRegistry } from './index';

const MODULE_BY_KIND: Partial<Record<NodeKind, string>> = {
  webpage: 'context.webpage', research: 'context.research',
};

export type ContextExecution = {
  value: string;
  screenshotDataUrl?: string;
  parameters: Record<string, string | number | boolean>;
  executedQuery?: string;
};

export async function executeContextNode(
  kind: NodeKind,
  nodeId: string,
  data: FlowNodeData,
  textInputs: readonly string[],
  services: NodeExecutionServices,
  signal: AbortSignal,
): Promise<ContextExecution> {
  const moduleId = MODULE_BY_KIND[kind];
  if (!moduleId) throw new Error(`Kein Context-Modul für ${kind} registriert.`);
  const module = contextNodeRegistry.get(moduleId) as NodeModule | undefined;
  if (!module) throw new Error(`Context-Modul ${moduleId} ist nicht registriert.`);
  const config = Object.fromEntries(Object.keys(module.defaultConfig).map((key) => [key, data[key] ?? module.defaultConfig[key]])) as Record<string, JsonValue>;
  if (module.validateConfig && !module.validateConfig(config)) throw new Error('Die Node-Konfiguration ist ungültig.');
  const portId = module.inputs[0]?.id;
  const inputs = portId ? { [portId]: textInputs.map((value): RuntimeValue => ({ kind: 'scalar', value: { type: 'text', value } })) } : {};
  const result = await module.execute({ id: nodeId, moduleId, moduleVersion: module.version, position: { x: 0, y: 0 }, config, updatePolicy: 'manual' }, { signal, inputs, services });
  const textOutput = Object.values(result.outputs).find((output) => output.kind === 'scalar' && output.value.type === 'text');
  const value = textOutput?.kind === 'scalar' && textOutput.value.type === 'text' ? textOutput.value.value : '';
  if (!value) throw new Error('Die Node hat keinen Text erzeugt.');
  const metadata = result.metadata ?? {};
  const parameters: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(metadata)) if (!['text', 'screenshotDataUrl', 'executedQuery'].includes(key) && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) parameters[key] = value;
  return {
    value,
    ...(typeof metadata.screenshotDataUrl === 'string' ? { screenshotDataUrl: metadata.screenshotDataUrl } : {}),
    parameters,
    ...(typeof metadata.executedQuery === 'string' ? { executedQuery: metadata.executedQuery } : {}),
  };
}
