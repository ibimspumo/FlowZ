import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectDocument } from "./domain";

const projectPersistence = vi.hoisted(() => ({
  listProjects: vi.fn(),
  openProject: vi.fn(),
}));
const libraryPersistence = vi.hoisted(() => ({
  loadProjectResults: vi.fn(),
  loadLibraryResultData: vi.fn(),
}));

vi.mock("./persistence/projects", () => ({
  ...projectPersistence,
  isDesktopRuntime: () => true,
  createProject: vi.fn(),
  saveProject: vi.fn(),
  ProjectConflictError: class ProjectConflictError extends Error {},
}));
vi.mock("./persistence/library", () => ({
  ...libraryPersistence,
  deleteLibraryResult: vi.fn(),
  setActiveLibraryResult: vi.fn(),
}));
vi.mock("./persistence/assets", () => ({
  getLibraryAssetContents: vi.fn(async () => []),
  getLibraryAssetContent: vi.fn(),
}));

const timestamp = "2026-07-13T10:00:00.000Z";
const definitions = [
  {
    id: "audience",
    moduleId: "brand.audience",
    resultKind: "brand-audienceAnalysis",
    primaryPort: "audience",
    config: { model: "test-model", prompt: "" },
  },
  {
    id: "names",
    moduleId: "brand.names",
    resultKind: "brand-brandNames",
    primaryPort: "names",
    config: {
      model: "test-model",
      candidateCount: 8,
      iteration: 0,
      prompt: "",
    },
  },
  {
    id: "palette",
    moduleId: "brand.color-palette",
    resultKind: "brand-colorPalette",
    primaryPort: "palette",
    config: { model: "test-model", paletteDirection: "" },
  },
  {
    id: "fonts",
    moduleId: "brand.font-pairing",
    resultKind: "brand-fontPairing",
    primaryPort: "pairing",
    config: {
      model: "test-model",
      fontPresetSeed: 0,
      fontMood: "modern",
      fontSpecimenText: "Klar gedacht. Schön erzählt.",
      headingFont: "Space Grotesk",
      headingFontVariant: 0,
      headingFontAxes: {},
      bodyFont: "Inter",
      bodyFontVariant: 0,
      bodyFontAxes: {},
    },
  },
] as const;

const project: ProjectDocument = {
  schemaVersion: 2,
  id: "project-brand-restart",
  name: "Brand restart",
  createdAt: timestamp,
  updatedAt: timestamp,
  graph: {
    nodes: definitions.map((definition) => ({
      id: definition.id,
      moduleId: definition.moduleId,
      moduleVersion: 1,
      position: { x: 0, y: 0 },
      config: definition.config,
      updatePolicy: "manual",
    })),
    edges: [],
    groups: [],
  },
  canvas: { viewport: { x: 0, y: 0, zoom: 1 } },
};

function fingerprint(moduleId: string, config: object) {
  return JSON.stringify({
    moduleId,
    moduleVersion: 1,
    config,
    inputs: [],
  });
}

function persistedResults(stale = false) {
  return definitions.map((definition, index) => {
    const value = `artifact-${definition.id}`;
    const values = definition.primaryPort === "pairing"
      ? { pairing: value, styleHint: "Editorial, warm" }
      : { [definition.primaryPort]: value };
    return {
      resultId: `result-${definition.id}`,
      runId: `run-${definition.id}`,
      projectId: project.id,
      nodeId: definition.id,
      kind: definition.resultKind,
      textValue: value,
      createdAt: new Date(Date.parse(timestamp) + index).toISOString(),
      parameters: {
        executionFingerprint: stale
          ? "obsolete"
          : fingerprint(definition.moduleId, definition.config),
        brandOutputPorts: { version: 1, values },
      },
      active: true,
    };
  });
}

describe("paid Brand restart hydration", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("window", {
      __TAURI_INTERNALS__: {},
      dispatchEvent: vi.fn(),
    });
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    projectPersistence.listProjects.mockResolvedValue([
      {
        id: project.id,
        name: project.name,
        updatedAt: timestamp,
        revision: 1,
        diagnosis: "healthy",
      },
    ]);
    projectPersistence.openProject.mockResolvedValue({ project, revision: 1 });
    libraryPersistence.loadLibraryResultData.mockResolvedValue(undefined);
  });

  it("restores exact nominal outputs, including the font style hint", async () => {
    libraryPersistence.loadProjectResults.mockResolvedValue(persistedResults());
    const { useFlowStore } = await import("./store");
    await useFlowStore.getState().initialize(project.id);

    const state = useFlowStore.getState();
    expect(state.projectError).toBeUndefined();
    expect(state.document?.graph.nodes.map((node) => node.id)).toEqual(
      definitions.map((definition) => definition.id),
    );
    const displays = state.runtimeDisplays;
    expect(displays.get("audience")).toMatchObject({
      status: "fresh",
      outputValues: { audience: "artifact-audience" },
    });
    expect(displays.get("names")).toMatchObject({
      status: "fresh",
      outputValues: { names: "artifact-names" },
    });
    expect(displays.get("palette")).toMatchObject({
      status: "fresh",
      outputValues: { palette: "artifact-palette" },
    });
    expect(displays.get("fonts")).toMatchObject({
      status: "fresh",
      outputValues: {
        pairing: "artifact-fonts",
        styleHint: "Editorial, warm",
      },
    });
    expect(displays.get("fonts")?.outputValues).not.toHaveProperty("text");
    expect(displays.get("fonts")?.history?.[0].outputValues).toEqual({
      pairing: "artifact-fonts",
      styleHint: "Editorial, warm",
    });
  });

  it("marks every fingerprinted paid Brand module stale after a mismatch", async () => {
    libraryPersistence.loadProjectResults.mockResolvedValue(persistedResults(true));
    const { useFlowStore } = await import("./store");
    await useFlowStore.getState().initialize(project.id);

    for (const definition of definitions)
      expect(useFlowStore.getState().runtimeDisplays.get(definition.id)?.status).toBe(
        "stale",
      );
  });
});
