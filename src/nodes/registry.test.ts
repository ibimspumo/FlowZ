import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { migrateProject } from "../domain/migrations";
import { scalarType } from "../domain/values";
import { areValueTypesCompatible } from "../engine/compatibility";
import { canonicalStringify, createNodeFingerprintPayload } from "../engine/fingerprint";
import {
  defineAppNodeModule,
  executeAppNodeModule,
  type NodeIconProps,
  type NodeViewProps,
} from "../engine/node-module";
import { configPatchFor, kindForModule, moduleForKind, nodeToFlow, validateNodeForAppRegistry } from "../app/adapters";
import { registry } from "../registry";
import { AppNodeHost, nodeForModuleView } from "../components/AppNodeHost";
import type { NodeKind } from "../types";
import { dispatchAppNodeExecution } from "./dispatch";
import {
  MODULE_ID_BY_KIND,
  canonicalNodeRegistry,
  defineCanonicalNodeRegistry,
} from ".";

describe("canonical application node registry", () => {
  it("owns every persistable module id exactly once without changing durable identity", () => {
    const expected = Object.entries(MODULE_ID_BY_KIND) as Array<
      [Exclude<NodeKind, "unsupported">, string]
    >;
    const persisted = canonicalNodeRegistry.modules.filter((module) => module.persistable);
    expect(persisted).toHaveLength(expected.length);
    expect(new Set(persisted.map((module) => module.id)).size).toBe(persisted.length);
    for (const [kind, moduleId] of expected) {
      const module = canonicalNodeRegistry.forKind(kind);
      expect(module).toMatchObject({ id: moduleId, version: 1, persistable: true });
      expect(moduleForKind(kind)).toBe(moduleId);
      expect(kindForModule(moduleId)).toBe(kind);
      const prior = createNodeFingerprintPayload({ moduleId, moduleVersion: 1, config: module.defaultConfig, bindings: [] });
      const modular = createNodeFingerprintPayload({ moduleId: module.id, moduleVersion: module.version, config: module.defaultConfig, bindings: [] });
      expect(canonicalStringify(modular)).toBe(canonicalStringify(prior));
    }
    expect(configPatchFor("textInput", { value: "unchanged" })).toEqual({ text: "unchanged" });
  });

  it("derives the complete public definition only from canonical modules", () => {
    for (const kind of Object.keys(canonicalNodeRegistry.byKind) as NodeKind[]) {
      const publicDefinition = registry[kind];
      const module = canonicalNodeRegistry.forKind(kind);
      expect(publicDefinition).toEqual({
        kind,
        label: module.metadata.label.fallback,
        description: module.metadata.description.fallback,
        category: module.metadata.category.fallback,
        inputs: module.inputs.map((port) => ({
        id: port.id,
        label: port.label,
        type: port.dataType,
        ...(port.valueType.artifact ? { artifact: port.valueType.artifact } : {}),
        ...(port.optional ? { optional: true } : {}),
        ...(port.multiple !== undefined ? { multiple: port.multiple } : {}),
        })),
        outputs: module.outputs.map((port) => ({ id: port.id, label: port.label, type: port.dataType, ...(port.valueType.artifact ? { artifact: port.valueType.artifact } : {}) })),
        defaults: module.defaultConfig,
        ...(module.visibility === "hidden" ? { hidden: true } : {}),
      });
    }
  });

  it("keeps Brand JSON payloads nominally distinct in the canonical registry", () => {
    const brief=canonicalNodeRegistry.forKind("brandBrief").outputs[0].valueType;
    const audience=canonicalNodeRegistry.forKind("audienceAnalysis").outputs[0].valueType;
    const names=canonicalNodeRegistry.forKind("brandNames").outputs[0].valueType;
    expect(brief).toMatchObject({kind:"scalar",scalar:"json",artifact:"flowz.brand-brief"});
    expect(areValueTypesCompatible(brief,canonicalNodeRegistry.forKind("brandNames").inputs[0].valueType)).toBe(true);
    expect(areValueTypesCompatible(brief,audience)).toBe(false);
    expect(areValueTypesCompatible(names,canonicalNodeRegistry.forKind("domainCheck").inputs[0].valueType)).toBe(true);
    expect(areValueTypesCompatible(audience,canonicalNodeRegistry.forKind("domainCheck").inputs[0].valueType)).toBe(false);
    expect(canonicalNodeRegistry.forKind("artboard").inputs.map((port)=>port.valueType.artifact)).toEqual(["flowz.color-palette","flowz.font-pairing",undefined,undefined]);
  });

  it("rejects duplicate app ids, kinds and ports", () => {
    const module = canonicalNodeRegistry.forKind("textInput");
    expect(() => defineCanonicalNodeRegistry([module, module])).toThrow(/Duplicate app module id/);
    expect(() => defineCanonicalNodeRegistry([
      module,
      { ...module, id: "fixture.other" },
    ])).toThrow(/Duplicate app module kind/);
    expect(() => defineCanonicalNodeRegistry([{ ...module, id: "fixture.ports", metadata: { ...module.metadata, kind: "fixturePorts" }, outputs: [module.outputs[0], module.outputs[0]] }]))
      .toThrow(/Duplicate output port/);
  });

  it("routes a product run through its concrete native executor without runtime back-delegation", async () => {
    const module = canonicalNodeRegistry.forKind("textInput");
    const node = {
      id: "text-node", moduleId: module.id, moduleVersion: module.version,
      position: { x: 0, y: 0 }, config: module.defaultConfig, updatePolicy: "manual" as const,
    };
    const result = await dispatchAppNodeExecution(module, node, {
      signal: new AbortController().signal,
      inputs: {},
    });
    expect(result.outputs.text).toEqual({ kind: "scalar", value: { type: "text", value: module.defaultConfig.value } });
  });

  it("supports a self-contained native fixture through register, render, connect, execute and persistence", async () => {
    type Config = { text: string };
    const Body = ({ node }: NodeViewProps<Config>) => createElement("span", null, node.config.text);
    const Icon = ({ size = 16 }: NodeIconProps) => createElement("i", { style: { width: size } });
    const fixture = defineAppNodeModule({
      id: "fixture.echo",
      version: 1,
      persistable: true,
      visibility: "public",
      metadata: {
        kind: "fixtureEcho",
        label: { key: "fixture.echo.label", fallback: "Echo" },
        description: { key: "fixture.echo.description", fallback: "Fixture" },
        category: { key: "category.fixture", fallback: "Fixture" },
      },
      inputs: [{ id: "input", label: "Text", labelKey: "fixture.echo.input", dataType: "text", valueType: scalarType("text") }],
      outputs: [{ id: "output", label: "Text", labelKey: "fixture.echo.output", dataType: "text", valueType: scalarType("text") }],
      defaultConfig: { text: "hello" },
      validateConfig: (config): config is Config => typeof config.text === "string",
      Icon,
      Body,
      viewAdapter: { kind: "module" },
      execution: {
        kind: "native",
        execute: async (node) => ({ outputs: { output: { kind: "scalar", value: { type: "text", value: node.config.text } } } }),
      },
      runLabel: { key: "fixture.echo.run", fallback: "Echo" },
    });
    const fixtureRegistry = defineCanonicalNodeRegistry([fixture]);
    expect(fixtureRegistry.get(fixture.id)).toBe(fixture);
    const node = {
      id: "node", moduleId: fixture.id, moduleVersion: fixture.version,
      position: { x: 0, y: 0 }, config: fixture.defaultConfig, updatePolicy: "manual" as const,
    };
    const registered = fixtureRegistry.get(fixture.id)!;
    expect(nodeToFlow(node, undefined, fixtureRegistry).data).toMatchObject({ kind: "fixtureEcho", label: "Echo" });
    expect(renderToStaticMarkup(createElement(AppNodeHost, { module: registered, node, selected: false, status: "fresh" }))).toContain("hello");
    expect(areValueTypesCompatible(fixture.outputs[0].valueType, fixture.inputs[0].valueType)).toBe(true);
    const context = { signal: new AbortController().signal, inputs: {} };
    const result = await dispatchAppNodeExecution(registered, node, context);
    expect(result).toBeDefined();
    if (!result) throw new Error("Native fixture returned no result.");
    expect(result.outputs.output).toEqual({ kind: "scalar", value: { type: "text", value: "hello" } });
    expect(() => validateNodeForAppRegistry(node, fixtureRegistry)).not.toThrow();
    const invalidNodes = [
      { ...node, moduleId: "fixture.wrong" },
      { ...node, moduleVersion: 2 },
      { ...node, config: { text: 42 } },
    ];
    for (const invalid of invalidNodes) {
      await expect(executeAppNodeModule(fixture, invalid as typeof node, context)).rejects.toThrow();
    }
    expect(() => validateNodeForAppRegistry(invalidNodes[1] as typeof node, fixtureRegistry)).toThrow(/version/);
    expect(() => validateNodeForAppRegistry(invalidNodes[2] as typeof node, fixtureRegistry)).toThrow(/config/);
    expect(() => nodeToFlow(invalidNodes[1] as typeof node, undefined, fixtureRegistry)).toThrow(/version/);
    expect(() => nodeToFlow(invalidNodes[2] as typeof node, undefined, fixtureRegistry)).toThrow(/config/);
    expect(canonicalNodeRegistry.modules.every((entry) => entry.execution.kind === "native")).toBe(true);
    const project = {
      schemaVersion: 2 as const, id: "00000000-0000-4000-8000-000000000001", name: "Fixture",
      createdAt: "2026-07-12T00:00:00Z", updatedAt: "2026-07-12T00:00:00Z",
      graph: { nodes: [node], edges: [], groups: [] }, canvas: { viewport: { x: 0, y: 0, zoom: 1 } },
    };
    expect(migrateProject(JSON.parse(JSON.stringify(project))).project).toEqual(project);
  });

  it("renders unknown persisted modules only through the inert unsupported view", async () => {
    const unsupported = canonicalNodeRegistry.forKind("unsupported");
    const unknown = {
      id: "unknown", moduleId: "removed.module", moduleVersion: 99,
      position: { x: 0, y: 0 },
      config: { kind: "textGeneration", prompt: "must not run" },
      updatePolicy: "manual" as const,
    };
    const viewNode = nodeForModuleView(unsupported, unknown);
    expect(viewNode).toMatchObject({
      id: unknown.id,
      moduleId: unsupported.id,
      moduleVersion: unsupported.version,
      config: {},
    });
    expect(() => nodeForModuleView(canonicalNodeRegistry.forKind("textGeneration"), unknown)).toThrow(/module id/);
    await expect(dispatchAppNodeExecution(unsupported, unknown, {
      signal: new AbortController().signal,
      inputs: {},
    })).rejects.toThrow(/module id/);
  });
});
