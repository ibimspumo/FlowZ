import type { InputCardinality, ValueType } from './values';

export const CURRENT_SCHEMA_VERSION = 2 as const;

export type UpdatePolicy = 'manual' | 'auto' | 'frozen';
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type CanvasPosition = { x: number; y: number };
export type CanvasViewport = { x: number; y: number; zoom: number };

export type GraphNode = {
  id: string;
  moduleId: string;
  moduleVersion: number;
  position: CanvasPosition;
  label?: string;
  /** Canonical schema-owned label identity. Absence means the label is user content. */
  labelId?: string;
  config: Record<string, JsonValue>;
  updatePolicy: UpdatePolicy;
};

export type GraphEdge = {
  id: string;
  sourceNodeId: string;
  sourcePortId: string;
  targetNodeId: string;
  targetPortId: string;
  /** Stable order for many-cardinality inputs. Zero-based within the target port. */
  order: number;
};

export type WorkflowGroup = {
  id: string;
  name: string;
  nodeIds: string[];
  color?: string;
  description?: string;
};

export type ProjectDocument = {
  schemaVersion: typeof CURRENT_SCHEMA_VERSION;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  graph: {
    nodes: GraphNode[];
    edges: GraphEdge[];
    groups: WorkflowGroup[];
  };
  canvas: { viewport: CanvasViewport };
};

export type PortSnapshot = {
  id: string;
  valueType: ValueType;
  cardinality?: InputCardinality;
};

/** API costs are stored as integer millionths of a currency unit, never floats. */
export type MicroUnitAmount = number & { readonly __microUnitAmount: unique symbol };

export function microUnits(amount: number): MicroUnitAmount {
  if (!Number.isSafeInteger(amount)) throw new TypeError('Money must use safe integer micro-units');
  return amount as MicroUnitAmount;
}

export type Money = {
  amountMicros: MicroUnitAmount;
  currency: string;
};
