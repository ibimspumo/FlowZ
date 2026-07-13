import { describe, expect, it } from 'vitest';
import { BRAND_ARTIFACTS, nodeSpecifications } from './module-specifications';

describe('node product contracts', () => {
  it('keeps generic text generation text-only and delegates multimodal work to image analysis', () => {
    expect(nodeSpecifications.textGeneration.inputs.map((port) => [port.id, port.type])).toEqual([
      ['prompt', 'text'], ['textLists', 'textList'],
    ]);
    expect(nodeSpecifications.imageAnalysis.inputs.map((port) => port.id)).toEqual(expect.arrayContaining(['image', 'imageLists']));
  });

  it('accepts both scalar images and typed image lists on artboards', () => {
    expect(nodeSpecifications.artboard.inputs.map((port) => [port.id, port.type])).toEqual(expect.arrayContaining([
      ['images', 'image'], ['imageLists', 'imageList'],
    ]));
  });

  it('assigns every Brand JSON port its exact artifact identity',()=>{
    expect(nodeSpecifications.brandBrief.outputs[0].artifact).toBe(BRAND_ARTIFACTS.brief);
    expect(nodeSpecifications.audienceAnalysis.inputs[0].artifact).toBe(BRAND_ARTIFACTS.brief);
    expect(nodeSpecifications.brandNames.inputs.map((port)=>port.artifact)).toEqual([BRAND_ARTIFACTS.brief,BRAND_ARTIFACTS.audience]);
    expect(nodeSpecifications.domainCheck.inputs[0].artifact).toBe(BRAND_ARTIFACTS.names);
    expect(nodeSpecifications.handlePlan.inputs[0].artifact).toBe(BRAND_ARTIFACTS.names);
    expect(nodeSpecifications.fontPairing.outputs[0].artifact).toBe(BRAND_ARTIFACTS.fonts);
    expect(nodeSpecifications.colorPalette.outputs[0].artifact).toBe(BRAND_ARTIFACTS.palette);
    expect(nodeSpecifications.artboard.inputs.slice(0,2).map((port)=>port.artifact)).toEqual([BRAND_ARTIFACTS.palette,BRAND_ARTIFACTS.fonts]);
    expect(nodeSpecifications.artboard.outputs[0].artifact).toBe(BRAND_ARTIFACTS.artboard);
  });
});
