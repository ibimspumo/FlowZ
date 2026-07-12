import { beforeEach, describe, expect, it } from 'vitest';
import { useFlowStore } from './store';

describe('asset node binding', () => {
  beforeEach(async () => {
    await useFlowStore.getState().initialize();
    useFlowStore.getState().reset();
  });

  it('keeps the replaced source fresh while invalidating downstream nodes', () => {
    const source = useFlowStore.getState().nodes.find((node) => node.id === 'prompt');
    const target = useFlowStore.getState().nodes.find((node) => node.id === 'generate');
    expect(source?.data.kind).toBe('textInput');
    expect(target).toBeDefined();
    useFlowStore.getState().updateNode(target!.id, { status: 'fresh', value: 'old', persisted: true });

    const replaced = useFlowStore.getState().bindAssetToNode(source!.id, {
      assetId: 'asset-1', versionId: 'version-7', version: 7, name: 'Master Prompt', kind: 'prompt',
      createdAt: '2026-07-11T08:00:00.000Z', text: 'Der gebundene Prompt',
    });

    expect(replaced).toBe(true);
    const nextSource = useFlowStore.getState().nodes.find((node) => node.id === source!.id);
    const nextTarget = useFlowStore.getState().nodes.find((node) => node.id === target!.id);
    expect(nextSource?.data).toMatchObject({
      kind: 'assetText', status: 'fresh', value: 'Der gebundene Prompt',
      assetVersionId: 'version-7', assetVersion: 7,
    });
    expect(nextTarget?.data.status).toBe('stale');

    useFlowStore.getState().undo();
    const undone = useFlowStore.getState().nodes.find((node) => node.id === source!.id);
    expect(undone?.data).toMatchObject({ kind: 'textInput', value: 'Beschreibe eine futuristische Kamera als hochwertiges Produktfoto.' });

    useFlowStore.getState().redo();
    const redone = useFlowStore.getState().nodes.find((node) => node.id === source!.id);
    expect(redone?.data).toMatchObject({ kind: 'assetText', status: 'fresh', value: 'Der gebundene Prompt', assetVersionId: 'version-7' });
  });

  it('restores the exact runtime value across image input replacement undo and redo', () => {
    const upload = useFlowStore.getState().nodes.find((node) => node.id === 'upload')!;
    useFlowStore.getState().updateNode(upload.id, {
      value: 'data:image/png;base64,ORIGINAL', outputValues: { image: 'data:image/png;base64,ORIGINAL' },
      status: 'fresh', persisted: true, fileName: 'original.png', assetId: 'upload-asset',
    });

    expect(useFlowStore.getState().bindAssetToNode(upload.id, {
      assetId: 'asset-image', versionId: 'version-image', version: 1, name: 'Library Hero', kind: 'image',
      createdAt: '2026-07-11T08:00:00.000Z', dataUrl: 'data:image/webp;base64,LIBRARY',
    })).toBe(true);
    expect(useFlowStore.getState().nodes.find((node) => node.id === upload.id)?.data).toMatchObject({
      kind: 'assetImage', value: 'data:image/webp;base64,LIBRARY', assetVersionId: 'version-image',
    });

    useFlowStore.getState().undo();
    expect(useFlowStore.getState().nodes.find((node) => node.id === upload.id)?.data).toMatchObject({
      kind: 'imageInput', value: 'data:image/png;base64,ORIGINAL', fileName: 'original.png', assetId: 'upload-asset',
    });
    useFlowStore.getState().redo();
    expect(useFlowStore.getState().nodes.find((node) => node.id === upload.id)?.data).toMatchObject({
      kind: 'assetImage', value: 'data:image/webp;base64,LIBRARY', assetVersionId: 'version-image',
    });
  });

  it('reconciles same-module asset-to-asset undo and redo by immutable version', () => {
    const prompt = useFlowStore.getState().nodes.find((node) => node.id === 'prompt')!;
    const bind = (version: number, text: string) => useFlowStore.getState().bindAssetToNode(prompt.id, {
      assetId: `asset-${version}`, versionId: `version-${version}`, version, name: `Prompt ${version}`, kind: 'prompt',
      createdAt: '2026-07-11T08:00:00.000Z', text,
    });
    expect(bind(1, 'Erste Version')).toBe(true);
    expect(bind(2, 'Zweite Version')).toBe(true);
    expect(useFlowStore.getState().nodes.find((node) => node.id === prompt.id)?.data.value).toBe('Zweite Version');

    useFlowStore.getState().undo();
    expect(useFlowStore.getState().nodes.find((node) => node.id === prompt.id)?.data).toMatchObject({
      assetVersionId: 'version-1', value: 'Erste Version', status: 'fresh',
    });
    useFlowStore.getState().redo();
    expect(useFlowStore.getState().nodes.find((node) => node.id === prompt.id)?.data).toMatchObject({
      assetVersionId: 'version-2', value: 'Zweite Version', status: 'fresh',
    });
  });

  it('restores a newly added image input on the first undo after asset binding', async () => {
    useFlowStore.setState({ phase: 'booting' });
    await useFlowStore.getState().initialize();
    const uploadId = useFlowStore.getState().addNode('imageInput', { x: 90, y: 480 });
    const upload = useFlowStore.getState().nodes.find((node) => node.id === uploadId)!;
    useFlowStore.getState().updateNode(upload.id, {
      value: 'data:image/png;base64,FIRST', outputValues: { image: 'data:image/png;base64,FIRST' },
      status: 'fresh', persisted: true, fileName: 'first.png', assetId: 'first-upload',
    });
    expect(useFlowStore.getState().canUndo).toBe(true);
    expect(useFlowStore.getState().bindAssetToNode(upload.id, {
      assetId: 'asset-open', versionId: 'version-open', version: 1, name: 'Opened Asset', kind: 'image',
      createdAt: '2026-07-11T08:00:00.000Z', dataUrl: 'data:image/png;base64,BOUND',
    })).toBe(true);

    useFlowStore.getState().undo();
    expect(useFlowStore.getState().nodes.find((node) => node.id === upload.id)?.data).toMatchObject({
      kind: 'imageInput', value: 'data:image/png;base64,FIRST', fileName: 'first.png', assetId: 'first-upload',
    });
  });
});
