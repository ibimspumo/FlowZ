import { describe, expect, it } from 'vitest';
import { nodeRunLabel } from './node-run-labels';
import { setLocale } from '../i18n';

describe('contextual node actions', () => {
  it('names the task instead of the implementation primitive', () => {
    setLocale('de');
    expect(nodeRunLabel('imageGeneration', false)).toBe('Bild generieren');
    expect(nodeRunLabel('videoGeneration', true)).toBe('Video wird generiert …');
    expect(nodeRunLabel('domainCheck', false)).toBe('Domains prüfen');
    expect(nodeRunLabel('backgroundRemoval', false)).toBe('Freistellen');
    expect(nodeRunLabel('brandBrief', false)).toBeNull();
    expect(nodeRunLabel('artboard', false)).toBeNull();
    expect(nodeRunLabel('videoCollection', false)).toBeNull();
    setLocale('en');expect(nodeRunLabel('imageGeneration',false)).toBe('Generate image');expect(nodeRunLabel('transcription',true)).toBe('Transcribing audio …');setLocale('de');
  });
});
