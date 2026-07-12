import type { JsonValue } from "../domain/project";

export type FieldValidator = (value: JsonValue) => boolean;
export type ExactConfigSchema = Readonly<Record<string, { validate: FieldValidator; optional?: boolean }>>;

export const field = {
  string: (max = 100_000): FieldValidator => (value) => typeof value === "string" && value.length <= max,
  nonEmptyString: (max = 512): FieldValidator => (value) => typeof value === "string" && value.length > 0 && value.length <= max,
  boolean: (): FieldValidator => (value) => typeof value === "boolean",
  integer: (min: number, max: number): FieldValidator => (value) => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max,
  number: (min: number, max: number): FieldValidator => (value) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max,
  enum: <T extends string>(values: readonly T[]): FieldValidator => (value) => typeof value === "string" && values.includes(value as T),
  strings: (maxItems: number, maxLength = 512): FieldValidator => (value) => Array.isArray(value) && value.length <= maxItems && value.every((item) => typeof item === "string" && item.length > 0 && item.length <= maxLength),
};

export function exactConfig(schema: ExactConfigSchema) {
  const keys = new Set(Object.keys(schema));
  return (config: Record<string, JsonValue>) => {
    if (!config || Array.isArray(config) || Object.keys(config).some((key) => !keys.has(key))) return false;
    return Object.entries(schema).every(([key, rule]) => config[key] === undefined ? rule.optional === true : rule.validate(config[key]));
  };
}

export const optionalExportSchema: ExactConfigSchema = {
  exportFolderGrant: { validate: field.string(2_000), optional: true },
  exportFolderLabel: { validate: field.string(2_000), optional: true },
  exportNameTemplate: { validate: field.string(255), optional: true },
  exportOverwrite: { validate: field.enum(["rename", "replace", "error"]), optional: true },
  exportedFiles: { validate: field.strings(500, 4_096), optional: true },
};
