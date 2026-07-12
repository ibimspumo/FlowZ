import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

describe('project persistence client', () => {
  beforeEach(() => {
    invoke.mockReset();
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
  });

  it('maps revision conflicts to a dedicated actionable error', async () => {
    invoke.mockRejectedValue('Speicherkonflikt: Das Projekt wurde zwischenzeitlich geändert. Bitte neu laden.');
    const { ProjectConflictError, saveProject } = await import('./projects');
    await expect(saveProject({ project: {} as never, expectedRevision: 2, expectedUpdatedAt: '2026-07-11T00:00:00Z' })).rejects.toBeInstanceOf(ProjectConflictError);
  });
});
