import { describe, expect, it } from 'vitest';
import { assertTextVariantSourceReady, composeTextPrompt } from './text-variant-semantics';

describe('text variant prompt semantics', () => {
  it('treats a local instruction without variants as the complete prompt', () => {
    expect(composeTextPrompt({ instruction: 'Schreibe einen Claim.', scalarInputs: [] }))
      .toBe('Schreibe einen Claim.');
  });

  it('keeps ordinary connected texts as shared context', () => {
    expect(composeTextPrompt({ instruction: 'Bewerte.', scalarInputs: ['Briefing'], variants: [] }))
      .toBe('Briefing\n\nBewerte.');
  });

  it('labels every sibling when processing all variants together', () => {
    expect(composeTextPrompt({ instruction: 'Bewerte.', scalarInputs: ['Briefing'], variants: ['A', 'B'], mode: 'aggregate' }))
      .toBe('Briefing\n\nVarianten in fester Reihenfolge:\n--- Variante 1 ---\nA\n--- Variante 2 ---\nB\n\nBewerte.');
  });

  it('selects exactly one sibling while preserving shared context in individual mode', () => {
    expect(composeTextPrompt({ instruction: 'Verbessere.', scalarInputs: ['Regeln'], variants: ['A', 'B'], mode: 'map', variantIndex: 1 }))
      .toBe('Regeln\n\nAktuelle Variante 2 von 2:\nB\n\nVerbessere.');
  });

  it('blocks a connected but not-yet-materialized variant source', () => {
    expect(() => assertTextVariantSourceReady(true, [])).toThrow(/zuerst aus/);
    expect(() => assertTextVariantSourceReady(false, [])).not.toThrow();
    expect(() => assertTextVariantSourceReady(true, ['A', 'B'])).not.toThrow();
  });
});
