import type { GraphEdge } from '../domain/project';
import type { RuntimeValue, ValueType } from '../domain/values';
import { runtimeValueType } from '../domain/values';
import type { InputPort, OutputPort } from './node-module';

export function areValueTypesCompatible(output: ValueType, input: ValueType): boolean {
  if (output.kind !== input.kind) return false;
  return output.kind === 'scalar'
    ? output.scalar === (input.kind === 'scalar' ? input.scalar : undefined)
    : output.item === (input.kind === 'list' ? input.item : undefined);
}

export function canConnectPorts(output: OutputPort, input: InputPort): boolean {
  return areValueTypesCompatible(output.valueType, input.valueType);
}

export function acceptsRuntimeValue(input: InputPort, value: RuntimeValue): boolean {
  return areValueTypesCompatible(runtimeValueType(value), input.valueType);
}

export function hasInputCapacity(input: InputPort, existing: readonly GraphEdge[]): boolean {
  return input.cardinality === 'many' || existing.length === 0;
}
