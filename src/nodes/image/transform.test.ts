import { describe, expect, it } from 'vitest';
import { applyAspectFromHeight, applyAspectFromWidth, validateImageTransform, type ImageTransformRecipe } from './transform';
const recipe: ImageTransformRecipe = { mode:'fit',targetWidth:1024,targetHeight:1024,noUpscale:true,outputFormat:'png',quality:90,background:'#ffffff',cropX:0,cropY:0,cropWidth:1,cropHeight:1 };
describe('image transform config',()=>{it('rounds aspect dimensions deterministically',()=>{expect(applyAspectFromWidth(1000,'16:9')).toBe(563);expect(applyAspectFromHeight(1000,'9:16')).toBe(563)});it('validates pixel and crop limits',()=>{expect(validateImageTransform(recipe)).toEqual([]);expect(validateImageTransform({...recipe,targetWidth:10_000,targetHeight:10_000,cropWidth:2})).toHaveLength(2)});});
