import {afterEach,describe,expect,it,vi} from 'vitest';
import {BrowserFontRegistry,FontPreviewLoader} from './font-preview-loader';
import {findFont} from '../nodes/brand';

describe('font preview loader',()=>{
  it('bounds concurrency and does not start an aborted queued preview',async()=>{const loader=new FontPreviewLoader(1),font=findFont('Inter');let active=0,max=0;const run=async()=>{active+=1;max=Math.max(max,active);await new Promise(resolve=>setTimeout(resolve,5));active-=1;return{blobHash:'a'.repeat(64),licenseBlobHash:'b'.repeat(64),mediaUrl:'flowz-media://localhost/a'};};const one=loader.load(font,new AbortController().signal,run);const controller=new AbortController();const two=loader.load(font,controller.signal,run);controller.abort();await one;await expect(two).rejects.toMatchObject({name:'AbortError'});expect(max).toBe(1);});
});

describe('browser font registry',()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it('waits for the real FontFace before exposing its family and reuses it',async()=>{const add=vi.fn(),remove=vi.fn(),load=vi.fn();class FakeFontFace{family:string;constructor(family:string,public source:string){this.family=family;}async load(){load();return this;}}vi.stubGlobal('FontFace',FakeFontFace);vi.stubGlobal('document',{fonts:{add,delete:remove}});const registry=new BrowserFontRegistry(2);const prepared={mediaUrl:'data:font/ttf;base64,AA==',fontSha256:'a'.repeat(64)};const first=await registry.load('Inter:0',prepared);const second=await registry.load('Inter:0',prepared);expect(first).toBe(second);expect(add).toHaveBeenCalledOnce();expect(load).toHaveBeenCalledOnce();expect(registry.has('Inter:0')).toBe(true);});
});
