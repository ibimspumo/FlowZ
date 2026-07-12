import { describe, expect, it } from 'vitest';
import { artifact } from './artifacts';
import { registry } from '../../registry';
import { buildLogoPrompt } from './logo-prompt';

describe('brand visuals', () => {
  it('builds a constrained logo prompt from typed artifacts without legal claims', () => {
    const brief = JSON.stringify(artifact('flowz.brand-brief',{brandName:'Kern',offer:'Werkzeug',audience:'Solo-Founder',problem:'Chaos',promise:'Klarheit',personality:['präzise'],differentiators:[],constraints:[]}));
    const prompt = buildLogoPrompt({ brief, instruction:'Geometrisch' });
    expect(prompt).toContain('Kern'); expect(prompt).toContain('Geometrisch'); expect(prompt).toContain('keine Markenrechts-');
  });

  it('ships the logo transparency contract and typed visual outputs as defaults', () => {
    expect(registry.logoDesign.defaults).toMatchObject({ model:'fal-ai/gpt-image-1.5',background:'transparent',outputFormat:'png' });
    expect(registry.logoDesign.outputs.map((port)=>port.type)).toEqual(['image','imageList']);
    expect(registry.artboard.outputs.map((port)=>port.id)).toEqual(['artboard','image','images']);
  });
});
