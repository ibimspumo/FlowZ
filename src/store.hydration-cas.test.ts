import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectDocument } from './domain';

const projectPersistence = vi.hoisted(() => ({
  listProjects: vi.fn(),
  openProject: vi.fn(),
}));
const libraryPersistence = vi.hoisted(() => ({
  loadProjectResults: vi.fn(),
  loadLibraryResultData: vi.fn(),
}));
const assetPersistence = vi.hoisted(() => ({
  getLibraryAssetContents: vi.fn(),
}));

vi.mock('./persistence/projects', () => ({
  ...projectPersistence,
  isDesktopRuntime: () => true,
  createProject: vi.fn(),
  saveProject: vi.fn(),
  ProjectConflictError: class ProjectConflictError extends Error {},
}));
vi.mock('./persistence/library', () => ({
  ...libraryPersistence,
  deleteLibraryResult: vi.fn(),
  setActiveLibraryResult: vi.fn(),
}));
vi.mock('./persistence/assets', () => ({
  ...assetPersistence,
  getLibraryAssetContent: vi.fn(),
}));

const hash = (character: string) => character.repeat(64);
const timestamp = '2026-07-13T10:00:00.000Z';
const project: ProjectDocument = {
  schemaVersion: 2,
  id: 'project-cas',
  name: 'CAS hydration',
  createdAt: timestamp,
  updatedAt: timestamp,
  graph: {
    nodes: [
      { id: 'images', moduleId: 'ai.image-generation', moduleVersion: 1, position: { x: 0, y: 0 }, config: { model: 'google/nano-banana-2-lite', prompt: 'Test', aspectRatio: '1:1', resolution: '1K', outputFormat: 'png', variants: 1, safetyTolerance: '6', imageEndpointConfigs: {}, fanOutResultIds: ['image-2'] }, updatePolicy: 'manual' },
      { id: 'collection', moduleId: 'core.image-collection', moduleVersion: 1, position: { x: 200, y: 0 }, config: { collectionResultIds: ['image-1', 'image-2'] }, updatePolicy: 'frozen' },
      { id: 'webpage', moduleId: 'context.webpage', moduleVersion: 1, position: { x: 400, y: 0 }, config: { url: 'https://example.com', includeScreenshot: true }, updatePolicy: 'manual' },
      { id: 'asset', moduleId: 'library.asset-image', moduleVersion: 1, position: { x: 600, y: 0 }, config: { libraryAssetId: 'asset-1', assetVersionId: 'asset-version-1', assetVersion: 1, assetName: 'Hero', assetKind: 'image' }, updatePolicy: 'frozen' },
      { id: 'video', moduleId: 'ai.video-generation', moduleVersion: 1, position: { x: 800, y: 0 }, config: { model: 'bytedance/seedance-2.0/fast/text-to-video', prompt: '', duration: 4, resolution: '480p', aspectRatio: '16:9', generateAudio: false, bitrateMode: 'standard', variantCount: 1, listProcessingMode: 'aggregate', endpointConfigs: {} }, updatePolicy: 'manual' },
    ],
    edges: [],
    groups: [],
  },
  canvas: { viewport: { x: 0, y: 0, zoom: 1 } },
};

describe('persisted CAS hydration', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {}, dispatchEvent: vi.fn() });
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() });
    projectPersistence.listProjects.mockResolvedValue([{ id: project.id, name: project.name, updatedAt: timestamp, revision: 1, diagnosis: 'healthy' }]);
    projectPersistence.openProject.mockResolvedValue({ project, revision: 1 });
    libraryPersistence.loadProjectResults.mockResolvedValue([
      { resultId: 'image-1', runId: 'image-run', projectId: project.id, nodeId: 'images', kind: 'image', blobHash: hash('a'), mediaType: 'image/png', dataUrl: 'data:image/png;base64,ONE', createdAt: timestamp, active: true },
      { resultId: 'image-2', runId: 'image-run', projectId: project.id, nodeId: 'images', kind: 'image', blobHash: hash('b'), mediaType: 'image/webp', dataUrl: 'data:image/webp;base64,TWO', createdAt: '2026-07-13T10:00:01.000Z', active: false },
      { resultId: 'webpage-1', runId: 'webpage-run', projectId: project.id, nodeId: 'webpage', kind: 'webpage', textValue: 'Example', blobHash: hash('c'), mediaType: 'image/png', dataUrl: 'data:image/png;base64,SCREENSHOT', createdAt: timestamp, active: true },
      { resultId: 'video-1', runId: 'video-run', projectId: project.id, nodeId: 'video', kind: 'video', blobHash: hash('e'), mediaType: 'video/mp4', createdAt: timestamp, active: true, parameters: { durationSeconds: 4, container: 'mp4', codecs: 'h264', width: 854, height: 480, fps: 24, playable: true, variantCount: 1 } },
    ]);
    libraryPersistence.loadLibraryResultData.mockImplementation(async (_projectId: string, resultId: string) => resultId === 'image-1'
      ? 'data:image/png;base64,ONE'
      : resultId === 'image-2' ? 'data:image/webp;base64,TWO' : undefined);
    assetPersistence.getLibraryAssetContents.mockResolvedValue([{
      assetId: 'asset-1', versionId: 'asset-version-1', version: 1, name: 'Hero', kind: 'image',
      createdAt: timestamp, mediaType: 'image/png', blobHash: hash('d'), dataUrl: 'data:image/png;base64,ASSET',
    }]);
  });

  it('keeps image previews separate from CAS outputs and restores a playable video URL', async () => {
    const { useFlowStore } = await import('./store');
    await useFlowStore.getState().initialize(project.id);
    const state = useFlowStore.getState();
    expect(state.projectError).toBeUndefined();
    const displays = state.runtimeDisplays;

    expect(displays.get('images')).toMatchObject({
      value: 'data:image/png;base64,ONE',
      outputValues: {
        image: `flowz-cas:${hash('a')}`,
        images: [`flowz-cas:${hash('a')}`, `flowz-cas:${hash('b')}`],
        'variant:image-2': `flowz-cas:${hash('b')}`,
      },
    });
    expect(displays.get('images')?.history?.map((item) => item.value)).toEqual([
      'data:image/png;base64,ONE', 'data:image/webp;base64,TWO',
    ]);
    expect(displays.get('collection')).toMatchObject({
      value: 'data:image/png;base64,ONE',
      outputValues: {
        images: [`flowz-cas:${hash('a')}`, `flowz-cas:${hash('b')}`],
        'variant:image-1': `flowz-cas:${hash('a')}`,
        'variant:image-2': `flowz-cas:${hash('b')}`,
      },
    });
    expect(displays.get('webpage')).toMatchObject({
      value: 'Example',
      outputValues: { text: 'Example', image: `flowz-cas:${hash('c')}`, screenshot: `flowz-cas:${hash('c')}` },
    });
    expect(displays.get('asset')).toMatchObject({
      value: 'data:image/png;base64,ASSET', blobHash: hash('d'),
      outputValues: { image: `flowz-cas:${hash('d')}` },
    });
    expect(displays.get('video')).toMatchObject({
      value: `flowz-media://localhost/${hash('e')}`,
      blobHash: hash('e'),
      mediaMetadata: { kind: 'video', playable: true },
      outputValues: { video: `flowz-cas:${hash('e')}` },
    });
    expect(displays.get('video')?.value).not.toMatch(/^tauri:/);

    for (const display of displays.values()) {
      expect(JSON.stringify(display.outputValues ?? {})).not.toContain('data:image/');
    }
  });
});
