import type { GraphEdge } from '../domain/project';
import type { ArtifactIdentity, RuntimeValue, ValueType } from '../domain/values';
import { runtimeValueType, valueTypeForDataType } from '../domain/values';
import type { InputPort, OutputPort } from './node-module';
import type { DataType } from '../types';

type ProductPort = { type: DataType; artifact?: ArtifactIdentity };

function baseValueTypesCompatible(output: ValueType, input: ValueType): boolean {
  if (output.kind !== input.kind) return false;
  return output.kind === 'scalar'
    ? output.scalar === (input.kind === 'scalar' ? input.scalar : undefined)
    : output.item === (input.kind === 'list' ? input.item : undefined);
}

export function areValueTypesCompatible(output: ValueType, input: ValueType): boolean {
  return baseValueTypesCompatible(output, input) && output.artifact === input.artifact;
}

export function productPortValueType(port: ProductPort): ValueType {
  return valueTypeForDataType(port.type, port.artifact);
}

export function areProductPortsCompatible(output: ProductPort, input: ProductPort): boolean {
  return areValueTypesCompatible(productPortValueType(output), productPortValueType(input));
}

export function canConnectPorts(output: OutputPort, input: InputPort): boolean {
  return areValueTypesCompatible(output.valueType, input.valueType);
}

export function acceptsRuntimeValue(input: InputPort, value: RuntimeValue): boolean {
  // Artifact identity is a graph-port contract. Runtime JSON stays unchanged,
  // so execution validates only the structural scalar/list value shape here.
  return baseValueTypesCompatible(runtimeValueType(value), input.valueType);
}

export function hasInputCapacity(input: InputPort, existing: readonly GraphEdge[]): boolean {
  return input.cardinality === 'many' || existing.length === 0;
}
