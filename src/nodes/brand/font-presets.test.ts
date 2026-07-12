import {describe,expect,it} from 'vitest';
import {FONT_MOODS,FONT_PAIR_PRESETS,fontPresetForSeed,fontPresetStyleHint,validateFontPairPreset} from './font-presets';

describe('font pairing presets',()=>{
  it('ships at least one hundred exact selectable licensed pairs across every mood',()=>{expect(FONT_PAIR_PRESETS.length).toBeGreaterThanOrEqual(100);expect(new Set(FONT_PAIR_PRESETS.map(item=>item.id)).size).toBe(FONT_PAIR_PRESETS.length);expect(new Set(FONT_PAIR_PRESETS.map(item=>item.mood))).toEqual(new Set(FONT_MOODS));expect(FONT_PAIR_PRESETS.every(validateFontPairPreset)).toBe(true);expect(FONT_PAIR_PRESETS.every(item=>item.headingFamily!==item.bodyFamily)).toBe(true);});
  it('rerolls reproducibly to a different valid preset',()=>{const first=fontPresetForSeed(42),again=fontPresetForSeed(42),next=fontPresetForSeed(43,first.id);expect(again.id).toBe(first.id);expect(next.id).not.toBe(first.id);expect(validateFontPairPreset(next)).toBe(true);expect(fontPresetStyleHint(next)).toMatch(/visuelle Annäherung/);});
});
