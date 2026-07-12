import { describe, expect, it } from 'vitest';
import { aiNodeRegistry, transcriptionModule } from '.';
import { decodeProjectDocument } from '../../domain';

describe('transcription node module', () => {
  it('is visible as a typed audio-to-text module with valid defaults', () => {
    expect(aiNodeRegistry.get('ai.transcription')).toBe(transcriptionModule);
    expect(transcriptionModule.inputs[0]).toMatchObject({ id: 'audio', valueType: { kind: 'scalar', scalar: 'audio' } });
    expect(transcriptionModule.outputs[0]).toMatchObject({ id: 'text', valueType: { kind: 'scalar', scalar: 'text' } });
    expect(transcriptionModule.validateConfig?.(transcriptionModule.defaultConfig)).toBe(true);
  });

  it('rejects invalid persisted transcription configuration', () => {
    const base = {
      schemaVersion: 2, id: '00000000-0000-4000-8000-000000000001', name: 'STT',
      createdAt: '2026-07-11T00:00:00.000Z', updatedAt: '2026-07-11T00:00:00.000Z',
      graph: { nodes: [{ id: 'stt', moduleId: 'ai.transcription', moduleVersion: 1, position: { x: 0, y: 0 }, config: { model: 'openai/whisper-1', language: 'auto', timestamps: false }, updatePolicy: 'manual' }], edges: [], groups: [] },
      canvas: { viewport: { x: 0, y: 0, zoom: 1 } },
    };
    expect(decodeProjectDocument(base).graph.nodes[0].moduleId).toBe('ai.transcription');
    expect(() => decodeProjectDocument({ ...base, graph: { ...base.graph, nodes: [{ ...base.graph.nodes[0], config: { ...base.graph.nodes[0].config, language: 'de-DE' } }] } })).toThrow(/transcription config/);
    expect(transcriptionModule.validateConfig?.({ model: 'x'.repeat(201), language: 'auto', timestamps: false })).toBe(false);
    expect(() => decodeProjectDocument({ ...base, graph: { ...base.graph, nodes: [{ ...base.graph.nodes[0], config: { ...base.graph.nodes[0].config, model: 'x'.repeat(201) } }] } })).toThrow(/transcription config/);
  });
});
