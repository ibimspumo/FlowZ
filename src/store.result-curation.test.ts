import { describe, expect, it } from 'vitest';
import { resolveConnectedOutput } from './store';
import type { FlowNodeData } from './types';

const source = { kind: 'imageGeneration', label: 'Bild', status: 'fresh', updatePolicy: 'manual', value: 'active', outputValues: { images: ['one', 'two'], 'variant:old': 'old' } } satisfies FlowNodeData;

describe('curated output resolution', () => {
  it('flattens a real image list for downstream reference inputs', () => {
    expect(resolveConnectedOutput(source, 'images', 'imageList')).toEqual(['one', 'two']);
  });

  it('never substitutes the active scalar for a missing immutable miniport', () => {
    expect(resolveConnectedOutput(source, 'variant:missing', 'image')).toEqual([]);
    expect(resolveConnectedOutput(source, 'variant:old', 'image')).toEqual(['old']);
  });

  it('never coerces a typed list socket to the active scalar', () => {
    expect(resolveConnectedOutput(source, 'texts', 'textList')).toEqual([]);
    expect(resolveConnectedOutput({ ...source, outputValues: { texts: ['a', 'b'] } }, 'texts', 'textList')).toEqual(['a', 'b']);
    expect(resolveConnectedOutput(source, 'videos', 'videoList')).toEqual([]);
  });
});
