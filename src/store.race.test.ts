import { beforeEach, describe, expect, it } from 'vitest';
import { persistedResultMatchesFingerprint, useFlowStore } from './store';

describe('UI run freshness', () => {
  beforeEach(async () => {
    await useFlowStore.getState().initialize();
    useFlowStore.getState().reset();
  });

  it('keeps a completion historical when config changes during a run', () => {
    const node = useFlowStore.getState().nodes.find((item) => item.data.kind === 'imageGeneration');
    expect(node).toBeDefined();
    const id = node!.id;

    useFlowStore.getState().updateNode(id, { status: 'running' });
    useFlowStore.getState().updateNode(id, { prompt: 'Eine inzwischen geänderte Anweisung', status: 'stale' });
    const accepted = useFlowStore.getState().updateNode(id, {
      status: 'fresh', value: 'data:image/png;base64,OLD', persisted: true,
      history: [{ id: 'old-result', createdAt: new Date().toISOString(), value: 'data:image/png;base64,OLD', persisted: true }],
    });

    const current = useFlowStore.getState().nodes.find((item) => item.id === id)!;
    expect(accepted).toBe(false);
    expect(current.data.status).toBe('stale');
    expect(current.data.value).not.toBe('data:image/png;base64,OLD');
    expect(current.data.history?.[0].id).toBe('old-result');
  });

  it('hydrates an active result as fresh only for its exact execution fingerprint', () => {
    expect(persistedResultMatchesFingerprint({ executionFingerprint: 'same' }, 'same')).toBe(true);
    expect(persistedResultMatchesFingerprint({ inputFingerprint: { executionFingerprint: 'same' } }, 'same')).toBe(true);
    expect(persistedResultMatchesFingerprint({ executionFingerprint: 'old' }, 'new')).toBe(false);
    expect(persistedResultMatchesFingerprint(undefined, 'new')).toBe(false);
  });

  it('invalidates a run when a connected upstream value changes', () => {
    const prompt = useFlowStore.getState().nodes.find((item) => item.id === 'prompt')!;
    const target = useFlowStore.getState().nodes.find((item) => item.id === 'generate')!;
    useFlowStore.getState().updateNode(target.id, { status: 'running' });
    useFlowStore.getState().updateNode(prompt.id, { value: 'Neuer Upstream-Wert', status: 'idle' }, true);

    const accepted = useFlowStore.getState().updateNode(target.id, {
      status: 'fresh', value: 'data:image/png;base64,OLD', persisted: true,
    });

    expect(accepted).toBe(false);
    expect(useFlowStore.getState().nodes.find((item) => item.id === target.id)?.data.status).toBe('stale');
  });

  it('marks the directly affected target stale when an input edge is removed', () => {
    useFlowStore.getState().updateNode('generate', { status: 'running' });
    useFlowStore.getState().updateNode('generate', { status: 'fresh', value: 'data:image/png;base64,CURRENT', persisted: true });
    expect(useFlowStore.getState().nodes.find((item) => item.id === 'generate')?.data.status).toBe('fresh');

    useFlowStore.getState().deleteEdge('prompt-generate');

    expect(useFlowStore.getState().nodes.find((item) => item.id === 'generate')?.data.status).toBe('stale');
  });

  it('invalidates targets when their upstream node is deleted', () => {
    useFlowStore.getState().updateNode('analyse', { status: 'fresh', value: 'Alt', persisted: true });
    useFlowStore.getState().deleteNode('generate');
    expect(useFlowStore.getState().nodes.find((item) => item.id === 'analyse')?.data.status).toBe('stale');
  });

  it('propagates persisted config changes without every control opting in manually', () => {
    useFlowStore.getState().updateNode('analyse', { status: 'fresh', value: 'Alt', persisted: true });
    useFlowStore.getState().updateNode('generate', { prompt: 'Neue Bildanweisung', status: 'stale' });
    expect(useFlowStore.getState().nodes.find((item) => item.id === 'analyse')?.data.status).toBe('stale');
  });

  it('creates, renames, reload-ready persists, ungroups and restores groups through undo', () => {
    const store = useFlowStore.getState();
    const groupId = store.createGroup(['prompt', 'generate'], 'Kampagne');
    expect(groupId).toBeTruthy();
    expect(useFlowStore.getState().document?.graph.groups[0]).toMatchObject({ id: groupId, name: 'Kampagne', nodeIds: ['prompt', 'generate'] });
    useFlowStore.getState().renameGroup(groupId!, 'Launch');
    expect(useFlowStore.getState().document?.graph.groups[0].name).toBe('Launch');
    useFlowStore.getState().ungroup(groupId!);
    expect(useFlowStore.getState().document?.graph.groups).toEqual([]);
    useFlowStore.getState().undo();
    expect(useFlowStore.getState().document?.graph.groups[0].name).toBe('Launch');
  });

  it('rejects an in-flight transcription after the source audio changes', () => {
    const store = useFlowStore.getState();
    const audioId = store.addNode('audioInput');
    const transcriptionId = store.addNode('transcription');
    store.connect({ source: audioId, sourceHandle: 'audio', target: transcriptionId, targetHandle: 'audio' });
    store.updateNode(audioId, { value: 'a'.repeat(64), blobHash: 'a'.repeat(64), status: 'fresh', persisted: true }, true);
    store.updateNode(transcriptionId, { status: 'running' });
    store.updateNode(audioId, { value: 'b'.repeat(64), blobHash: 'b'.repeat(64), status: 'fresh', persisted: true }, true);

    const accepted = store.updateNode(transcriptionId, { status: 'fresh', value: 'Veraltetes Transkript', persisted: true });

    expect(accepted).toBe(false);
    expect(useFlowStore.getState().nodes.find((node) => node.id === transcriptionId)?.data.status).toBe('stale');
    expect(useFlowStore.getState().nodes.find((node) => node.id === transcriptionId)?.data.value).not.toBe('Veraltetes Transkript');
  });
});
