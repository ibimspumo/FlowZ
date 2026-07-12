import type { JsonValue, UpdatePolicy } from '../domain';
import type { NodeKind } from '../types';

export const TEMPLATE_SCHEMA_VERSION = 1 as const;

export type CanvasTemplateNode = {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
  label?: string;
  config?: Record<string, JsonValue>;
  updatePolicy?: UpdatePolicy;
};

export type CanvasTemplateEdge = {
  source: string;
  sourcePort: string;
  target: string;
  targetPort: string;
  order?: number;
};

export type CanvasTemplateGroup = {
  id: string;
  name: string;
  nodeIds: string[];
  color?: string;
  description?: string;
};

export type CanvasTemplate = {
  schemaVersion: typeof TEMPLATE_SCHEMA_VERSION;
  id: string;
  version: number;
  name: string;
  summary: string;
  /** Short, user-facing instruction for the first deliberate run after insertion. */
  firstRun: string;
  category: 'Marke' | 'Content' | 'Video' | 'Recherche' | 'Werkzeug';
  nodes: CanvasTemplateNode[];
  edges: CanvasTemplateEdge[];
  groups: CanvasTemplateGroup[];
  hints: string[];
  paidNodeCount: number;
};

/** Version boundary for future persisted/fetched template catalogs. */
export function migrateTemplate(input: CanvasTemplate): CanvasTemplate {
  if (input.schemaVersion !== TEMPLATE_SCHEMA_VERSION) throw new Error(`Unbekannte Vorlagen-Version: ${String(input.schemaVersion)}`);
  return structuredClone(input);
}
