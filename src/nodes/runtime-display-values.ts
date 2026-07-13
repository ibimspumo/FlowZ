import type { JsonValue } from "../domain/project";
import type { RuntimeValue, ScalarValue, ScalarValueType } from "../domain/values";
import type { DataType } from "../types";

const CAS = /^flowz-cas:([a-f0-9]{64})$/;

function scalar(value: string, type: ScalarValueType): ScalarValue {
  if (type === "text") return { type, value };
  if (type === "json") {
    let parsed: JsonValue = value;
    try { parsed = JSON.parse(value) as JsonValue; } catch { /* Plain strings are valid JSON scalar values. */ }
    return { type, value: parsed };
  }
  if (type === "webpage") return { type, url: value };
  return { type, assetId: CAS.exec(value)?.[1] ?? value };
}

function listItemType(type: DataType): ScalarValueType | undefined {
  if (type === "textList" || type === "list") return "text";
  if (type === "imageList") return "image";
  if (type === "videoList") return "video";
  if (type === "audioList") return "audio";
  if (type === "jsonList") return "json";
}

export function runtimeValuesFromDisplay(values: readonly string[], type: DataType): RuntimeValue[] {
  const itemType = listItemType(type);
  if (itemType)
    return [{ kind: "list", itemType, items: values.map((value) => scalar(value, itemType)) }];
  const scalarType: ScalarValueType = type === "image" || type === "video" || type === "audio" || type === "json" ? type : "text";
  return values.map((value) => ({ kind: "scalar", value: scalar(value, scalarType) }));
}
