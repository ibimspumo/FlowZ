import { describe, expect, it, vi } from 'vitest';
import { executeBrandNode } from './execute';
import { artifact, parseArtifact } from './artifacts';
import { checkBrandDomains } from '../../api';
import type { FlowNodeData } from '../../types';

vi.mock('../../api',()=>({prepareBrandFont:async(font:{fontSha256?:string;licenseSha256:string;family:string})=>{const fontSha256=font.fontSha256??(font.family==='Fraunces'?'a':'b').repeat(64);return{blobHash:fontSha256,licenseBlobHash:font.licenseSha256,fontSha256,mediaUrl:`flowz-media://localhost/${fontSha256}`};},checkBrandDomains:vi.fn(),runStructuredChat:vi.fn()}));

const data=(kind:FlowNodeData['kind'],patch:Partial<FlowNodeData>={}):FlowNodeData=>({kind,label:kind,status:'stale',updatePolicy:'manual',...patch});

describe('local brand node execution',()=>{
  it('creates an editable brief artifact with compact comma-separated traits',async()=>{
    const result=await executeBrandNode('brandBrief',data('brandBrief',{offer:'Lokale Kreativflows',audience:'Solo-Founder',personality:'ruhig, präzise'}),{});
    const parsed=parseArtifact(result.value);expect(parsed.artifact).toBe('flowz.brand-brief');expect((parsed.data as {personality:string[]}).personality).toEqual(['ruhig','präzise']);expect(result.output).toBe('brief');
  });
  it('builds handle guidance without checking availability',async()=>{
    const result=await executeBrandNode('handlePlan',data('handlePlan',{handle:'flowz_app'}),{});const parsed=parseArtifact(result.value);expect((parsed.data as {disclaimer:string}).disclaimer).toMatch(/keine Username-Verfügbarkeit/);expect(result.parameters.availabilityChecked).toBe(false);
  });
  it('checks a direct domain name without a connected naming artifact',async()=>{
    vi.mocked(checkBrandDomains).mockResolvedValueOnce([]);
    const result=await executeBrandNode('domainCheck',data('domainCheck',{domainName:' Café Studio ',privacyConsent:true,tlds:['com']}),{});
    expect(checkBrandDomains).toHaveBeenCalledWith(['cafe-studio'],['com'],true);
    expect(result.parameters.source).toBe('direct-override');
  });
  it('gives a visible direct override priority over the connected candidate',async()=>{
    vi.mocked(checkBrandDomains).mockResolvedValueOnce([]);
    const names=JSON.stringify(artifact('flowz.name-candidate-list',{iteration:0,candidates:[{id:'name-flowz',name:'FlowZ',rationale:'Aus dem Test',domainSlug:'flowz',trademarkChecked:false}]}));
    const result=await executeBrandNode('domainCheck',data('domainCheck',{domainName:'Other Name',privacyConsent:true,tlds:['de']}),{names:[names]});
    expect(checkBrandDomains).toHaveBeenCalledWith(['other-name'],['de'],true);
    expect(result.parameters.source).toBe('direct-override');
  });
  it('persists selected font source and OFL license in the artifact',async()=>{
    const result=await executeBrandNode('fontPairing',data('fontPairing',{headingFont:'Fraunces',bodyFont:'Inter'}),{});const parsed=parseArtifact(result.value);const pairing=parsed.data as {heading:{source:string;license:string};body:{source:string}};expect(pairing.heading.license).toBe('OFL-1.1');expect(pairing.heading.source).toContain(result.parameters.catalogCommit);expect(pairing.body.source).toContain(result.parameters.catalogCommit);
  });
});
