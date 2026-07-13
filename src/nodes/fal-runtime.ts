import type { JsonValue } from "../domain/project";
import type { RuntimeValue, ScalarValue } from "../domain/values";
import type {
  NodeExecutionContext,
  NodeExecutionResult,
} from "../engine/node-module";
import { directMediaBindingFromConfig, resolveDirectMediaInputs, type DirectMediaResolution } from "./direct-media";

export function scalarInputs(
  context: NodeExecutionContext,
  ...ports: string[]
): ScalarValue[] {
  const values: ScalarValue[] = [];
  for (const port of ports)
    for (const input of context.inputs[port] ?? []) {
      if (input.kind === "scalar") values.push(input.value);
      else values.push(...input.items);
    }
  return values;
}

export function mediaInputs(
  context: NodeExecutionContext,
  type: "image" | "video",
  ...ports: string[]
): string[] {
  return scalarInputs(context, ...ports).map((value) => {
    if (value.type !== type)
      throw new Error(
        `Eingang erwartet ${type === "image" ? "ein Bild" : "ein Video"}.`,
      );
    return value.assetId.startsWith("flowz-cas:")
      ? value.assetId
      : `flowz-cas:${value.assetId}`;
  });
}

export function directImageInputs(
  context: NodeExecutionContext,
  config: Record<string, JsonValue>,
  ...ports: string[]
): DirectMediaResolution {
  return resolveDirectMediaInputs(
    mediaInputs(context, "image", ...ports),
    directMediaBindingFromConfig(config),
    ports.filter((port) => context.connectedInputPorts?.has(port)).length,
  );
}

export function textInputs(
  context: NodeExecutionContext,
  ...ports: string[]
): string[] {
  return scalarInputs(context, ...ports)
    .map((value) => {
      if (value.type !== "text") throw new Error("Eingang erwartet Text.");
      return value.value;
    })
    .filter((value) => value.trim().length > 0);
}

export function jsonContext(
  context: NodeExecutionContext,
  ...ports: string[]
): string[] {
  return scalarInputs(context, ...ports).map((value) => {
    if (value.type !== "json")
      throw new Error("Eingang erwartet strukturierte Daten.");
    return JSON.stringify(value.value);
  });
}

export function imageResult(
  images: readonly { assetId: string; mediaType: string }[],
  metadata: Record<string, JsonValue>,
): NodeExecutionResult {
  if (!images.length) throw new Error("fal.ai hat kein Bild zurückgegeben.");
  const items: ScalarValue[] = images.map((image) => ({
    type: "image",
    assetId: image.assetId,
    mimeType: image.mediaType,
  }));
  return {
    outputs: {
      image: { kind: "scalar", value: items[0] },
      images: { kind: "list", itemType: "image", items },
    },
    metadata,
  };
}

export function firstRuntimeValue(
  value: RuntimeValue | undefined,
  expected: "image" | "video",
): ScalarValue | undefined {
  const result = value?.kind === "scalar" ? value.value : value?.items[0];
  if (result && result.type !== expected)
    throw new Error("Provider-Ergebnis hat den falschen Medientyp.");
  return result;
}
