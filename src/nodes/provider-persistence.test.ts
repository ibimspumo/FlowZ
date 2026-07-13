import { describe, expect, it } from "vitest";
import {
  hydratePaidBrandOutputs,
  paidBrandOutputSnapshot,
  paidBrandResultKind,
  providerResultTargetCurrent,
  providerVariantPersistencePlan,
  passiveInputSignature,
} from "./provider-persistence";

describe("provider persistence contracts", () => {
  it("uses the exact Rust brand result discriminants", () => {
    expect(paidBrandResultKind("audienceAnalysis")).toBe(
      "brand-audienceAnalysis",
    );
    expect(paidBrandResultKind("brandNames")).toBe("brand-brandNames");
    expect(paidBrandResultKind("colorPalette")).toBe("brand-colorPalette");
    expect(paidBrandResultKind("fontPairing")).toBe("brand-fontPairing");
    expect(() => paidBrandResultKind("textGeneration")).toThrow(/kein bezahltes/i);
  });

  it("round-trips every paid Brand cable output without a generic fallback", () => {
    const pairing = '{"artifact":"flowz.font-pairing"}';
    const snapshot = paidBrandOutputSnapshot("fontPairing", {
      pairing,
      styleHint: "Editorial, warm, high contrast",
    });
    expect(
      hydratePaidBrandOutputs("brand-fontPairing", pairing, {
        brandOutputPorts: snapshot,
      }),
    ).toEqual({
      value: pairing,
      outputValues: {
        pairing,
        styleHint: "Editorial, warm, high contrast",
      },
    });
  });

  it("fails closed to the nominal primary port for legacy or inconsistent snapshots", () => {
    const pairing = '{"artifact":"flowz.font-pairing"}';
    expect(hydratePaidBrandOutputs("brand-fontPairing", pairing)).toEqual({
      value: pairing,
      outputValues: { pairing },
    });
    expect(
      hydratePaidBrandOutputs("brand-fontPairing", pairing, {
        brandOutputPorts: {
          version: 1,
          values: { pairing: "different", styleHint: "must not leak" },
        },
      }),
    ).toEqual({ value: pairing, outputValues: { pairing } });
  });

  it("never upgrades an inactive durable result to active UI state", () => {
    expect(
      providerResultTargetCurrent({
        providerPersisted: false,
        paidTargetCurrent: false,
      }),
    ).toBe(false);
    expect(
      providerResultTargetCurrent({
        providerPersisted: false,
        libraryActive: false,
      }),
    ).toBe(false);
    expect(
      providerResultTargetCurrent({
        providerPersisted: true,
        providerTargetCurrent: false,
      }),
    ).toBe(false);
  });

  it("persists siblings first and records one authoritative run cost", () => {
    expect(providerVariantPersistencePlan(3, 42_000)).toEqual([
      { index: 1, activate: false },
      { index: 2, activate: false },
      { index: 0, activate: true, costMicrounits: 42_000 },
    ]);
    expect(providerVariantPersistencePlan(1, 7)).toEqual([
      { index: 0, activate: true, costMicrounits: 7 },
    ]);
  });

  it("changes a passive-node signature when its connected source changes", () => {
    const edge = { id: "names-handle", source: "names", target: "handle", sourceHandle: "names", targetHandle: "names" };
    const source = (value: string) => ({
      id: "names",
      type: "module",
      position: { x: 0, y: 0 },
      data: { kind: "brandNames", label: "Namen", status: "fresh", updatePolicy: "manual", value, outputValues: { names: value } },
    }) as import("../types").FlowNode;
    expect(passiveInputSignature("handle", [edge], [source("alpha")]))
      .not.toBe(passiveInputSignature("handle", [edge], [source("beta")]));
  });
});
