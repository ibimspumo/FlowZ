import {describe,expect,it} from 'vitest';
import {findFont,GOOGLE_FONT_CATALOG,searchFonts,validateFontRecord} from './fonts';

describe('complete pinned Google Fonts catalog',()=>{
  it('contains every generated metadata family with normalized variants, licenses and paths',()=>{expect(GOOGLE_FONT_CATALOG).toHaveLength(2020);expect(GOOGLE_FONT_CATALOG.every(font=>font.variants.length>0&&font.metadataSha256.match(/^[a-f0-9]{64}$/))).toBe(true);expect(new Set(GOOGLE_FONT_CATALOG.map(font=>font.license))).toEqual(new Set(['OFL','APACHE2','UFL']));});
  it('searches deterministically by family, category, script and variable capability',()=>{expect(searchFonts('Roboto Mono',{category:'monospace',subset:'latin',variableOnly:true})[0].family).toBe('Roboto Mono');expect(searchFonts('definitely-missing')).toEqual([]);});
  it('selects an exact variant and clamps axis values',()=>{const base=findFont('Roboto Flex');const italic=base.variants.findIndex(item=>item.style==='italic');const selected=findFont('Roboto Flex',italic<0?0:italic,{wght:99999});expect(selected.variantIndex).toBe(italic<0?0:italic);expect(selected.axisRanges.find(axis=>axis.tag==='wght')?.value).toBe(selected.axisRanges.find(axis=>axis.tag==='wght')?.max);expect(validateFontRecord(selected)).toBe(true);});
});
