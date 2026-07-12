import { describe, expect, it } from 'vitest';
import { artifact, buildContrastMatrix, buildHandlePlan, contrastRatio, domainSlug, normalizeNameCandidates, parseArtifact, stableNameId } from './artifacts';
import { GOOGLE_FONTS, GOOGLE_FONTS_SNAPSHOT, validateFontRecord } from './fonts';
import { audienceSchema, namesSchema, paletteSchema } from './schemas';

describe('brand artifacts', () => {
  it('wraps versioned JSON artifacts and rejects unversioned input', () => {
    const value=artifact('flowz.brand-brief',{brandName:'',offer:'Produkt',audience:'Founder',problem:'',promise:'',personality:[],differentiators:[],constraints:[]});expect(parseArtifact(JSON.stringify(value)).artifact).toBe('flowz.brand-brief');
    expect(()=>parseArtifact('{"offer":"Produkt"}')).toThrow(/Brand-Artefakt/);
  });
  it('normalizes stable candidates without inventing trademark checks', () => {
    const first=normalizeNameCandidates({candidates:[{name:'München Flow',rationale:'präzise',domainSlug:'muenchen-flow'}]},2);
    const again=normalizeNameCandidates({candidates:[{name:'München Flow',rationale:'neu',domainSlug:'muenchen-flow'}]},3);
    expect(first.candidates[0]).toMatchObject({id:stableNameId('München Flow'),domainSlug:'muenchen-flow',trademarkChecked:false});
    expect(again.candidates[0].id).toBe(first.candidates[0].id);expect(domainSlug('  Café & Studio ')).toBe('cafe-studio');
  });
  it('computes deterministic WCAG ratios from sRGB', () => {
    expect(contrastRatio('#000000','#FFFFFF')).toBe(21);
    expect(buildContrastMatrix([{role:'text',hex:'#111111'},{role:'background',hex:'#FFFFFF'}])).toEqual([{foreground:'text',background:'background',ratio:18.88,aaNormal:true,aaLarge:true}]);
  });
  it('creates only syntax guidance and official manual handle links', () => {
    const plan=buildHandlePlan('flowz_app');expect(plan.links).toHaveLength(6);expect(plan.links.every(link=>link.note.includes('keine Verfügbarkeitsaussage'))).toBe(true);expect(plan.disclaimer).toMatch(/scrapt keine/);
  });
  it('pins the complete selectable catalog to one official commit and declared licenses', () => {
    expect(GOOGLE_FONTS_SNAPSHOT.commit).toMatch(/^[a-f0-9]{40}$/);expect(GOOGLE_FONTS_SNAPSHOT.families).toHaveLength(2020);expect(GOOGLE_FONTS.length).toBeGreaterThan(2000);expect(GOOGLE_FONTS.every(validateFontRecord)).toBe(true);expect(GOOGLE_FONTS.find(font=>font.family==='Roboto Mono')).toMatchObject({axes:['wght']});
  });
  it('keeps strict JSON schemas closed and bounded', () => {
    expect(audienceSchema.additionalProperties).toBe(false);expect(namesSchema.properties.candidates.maxItems).toBe(20);expect(paletteSchema.properties.colors.maxItems).toBe(6);
  });
});
