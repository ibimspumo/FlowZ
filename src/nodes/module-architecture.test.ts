import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { NodeKind } from "../types";
import { canonicalNodeRegistry, MODULE_ID_BY_KIND } from ".";
import { AppNodeHost } from "../components/AppNodeHost";

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

const nodesRoot = fileURLToPath(new URL(".", import.meta.url));

function productionNodeSources(directory = nodesRoot): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return productionNodeSources(path);
    if (!/[.]tsx?$/.test(entry) || /[.]test[.]tsx?$/.test(entry)) return [];
    return [path];
  });
}

function resolveNodeImport(importer: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const candidate = resolve(dirname(importer), specifier);
  return [
    candidate,
    `${candidate}.ts`,
    `${candidate}.tsx`,
    join(candidate, "index.ts"),
    join(candidate, "index.tsx"),
  ].find((path) => existsSync(path) && extname(path).startsWith(".ts"));
}

function nodeImportCycles(files: string[]): string[][] {
  const known = new Set(files.map(normalize));
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const imports = Array.from(
      readFileSync(file, "utf8").matchAll(
        /(?:import|export)\s+(?:[^'\"]*?\s+from\s+)?["'](\.[^"']+)["']/g,
      ),
      (match) => resolveNodeImport(file, match[1]),
    ).filter((dependency): dependency is string =>
      Boolean(dependency && known.has(normalize(dependency))),
    );
    graph.set(normalize(file), imports.map(normalize));
  }

  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const visit = (file: string) => {
    visited.add(file);
    active.add(file);
    stack.push(file);
    for (const dependency of graph.get(file) ?? []) {
      if (!visited.has(dependency)) visit(dependency);
      else if (active.has(dependency)) {
        const cycleStart = stack.indexOf(dependency);
        cycles.push([...stack.slice(cycleStart), dependency]);
      }
    }
    stack.pop();
    active.delete(file);
  };
  for (const file of graph.keys()) if (!visited.has(file)) visit(file);
  return cycles;
}

describe("product node module architecture", () => {
  const extractedKinds = Object.keys(MODULE_ID_BY_KIND) as Array<
    Exclude<NodeKind, "unsupported">
  >;
  it("registers every current product node as a concrete module with module-owned view and execution", () => {
    const expected = Object.keys(MODULE_ID_BY_KIND) as Array<
      Exclude<NodeKind, "unsupported">
    >;
    expect(expected).toHaveLength(29);
    for (const kind of expected) {
      const module = canonicalNodeRegistry.forKind(kind);
      expect(module.id).toBe(MODULE_ID_BY_KIND[kind]);
      expect(module.viewAdapter).toEqual({
        kind: "module",
        layout: "complete",
      });
      expect(module.execution.kind).toBe("native");
      expect(["function", "object"]).toContain(typeof module.Body);
      expect(typeof module.execution.execute).toBe("function");
    }
    const productModules = expected.map((kind) =>
      canonicalNodeRegistry.forKind(kind),
    );
    expect(new Set(productModules.map((module) => module.Body)).size).toBe(
      productModules.length,
    );
    expect(
      new Set(productModules.map((module) => module.execution.execute)).size,
    ).toBe(productModules.length);
  });

  it("keeps host and dispatcher generic and removes the retired bridge vocabulary", () => {
    const host = source("../components/AppNodeHost.tsx");
    const dispatcher = source("./dispatch.ts");
    const engine = source("../engine/node-module.ts");
    const registry = source("./index.ts");
    const combined = `${host}\n${dispatcher}\n${engine}\n${registry}`;
    expect(host).not.toMatch(/\.metadata\.kind|node\.kind|switch\s*\(/);
    expect(dispatcher).not.toMatch(/\.metadata\.kind|node\.kind|switch\s*\(/);
    expect(combined).not.toMatch(
      /legacy-flow-node|legacyNodeDefinitions|LegacyFlowNode|legacyBody|interactive\??:\s*\{\s*execute|InteractiveNodeView|registerInteractiveNodeRenderer|defineInteractiveNodeModule/,
    );
  });

  it("removes the retired interactive renderer bridge from production", () => {
    expect(existsSync(fileURLToPath(new URL("../components/FlowNode.tsx", import.meta.url)))).toBe(false);
    expect(existsSync(join(nodesRoot, "interactive-module.tsx"))).toBe(false);
    expect(existsSync(join(nodesRoot, "interactive-view.tsx"))).toBe(false);
    const production = productionNodeSources()
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(production).not.toMatch(
      /FlowNodeBody|InteractiveNodeView|registerInteractiveNodeRenderer|defineInteractiveNodeModule/,
    );
  });

  it("uses the single kind-agnostic canvas host and can mount every registered product body", () => {
    const app = source("../App.tsx");
    const adapter = source("../components/ModuleNodeComponent.tsx");
    expect(app).toContain("flowNode: ModuleNodeComponent");
    expect(app).not.toContain("FlowNodeComponent");
    expect(adapter).toContain("<AppNodeHost");
    expect(adapter).not.toMatch(/switch\s*\(/);
    for (const kind of extractedKinds) {
      const module = canonicalNodeRegistry.forKind(kind);
      const node = { id: `node-${kind}`, moduleId: module.id, moduleVersion: module.version, position: { x: 0, y: 0 }, config: module.defaultConfig, updatePolicy: "manual" as const };
      expect(() => renderToStaticMarkup(createElement(AppNodeHost, { module, node, selected: false, status: "idle", runtimeProps: { id: node.id, selected: false, data: { kind, label: module.metadata.label.fallback, status: "idle", updatePolicy: "manual", ...module.defaultConfig } } })), kind).not.toThrow();
    }
  });

  it("sources concrete module records from bounded product domains", () => {
    for (const path of [
      "./core/modules.ts",
      "./context/modules.ts",
      "./ai/modules.ts",
      "./image/modules.ts",
      "./video/modules.ts",
      "./brand/modules.ts",
    ]) {
      const moduleSource = source(path);
      expect(moduleSource).toContain("defineConcreteAppNodeModule");
      expect(moduleSource).toMatch(/export const \w+AppModule/);
    }
  });

  it("makes interactive renderer back-delegation structurally impossible for extracted modules", () => {
    const concreteFactory = source("./concrete-app-module.tsx");
    expect(concreteFactory).not.toContain("InteractiveNodeView");
    expect(concreteFactory).toMatch(/Body:\s*import\("react"\)\.ComponentType/);
    expect(concreteFactory).not.toMatch(/Body\?/);
    for (const kind of extractedKinds) {
      const module = canonicalNodeRegistry.forKind(kind);
      expect(module.execution.kind).toBe("native");
      expect(module.viewAdapter).toEqual({
        kind: "module",
        layout: "complete",
      });
    }
    const concreteSources = `${source("./core/modules.ts")}\n${source("./context/modules.ts")}\n${source("./ai/modules.ts")}\n${source("./image/modules.ts")}\n${source("./image/logo-module.ts")}\n${source("./video/modules.ts")}\n${source("./brand/modules.ts")}`;
    for (const kind of extractedKinds) {
      expect(
        canonicalNodeRegistry.forKind(kind).Body,
        `${kind} must own a module body`,
      ).toBeDefined();
    }
    expect(concreteSources).not.toContain("defineInteractiveNodeModule");
    expect(concreteSources).not.toContain("InteractiveNodeView");
  });

  it("keeps registry, host and dispatcher free of concrete product-kind routing", () => {
    const genericBoundaries = [
      source("../components/AppNodeHost.tsx"),
      source("./dispatch.ts"),
      source("./index.ts"),
    ].join("\n");
    for (const kind of extractedKinds) {
      expect(genericBoundaries).not.toContain(`case \"${kind}\"`);
      expect(genericBoundaries).not.toContain(`case '${kind}'`);
      expect(genericBoundaries).not.toMatch(
        new RegExp(`(?:kind|type)\\s*[!=]==?\\s*[\"']${kind}[\"']`),
      );
    }
  });

  it("does not reintroduce a central product-kind switch in production nodes", () => {
    const production = productionNodeSources()
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(production).not.toMatch(
      /switch\s*\([^)]*(?:node[.]kind|data[.]kind|metadata[.]kind)[^)]*\)/,
    );
    for (const kind of extractedKinds) {
      expect(production).not.toContain(`case \"${kind}\"`);
      expect(production).not.toContain(`case '${kind}'`);
    }
  });

  it("has no static import cycles between production node modules", () => {
    const cycles = nodeImportCycles(productionNodeSources()).map((cycle) =>
      cycle.map((path) => path.slice(nodesRoot.length)),
    );
    expect(cycles).toEqual([]);
  });
});
