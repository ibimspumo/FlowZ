import { beforeEach, describe, expect, it } from 'vitest';
import type { GraphNode, ProjectDocument } from './domain';
import { passiveNodeDisplay, useFlowStore } from './store';

const project:Pick<ProjectDocument,'id'|'createdAt'>={id:'project-1',createdAt:'2026-07-12T08:00:00.000Z'};
const node=(moduleId:string,config:GraphNode['config']):GraphNode=>({id:'source',moduleId,moduleVersion:1,position:{x:0,y:0},config,updatePolicy:'manual'});

describe('passive source hydration',()=>{
  beforeEach(async()=>{await useFlowStore.getState().initialize();useFlowStore.getState().reset();});
  it('rebuilds identical text and brand outputs from persisted config on every open',()=>{
    const text=node('core.text-input',{text:'Hallo'});const brief=node('brand.brief',{offer:'Flows',audience:'Solo-Founder',personality:'ruhig, präzise'});
    expect(passiveNodeDisplay(project,structuredClone(text))).toEqual({status:'fresh',value:'Hallo',outputValues:{text:'Hallo'},persisted:true});
    const first=passiveNodeDisplay(project,brief)!;const reopened=passiveNodeDisplay(project,structuredClone(brief))!;
    expect(reopened).toEqual(first);expect(JSON.parse(String(first.value))).toMatchObject({artifact:'flowz.brand-brief',id:'project-1:source:brief',data:{offer:'Flows',audience:'Solo-Founder',personality:['ruhig','präzise']}});
  });
  it('makes a freshly edited brand artifact available to downstream ports without a run',()=>{
    const store=useFlowStore.getState();const source=store.addNode('brandBrief');const target=store.addNode('audienceAnalysis');
    store.updateNode(source,{offer:'Lokale Flows',audience:'Solo-Founder',status:'fresh'},true);
    useFlowStore.getState().connect({source,sourceHandle:'brief',target,targetHandle:'brief'});
    const input=useFlowStore.getState().inputsForPort(target,'brief');
    expect(input).toHaveLength(1);expect(JSON.parse(input[0])).toMatchObject({artifact:'flowz.brand-brief',data:{offer:'Lokale Flows',audience:'Solo-Founder'}});
    expect(useFlowStore.getState().nodes.find((item)=>item.id===source)?.data.status).toBe('fresh');
  });
});
