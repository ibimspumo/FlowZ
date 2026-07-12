import { beforeEach, describe, expect, it } from 'vitest';
import { displayParameters, persistedMedia, persistedTranscriptionTimestamps, useFlowStore } from './store';

describe('media runtime/result truth', () => {
  beforeEach(async () => { await useFlowStore.getState().initialize(); useFlowStore.getState().reset(); });
  it('keeps imported media out of structural command history/config', () => {
    const store = useFlowStore.getState(); const id = store.addNode('videoInput');
    store.updateNode(id, { value: 'a'.repeat(64), blobHash: 'a'.repeat(64), mediaType: 'video/mp4', fileName: 'clip.mp4', mediaMetadata: { kind: 'video', container: 'mp4', codecs: ['h264'], durationSeconds: 1, width: 1280, height: 720, fps: 25, playable: true }, status: 'fresh', persisted: true });
    expect(useFlowStore.getState().document?.graph.nodes.find((node) => node.id === id)?.config).toEqual({});
    expect(useFlowStore.getState().nodes.find((node) => node.id === id)?.data.blobHash).toBe('a'.repeat(64));
  });
  it('reconstructs an active persisted media result after reload without a data URL', () => {
    const display = persistedMedia({ resultId: 'r', runId: 'run', projectId: 'p', nodeId: 'n', kind: 'input-video', blobHash: 'a'.repeat(64), mediaType: 'video/mp4', createdAt: 'now', active: true, parameters: { durationSeconds: 1, container: 'mp4', codecs: 'h264', width: 1280, height: 720, fps: 25, playable: true, fileName: 'clip.mp4' } });
    expect(display).toMatchObject({ value: 'a'.repeat(64), blobHash: 'a'.repeat(64), fileName: 'clip.mp4', mediaMetadata: { playable: true } });
    expect(JSON.stringify(display)).not.toContain('data:');
  });
  it('normalizes database-v6 media results written before playable existed', () => {
    const display = persistedMedia({ resultId: 'legacy', runId: 'run', projectId: 'p', nodeId: 'n', kind: 'input-audio', blobHash: 'a'.repeat(64), mediaType: 'audio/wav', createdAt: 'now', active: true, parameters: { durationSeconds: 1, container: 'wav', codecs: 'pcm_s16le', sampleRate: 48_000, channels: 2, fileName: 'legacy.wav' } });
    expect(display?.mediaMetadata?.playable).toBe(true);
  });
  it('restores transcription provenance and typed timestamps identically before and after reload', () => {
    const parameters = {
      language: 'de', sourceProjectId: 'p', sourceNodeId: 'audio', sourceResultId: 'source', sourceBlobHash: 'a'.repeat(64),
      timestampData: { segments: [{ start: 0, end: 1.2, text: 'Hallo' }], words: [{ start: 0, end: 0.4, text: 'Hallo' }] },
    };
    expect(displayParameters(parameters)).toEqual({ language: 'de', sourceProjectId: 'p', sourceNodeId: 'audio', sourceResultId: 'source', sourceBlobHash: 'a'.repeat(64) });
    expect(persistedTranscriptionTimestamps(parameters)).toEqual({ segments: [{ start: 0, end: 1.2, text: 'Hallo' }], words: [{ start: 0, end: 0.4, text: 'Hallo' }] });
  });
});
