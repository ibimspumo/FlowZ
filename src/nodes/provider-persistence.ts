import type { FlowNode, NodeKind } from "../types";

const PAID_BRAND_RESULT_KINDS = {
  audienceAnalysis: "brand-audienceAnalysis",
  brandNames: "brand-brandNames",
  colorPalette: "brand-colorPalette",
  fontPairing: "brand-fontPairing",
} as const;

const PAID_BRAND_OUTPUTS = {
  audienceAnalysis: {
    moduleId: "brand.audience",
    resultKind: "brand-audienceAnalysis",
    primaryPort: "audience",
    ports: ["audience"],
  },
  brandNames: {
    moduleId: "brand.names",
    resultKind: "brand-brandNames",
    primaryPort: "names",
    ports: ["names"],
  },
  colorPalette: {
    moduleId: "brand.color-palette",
    resultKind: "brand-colorPalette",
    primaryPort: "palette",
    ports: ["palette"],
  },
  fontPairing: {
    moduleId: "brand.font-pairing",
    resultKind: "brand-fontPairing",
    primaryPort: "pairing",
    ports: ["pairing", "styleHint"],
  },
} as const;

type PaidBrandKind = keyof typeof PAID_BRAND_OUTPUTS;

export const PAID_BRAND_FINGERPRINTED_MODULES = new Set<string>(
  Object.values(PAID_BRAND_OUTPUTS).map((contract) => contract.moduleId),
);

/** Versioned, result-local snapshot of cable-visible Brand outputs. */
export function paidBrandOutputSnapshot(
  kind: NodeKind,
  outputValues: Record<string, string | string[] | undefined>,
): { version: 1; values: Record<string, string> } {
  const contract = PAID_BRAND_OUTPUTS[kind as PaidBrandKind];
  if (!contract) throw new Error(`Node ${kind} ist kein bezahltes Brand-Ergebnis.`);
  const values: Record<string, string> = {};
  for (const port of contract.ports) {
    const value = outputValues[port];
    if (typeof value !== "string")
      throw new Error(`Brand-Ausgang ${kind}.${port} fehlt im Ergebnis.`);
    values[port] = value;
  }
  return { version: 1, values };
}

export function hydratePaidBrandOutputs(
  resultKind: string,
  textValue: string | undefined,
  parameters?: Record<string, unknown>,
): { value: string; outputValues: Record<string, string> } | undefined {
  if (typeof textValue !== "string") return;
  const contract = Object.values(PAID_BRAND_OUTPUTS).find(
    (candidate) => candidate.resultKind === resultKind,
  );
  if (!contract) return;

  // Legacy/corrupt snapshots retain the exact nominal primary port only. Never
  // invent auxiliary values or fall back to a generic `text` cable.
  const fallback = {
    value: textValue,
    outputValues: { [contract.primaryPort]: textValue },
  };
  const raw = parameters?.brandOutputPorts;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fallback;
  const snapshot = raw as Record<string, unknown>;
  const values = snapshot.values;
  if (
    snapshot.version !== 1 ||
    !values ||
    typeof values !== "object" ||
    Array.isArray(values)
  ) return fallback;
  const record = values as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [...contract.ports].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    expected.some((port) => typeof record[port] !== "string") ||
    record[contract.primaryPort] !== textValue
  ) return fallback;
  return { value: textValue, outputValues: record as Record<string, string> };
}

export function paidBrandResultKind(kind: NodeKind): string {
  const result = PAID_BRAND_RESULT_KINDS[
    kind as keyof typeof PAID_BRAND_RESULT_KINDS
  ];
  if (!result) throw new Error(`Node ${kind} ist kein bezahltes Brand-Ergebnis.`);
  return result;
}

export function providerResultTargetCurrent(input: {
  providerPersisted: boolean;
  providerTargetCurrent?: boolean;
  paidTargetCurrent?: boolean;
  libraryActive?: boolean;
}): boolean {
  if (input.providerPersisted) return input.providerTargetCurrent !== false;
  if (input.paidTargetCurrent !== undefined) return input.paidTargetCurrent;
  if (input.libraryActive !== undefined) return input.libraryActive;
  return true;
}

/** Persist siblings before the active scalar. The authoritative run cost is
 * written once with variant zero, which is attached last and can therefore
 * only become active after every sibling was stored successfully. */
export function providerVariantPersistencePlan(
  count: number,
  totalCostMicrounits?: number,
): { index: number; activate: boolean; costMicrounits?: number }[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > 100)
    throw new Error("Die Variantenanzahl ist ungültig.");
  const order = count === 1
    ? [0]
    : [...Array.from({ length: count - 1 }, (_, index) => index + 1), 0];
  return order.map((index) => ({
    index,
    activate: index === 0,
    ...(index === 0 && totalCostMicrounits != null
      ? { costMicrounits: totalCostMicrounits }
      : {}),
  }));
}

export function passiveInputSignature(
  targetNodeId: string,
  edges: readonly { id: string; source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }[],
  nodes: readonly FlowNode[],
): string {
  return JSON.stringify(
    edges
      .filter((edge) => edge.target === targetNodeId)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((edge) => {
        const source = nodes.find((node) => node.id === edge.source);
        const sourcePort = edge.sourceHandle?.split("::")[0] ?? "";
        const active = source?.data.history?.find((item) => item.active);
        return [
          edge.id,
          sourcePort,
          edge.targetHandle?.split("::")[0] ?? "",
          source?.data.status,
          active?.id,
          source?.data.outputValues?.[sourcePort] ?? source?.data.value,
        ];
      }),
  );
}
