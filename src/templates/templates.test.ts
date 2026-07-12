import { describe, expect, it } from 'vitest';
import { canvasTemplates, templateById } from './registry';
import { materializeTemplate } from './materialize';
import { migrateTemplate } from './types';
import { validateTemplate } from './validation';
import { inferredPaidNodeCount } from './validation';
import { CommandBus } from '../state/command-bus';
import * as commands from '../state/commands';
import { CURRENT_SCHEMA_VERSION, type ProjectDocument } from '../domain';
import { localizeTemplateMeta, setLocale } from '../i18n';
import { localizedCanonicalNodeLabel } from '../i18n-schema';

describe('canvas templates', () => {
  it('keeps every bundled template compatible, acyclic and uniquely identified', () => {
    expect(new Set(canvasTemplates.map((template) => template.id)).size).toBe(canvasTemplates.length);
    for (const template of canvasTemplates) expect(validateTemplate(template), template.name).toEqual([]);
  });

  it('places the top-left template boundary exactly at the requested canvas point', () => {
    setLocale('de');
    const ids = Array.from({ length: 100 }, (_, index) => `id-${index}`); let cursor = 0;
    const graph = materializeTemplate(canvasTemplates[0], { x: 431, y: -120 }, () => ids[cursor++]);
    expect(Math.min(...graph.nodes.map((node) => node.position.x))).toBe(431);
    expect(Math.min(...graph.nodes.map((node) => node.position.y))).toBe(-120);
    expect(graph.edges.every((edge) => graph.nodes.some((node) => node.id === edge.sourceNodeId) && graph.nodes.some((node) => node.id === edge.targetNodeId))).toBe(true);
  });

  it('localizes newly inserted template labels without mutating bundled content or prompts',()=>{setLocale('en');const source=canvasTemplates[0];const before=structuredClone(source);const graph=materializeTemplate(source,{x:0,y:0},(()=>{let id=0;return()=>String(id++);})());expect(source).toEqual(before);expect(source.name).toBe('Marke von Grund auf');expect(graph.nodes[0].label).toBe('01 · Markenbriefing');expect(graph.nodes[0].labelId).toBe('template:brand-foundry:brief');expect(localizedCanonicalNodeLabel(graph.nodes[0].labelId,'brandBrief',String(graph.nodes[0].label))).toBe('01 · Brand brief');const thumbnail=canvasTemplates.find(item=>item.id==='thumbnail-lab')!;const prompt=thumbnail.nodes.find(node=>node.id==='prompts')?.config?.prompt;materializeTemplate(thumbnail,{x:0,y:0});expect(thumbnail.nodes.find(node=>node.id==='prompts')?.config?.prompt).toBe(prompt);setLocale('de');});

  it('can be inserted and undone as one transaction', () => {
    const empty: ProjectDocument = { schemaVersion: CURRENT_SCHEMA_VERSION, id:'project',name:'Test',createdAt:'now',updatedAt:'now',graph:{nodes:[],edges:[],groups:[]},canvas:{viewport:{x:0,y:0,zoom:1}} };
    const bus = new CommandBus(empty, 10, () => 'later');
    const graph = materializeTemplate(templateById('image-transform')!, { x: 10, y: 20 }, (() => { let id=0; return () => `id-${id++}`; })());
    bus.runTransaction('Vorlage einsetzen', () => {
      graph.nodes.forEach((node) => bus.execute(commands.addNode(node)));
      graph.edges.forEach((edge) => bus.execute(commands.connect(edge)));
      graph.groups.forEach((group) => bus.execute(commands.addGroup(group)));
    });
    expect(bus.current.graph.nodes).toHaveLength(2);
    expect(bus.undoDepth).toBe(1);
    expect(bus.undo().graph).toEqual(empty.graph);
  });

  it('returns a detached migrated copy and rejects unknown schema versions', () => {
    const migrated = migrateTemplate(canvasTemplates[0]);
    expect(migrated).toEqual(canvasTemplates[0]);
    expect(migrated).not.toBe(canvasTemplates[0]);
    expect(() => migrateTemplate({ ...canvasTemplates[0], schemaVersion: 2 as 1 })).toThrow(/Vorlagen-Version/);
  });

  it('reports invalid ports, duplicate scalar inputs and cycles', () => {
    const invalid = structuredClone(templateById('image-transform')!);
    invalid.edges.push({ source:'transform',sourcePort:'missing',target:'input',targetPort:'missing' });
    expect(validateTemplate(invalid).map((issue) => issue.message).join(' ')).toMatch(/Ausgang|Eingang|Zyklus/);
  });

  it('keeps declared provider counts and manifest-bound configs truthful', () => {
    for (const template of canvasTemplates) {
      expect(template.paidNodeCount, template.name).toBe(inferredPaidNodeCount(template));
      expect(validateTemplate(template).filter((issue) => issue.path.includes('config')), template.name).toEqual([]);
    }
    const thumbnail = canvasTemplates.find((template) => template.id === 'thumbnail-lab')!;
    expect(thumbnail.nodes.find((node) => node.kind === 'imageGeneration')?.config?.variants).toBe(4);
    expect(thumbnail.nodes.map((node) => node.kind)).toEqual(expect.arrayContaining(['brandBrief','fontPairing','colorPalette','artboard']));
    expect(thumbnail.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({source:'images',sourcePort:'image',target:'artboard',targetPort:'images'}),
      expect.objectContaining({source:'fonts',sourcePort:'pairing',target:'artboard',targetPort:'fonts'}),
      expect.objectContaining({source:'palette',sourcePort:'palette',target:'artboard',targetPort:'palette'}),
    ]));
    expect(thumbnail.nodes.every((node) => node.updatePolicy === undefined || node.updatePolicy === 'manual')).toBe(true);
    const chain = canvasTemplates.find((template) => template.id === 'video-chain')!;
    expect(chain.nodes.filter((node) => node.kind === 'videoGeneration').map((node) => node.config?.model)).toEqual([
      'bytedance/seedance-2.0/fast/text-to-video','bytedance/seedance-2.0/fast/image-to-video',
    ]);
  });

  it('ships the complete brand-foundry path into a compact artboard bridge', () => {
    const template = templateById('brand-foundry')!;
    expect(template.nodes.map((node) => `${node.id}:${node.kind}`)).toEqual([
      'brief:brandBrief','audience:audienceAnalysis','names:brandNames','domains:domainCheck','handles:handlePlan',
      'fonts:fontPairing','palette:colorPalette','logo:logoDesign','trim:imageTrimTransparent','artboard:artboard',
    ]);
    expect(template.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({source:'brief',sourcePort:'brief',target:'logo',targetPort:'brief'}),
      expect.objectContaining({source:'audience',sourcePort:'audience',target:'logo',targetPort:'audience'}),
      expect.objectContaining({source:'palette',sourcePort:'palette',target:'logo',targetPort:'palette'}),
      expect.objectContaining({source:'logo',sourcePort:'image',target:'trim',targetPort:'image'}),
      expect.objectContaining({source:'fonts',sourcePort:'pairing',target:'artboard',targetPort:'fonts'}),
      expect.objectContaining({source:'trim',sourcePort:'image',target:'artboard',targetPort:'images'}),
    ]));
  });

  it('keeps transparency diagnosis local and cloud correction explicitly optional', () => {
    const template = templateById('transparent-logo-kit')!;
    const edge = (source:string,target:string) => template.edges.some((item) => item.source === source && item.target === target);
    expect(edge('logo','diagnose')).toBe(true);
    expect(edge('logo','remove')).toBe(true);
    expect(edge('diagnose','remove')).toBe(false);
    expect(edge('remove','trimCloud')).toBe(true);
    expect(template.nodes.find((node) => node.id === 'logo')?.config).toMatchObject({background:'transparent',outputFormat:'png'});
    expect(template.nodes.find((node) => node.id === 'remove')?.label).toMatch(/Optional/);
    const grouped = new Set(template.groups.flatMap((group) => group.nodeIds));
    expect(grouped).toEqual(new Set(['brief','logo','diagnose','artboard']));
    expect(['remove','upscale','trimCloud'].every((id) => !grouped.has(id))).toBe(true);
  });

  it('feeds real brand artifacts into the social artboard', () => {
    const template = templateById('social-artboard')!;
    expect(template.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({source:'palette',sourcePort:'palette',target:'artboard',targetPort:'palette'}),
      expect.objectContaining({source:'fonts',sourcePort:'pairing',target:'artboard',targetPort:'fonts'}),
      expect.objectContaining({source:'fonts',sourcePort:'styleHint',target:'image',targetPort:'prompt'}),
      expect.objectContaining({source:'image',sourcePort:'image',target:'artboard',targetPort:'images'}),
    ]));
  });

  it('inserts every template stale and manual without persisted run state', () => {
    const forbidden = ['status','history','outputValues','resultId','runId','cost','costMicrounits'];
    for (const template of canvasTemplates) {
      expect(template.firstRun.trim().length, template.name).toBeGreaterThan(0);
      const graph = materializeTemplate(template,{x:0,y:0},(()=>{let id=0;return()=>`${template.id}-${id++}`;})());
      expect(graph.nodes.every((node) => node.updatePolicy === 'manual'),template.name).toBe(true);
      for (const node of graph.nodes) for (const key of forbidden) expect(node.config,`${template.name}:${node.id}:${key}`).not.toHaveProperty(key);
    }
    const invalid = structuredClone(templateById('brand-foundry')!);
    invalid.nodes[1].updatePolicy = 'auto';
    expect(validateTemplate(invalid).some((issue) => issue.path.endsWith('updatePolicy'))).toBe(true);
  });

  it('localizes the first-run contract and all new brand labels without changing prompts', () => {
    setLocale('en');
    const source = templateById('brand-foundry')!; const before = structuredClone(source);
    const localized = localizeTemplateMeta(source);
    expect(localized.firstRun).toContain('deliberately start');
    expect(localized.nodes.find((node) => node.id === 'artboard')?.label).toBe('10 · Brand artboard');
    expect(localized.nodes.find((node) => node.id === 'trim')?.label).toBe('09 · Trim transparency');
    expect(source).toEqual(before);
    setLocale('de');
  });

  it('reports unavailable node kinds without throwing or dereferencing them', () => {
    const invalid = structuredClone(templateById('image-transform')!);
    invalid.nodes[0].kind = 'futureMissingNode' as typeof invalid.nodes[0]['kind'];
    expect(() => validateTemplate(invalid)).not.toThrow();
    expect(validateTemplate(invalid).some((issue) => /nicht verfügbar/.test(issue.message))).toBe(true);
  });
});
