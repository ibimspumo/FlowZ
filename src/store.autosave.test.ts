import { beforeEach, describe, expect, it, vi } from 'vitest';

const persistence = vi.hoisted(() => ({ saveProject: vi.fn(), openProject: vi.fn(), listProjects: vi.fn(), createProject: vi.fn() }));

vi.mock('./persistence/projects', () => ({
  ...persistence,
  isDesktopRuntime: () => true,
  ProjectConflictError: class ProjectConflictError extends Error {},
}));
vi.mock('./persistence/library', () => ({ loadLibraryResultData: vi.fn(), loadProjectResults: vi.fn(async () => []) }));
vi.mock('./persistence/assets', () => ({ getLibraryAssetContents: vi.fn(async () => []), getLibraryAssetContent: vi.fn() }));

const project = (id: string, revision = 1) => {
  const timestamp = `2026-07-12T10:00:0${revision}.000Z`;
  return { schemaVersion: 2 as const, id, name: id, createdAt: timestamp, updatedAt: timestamp, graph: { nodes: [], edges: [], groups: [] }, canvas: { viewport: { x: 0, y: 0, zoom: 1 } } };
};

describe('gesture-aware autosave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    persistence.saveProject.mockReset();
    persistence.openProject.mockReset();
    persistence.listProjects.mockReset();
    persistence.createProject.mockReset();
    const storage = new Map<string, string>();
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
    persistence.listProjects.mockResolvedValue([{ id: 'a', name: 'a', updatedAt: project('a').updatedAt, revision: 1, diagnosis: 'healthy' }]);
    persistence.openProject.mockImplementation(async (id: string) => ({ project: project(id), revision: 1 }));
    persistence.saveProject.mockImplementation(async ({ project: value, expectedRevision }: { project: ReturnType<typeof project>; expectedRevision: number }) => ({ project: { ...value, updatedAt: `2026-07-12T10:00:0${expectedRevision + 1}.000Z` }, revision: expectedRevision + 1 }));
  });

  it('does not save during a drag longer than the debounce and starts exactly one debounce after release', async () => {
    vi.resetModules();
    const { SAVE_DELAY, useFlowStore } = await import('./store');
    await useFlowStore.getState().initialize('a');
    useFlowStore.getState().beginGesture();
    useFlowStore.getState().setViewport({ x: 120, y: 40, zoom: 1.1 });

    await vi.advanceTimersByTimeAsync(SAVE_DELAY * 3);
    expect(persistence.saveProject).not.toHaveBeenCalled();

    useFlowStore.getState().endGesture();
    await vi.advanceTimersByTimeAsync(SAVE_DELAY - 1);
    expect(persistence.saveProject).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(persistence.saveProject).toHaveBeenCalledTimes(1);
  });

  it('restarts the full debounce window for every new change', async () => {
    vi.resetModules();
    const { SAVE_DELAY, useFlowStore } = await import('./store');
    await useFlowStore.getState().initialize('a');
    useFlowStore.getState().setViewport({ x: 10, y: 0, zoom: 1 });
    await vi.advanceTimersByTimeAsync(SAVE_DELAY - 250);
    useFlowStore.getState().setViewport({ x: 20, y: 0, zoom: 1 });
    await vi.advanceTimersByTimeAsync(250);
    expect(persistence.saveProject).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SAVE_DELAY - 251);
    expect(persistence.saveProject).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(persistence.saveProject).toHaveBeenCalledTimes(1);
  });

  it('keeps the current project open when the mandatory switch flush fails', async () => {
    vi.resetModules();
    const { useFlowStore } = await import('./store');
    await useFlowStore.getState().initialize('a');
    useFlowStore.getState().setViewport({ x: 20, y: 0, zoom: 1 });
    persistence.saveProject.mockRejectedValueOnce(new Error('Datenträger voll'));

    await useFlowStore.getState().openExistingProject('b');

    expect(useFlowStore.getState().document?.id).toBe('a');
    expect(persistence.openProject).not.toHaveBeenCalledWith('b');
    expect(useFlowStore.getState().saveError).toMatch(/Datenträger voll/);
  });

  it('flushes pending changes before switching tabs and blocks a switch during an open gesture', async () => {
    vi.resetModules();
    const { useFlowStore } = await import('./store');
    await useFlowStore.getState().initialize('a');
    useFlowStore.getState().setViewport({ x: 20, y: 0, zoom: 1 });
    await useFlowStore.getState().openExistingProject('b');
    expect(persistence.saveProject).toHaveBeenCalledTimes(1);
    expect(persistence.openProject).toHaveBeenLastCalledWith('b');
    expect(useFlowStore.getState().document?.id).toBe('b');

    useFlowStore.getState().beginGesture();
    useFlowStore.getState().setViewport({ x: 40, y: 0, zoom: 1 });
    await useFlowStore.getState().openExistingProject('c');
    expect(persistence.openProject).not.toHaveBeenCalledWith('c');
    expect(useFlowStore.getState().document?.id).toBe('b');
    expect(useFlowStore.getState().saveError).toMatch(/Geste/);
    useFlowStore.getState().endGesture();
  });
});
