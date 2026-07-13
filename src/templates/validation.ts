import { registry } from '../registry';
import type { CanvasTemplate } from './types';
import { defaultFalImageConfig, falImageModel, validateFalImageConfig, type FalImageConfig } from '../nodes/image/capabilities';
import { BACKGROUND_REMOVAL_TOOL, defaultUpscaleConfig, falImageTool, validateUpscaleConfig, type UpscaleConfig } from '../nodes/image/tool-capabilities';
import { falVideoCapability, validateFalVideoConfig, type FalVideoEndpointConfig } from '../nodes/video/capabilities';
import { validateImageTransform, type ImageTransformRecipe } from '../nodes/image/transform';
import { canonicalNodeRegistry } from '../nodes';
import { materializedTemplateEdgeOrders } from './edge-order';
import { areProductPortsCompatible } from '../engine/compatibility';

export type TemplateIssue = { path: string; message: string };

export const PAID_TEMPLATE_KINDS = new Set([
  'research','textGeneration','imageGeneration','imageUpscale','backgroundRemoval','videoGeneration','imageAnalysis','transcription',
  'audienceAnalysis','brandNames','fontPairing','colorPalette','logoDesign',
]);

export function inferredPaidNodeCount(template: CanvasTemplate): number {
  return template.nodes.filter((node) => PAID_TEMPLATE_KINDS.has(node.kind)).length;
}

const NODE_WIDTH = 310;
const NODE_HEIGHT: Partial<Record<string, number>> = {
  textInput:260,imageInput:310,brandBrief:620,audienceAnalysis:520,brandNames:520,domainCheck:500,handlePlan:430,fontPairing:450,colorPalette:520,
  logoDesign:700,backgroundRemoval:520,imageUpscale:650,imageGeneration:720,artboard:720,research:520,textGeneration:650,
  videoGeneration:720,imageTransform:560,imageTrimTransparent:520,
};

function numberValue(value: unknown, fallback: number) { return typeof value === 'number' ? value : fallback; }
function stringValue(value: unknown, fallback: string) { return typeof value === 'string' ? value : fallback; }

function validateCapabilities(template: CanvasTemplate, issues: TemplateIssue[]) {
  for (const [index, node] of template.nodes.entries()) {
    const definition = registry[node.kind]; if (!definition) continue;
    const module = canonicalNodeRegistry.byKind[node.kind];
    const defaults = node.kind === 'textInput' ? {text:String(definition.defaults.value ?? '')} : (module?.defaultConfig ?? definition.defaults);
    const config = { ...defaults, ...node.config } as Record<string, unknown>;
    if (module && !module.validateConfig(config as never)) issues.push({path:`nodes[${index}].config`,message:'Node-Konfiguration entspricht nicht dem kanonischen Modul-Schema.'});
    if (node.kind === 'imageGeneration' || node.kind === 'logoDesign') {
      const model = falImageModel(String(config.model ?? ''));
      if (!model) { issues.push({ path:`nodes[${index}].config.model`,message:'Bildmodell fehlt im geprüften fal-Manifest.' }); continue; }
      const defaults = defaultFalImageConfig(model);
      const candidate: FalImageConfig = {
        ...defaults, inputFidelity:undefined, size:stringValue(config.resolution ?? config.size, defaults.size), aspectRatio:stringValue(config.aspectRatio, defaults.aspectRatio),
        outputFormat:stringValue(config.outputFormat, defaults.outputFormat), variants:numberValue(config.variants, defaults.variants),
        ...(typeof config.seed === 'number'?{seed:config.seed}:{}), ...(typeof config.quality === 'string'?{quality:config.quality}:{}),
        ...(typeof config.background === 'string'?{background:config.background}:{}),
        ...(typeof config.safetyTolerance === 'string'?{safetyTolerance:config.safetyTolerance}:{}),
      };
      for (const message of validateFalImageConfig(model,candidate,0,'Vorlagen-Prompt')) issues.push({path:`nodes[${index}].config`,message});
    }
    if (node.kind === 'videoGeneration') {
      const capability = falVideoCapability(String(config.model ?? ''));
      const occupied = {
        startFrame:template.edges.filter((edge)=>edge.target===node.id&&edge.targetPort==='startFrame').length,
        endFrame:template.edges.filter((edge)=>edge.target===node.id&&edge.targetPort==='endFrame').length,
        references:template.edges.filter((edge)=>edge.target===node.id&&['references','referenceLists'].includes(edge.targetPort)).length,
      };
      const candidate: FalVideoEndpointConfig = {duration:config.duration==='auto'?'auto':numberValue(config.duration,4),resolution:stringValue(config.resolution,'480p'),aspectRatio:stringValue(config.aspectRatio,'16:9'),generateAudio:Boolean(config.generateAudio),bitrateMode:config.bitrateMode==='high'?'high':'standard',...(typeof config.seed==='number'?{seed:config.seed}:{})};
      for (const message of validateFalVideoConfig(capability,candidate,occupied)) issues.push({path:`nodes[${index}].config`,message});
    }
    if (node.kind === 'imageUpscale') {
      const defaults=defaultUpscaleConfig(String(config.model)); const candidate={...defaults,...config,endpoint:String(config.model)} as UpscaleConfig;
      for(const message of validateUpscaleConfig(candidate)) issues.push({path:`nodes[${index}].config`,message});
    }
    if (node.kind === 'backgroundRemoval' && falImageTool(String(config.model??BACKGROUND_REMOVAL_TOOL))?.kind !== 'background-removal') issues.push({path:`nodes[${index}].config.model`,message:'Freistellungsmodell fehlt im geprüften fal-Manifest.'});
    if (node.kind === 'imageTransform') {
      const recipe:ImageTransformRecipe={mode:config.transformMode==='fill'?'fill':config.transformMode==='free'?'free':'fit',targetWidth:numberValue(config.targetWidth,1024),targetHeight:numberValue(config.targetHeight,1024),noUpscale:Boolean(config.noUpscale),outputFormat:config.outputFormat==='jpeg'?'jpeg':config.outputFormat==='webp'?'webp':'png',quality:numberValue(config.transformQuality,90),background:stringValue(config.transformBackground,'#ffffff'),cropX:numberValue(config.cropX,0),cropY:numberValue(config.cropY,0),cropWidth:numberValue(config.cropWidth,1),cropHeight:numberValue(config.cropHeight,1)};
      for(const message of validateImageTransform(recipe)) issues.push({path:`nodes[${index}].config`,message});
    }
  }
}

export function validateTemplate(template: CanvasTemplate): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  if (!template.firstRun.trim() || template.firstRun.length > 360) issues.push({path:'firstRun',message:'Der bewusste erste Lauf muss kompakt und verständlich beschrieben sein.'});
  if (!template.hints.length || template.hints.some((hint) => !hint.trim() || hint.length > 240)) issues.push({path:'hints',message:'Vorlagenhinweise müssen kompakt und verständlich sein.'});
  const nodeIds = new Set<string>();
  for (const [index, node] of template.nodes.entries()) {
    if (!node.id || nodeIds.has(node.id)) issues.push({ path: `nodes[${index}].id`, message: node.id ? 'Node-ID ist doppelt.' : 'Node-ID fehlt.' });
    nodeIds.add(node.id);
    if (!registry[node.kind] || node.kind === 'unsupported') issues.push({ path: `nodes[${index}].kind`, message: `Node ${node.kind} ist nicht verfügbar.` });
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) issues.push({ path: `nodes[${index}]`, message: 'Position ist ungültig.' });
    if (node.updatePolicy !== undefined && node.updatePolicy !== 'manual') issues.push({path:`nodes[${index}].updatePolicy`,message:'Vorlagen dürfen keine automatische Ausführung vorbereiten.'});
  }

  const adjacency = new Map(template.nodes.map((node) => [node.id, [] as string[]]));
  const occupied = new Set<string>();
  const resolvedOrders = materializedTemplateEdgeOrders(template);
  const orderedInputs = new Map<string, { index:number; order:number; multiple:boolean }[]>();
  for (const [index, edge] of template.edges.entries()) {
    const source = template.nodes.find((node) => node.id === edge.source);
    const target = template.nodes.find((node) => node.id === edge.target);
    if (!source || !target) { issues.push({ path: `edges[${index}]`, message: 'Verbindung verweist auf einen unbekannten Node.' }); continue; }
    const sourceDefinition = registry[source.kind]; const targetDefinition = registry[target.kind];
    if (!sourceDefinition || !targetDefinition) { issues.push({path:`edges[${index}]`,message:'Verbindung verwendet einen nicht verfügbaren Node-Typ.'}); continue; }
    const output = sourceDefinition.outputs.find((port) => port.id === edge.sourcePort);
    const input = targetDefinition.inputs.find((port) => port.id === edge.targetPort);
    if (!output) issues.push({ path: `edges[${index}].sourcePort`, message: 'Ausgang ist nicht verfügbar.' });
    if (!input) issues.push({ path: `edges[${index}].targetPort`, message: 'Eingang ist nicht verfügbar.' });
    if (output && input && !areProductPortsCompatible(output,input)) issues.push({ path: `edges[${index}]`, message: `${output.artifact??output.type} kann nicht mit ${input.artifact??input.type} verbunden werden.` });
    const targetKey = `${edge.target}\0${edge.targetPort}`;
    if (input && !input.multiple && occupied.has(targetKey)) issues.push({ path: `edges[${index}]`, message: 'Ein einzelner Eingang ist mehrfach belegt.' });
    if (edge.order !== undefined && (!Number.isSafeInteger(edge.order) || edge.order < 0)) issues.push({path:`edges[${index}].order`,message:'Reihenfolge muss eine nicht-negative Ganzzahl sein.'});
    if (input) orderedInputs.set(targetKey,[...(orderedInputs.get(targetKey)??[]),{index,order:resolvedOrders[index],multiple:Boolean(input.multiple)}]);
    occupied.add(targetKey);
    adjacency.get(edge.source)?.push(edge.target);
  }

  for (const entries of orderedInputs.values()) {
    const sorted = entries.map((entry)=>entry.order).sort((left,right)=>left-right);
    const expected = sorted.map((_,index)=>index);
    if (new Set(sorted).size !== sorted.length || sorted.some((order,index)=>order!==expected[index])) {
      for (const entry of entries) issues.push({path:`edges[${entry.index}].order`,message:'Reihenfolge muss je Mehrfacheingang eindeutig und lückenlos bei 0 beginnen.'});
    }
    if (!entries[0]?.multiple && sorted.some((order)=>order!==0)) {
      for (const entry of entries) issues.push({path:`edges[${entry.index}].order`,message:'Ein einzelner Eingang verwendet immer Reihenfolge 0.'});
    }
  }

  for (const [index, group] of template.groups.entries()) {
    if (group.nodeIds.length < 2) issues.push({ path: `groups[${index}]`, message: 'Eine Gruppe braucht mindestens zwei Nodes.' });
    if (group.nodeIds.some((id) => !nodeIds.has(id))) issues.push({ path: `groups[${index}].nodeIds`, message: 'Gruppe enthält einen unbekannten Node.' });
  }

  const visiting = new Set<string>(); const visited = new Set<string>();
  const hasCycle = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const next of adjacency.get(id) ?? []) if (hasCycle(next)) return true;
    visiting.delete(id); visited.add(id); return false;
  };
  if (template.nodes.some((node) => hasCycle(node.id))) issues.push({ path: 'edges', message: 'Vorlage enthält einen Zyklus.' });
  for (let left=0;left<template.nodes.length;left+=1) for(let right=left+1;right<template.nodes.length;right+=1){const a=template.nodes[left];const b=template.nodes[right];const aHeight=NODE_HEIGHT[a.kind]??520;const bHeight=NODE_HEIGHT[b.kind]??520;const overlap=a.x < b.x+NODE_WIDTH+24 && a.x+NODE_WIDTH+24 > b.x && a.y < b.y+bHeight+24 && a.y+aHeight+24 > b.y;if(overlap) issues.push({path:`nodes[${left}],nodes[${right}]`,message:`Layout überlappt: ${a.id} und ${b.id}.`});}
  if (template.paidNodeCount !== inferredPaidNodeCount(template)) issues.push({path:'paidNodeCount',message:`Kostenangabe ${template.paidNodeCount} passt nicht zu ${inferredPaidNodeCount(template)} Provider-Nodes.`});
  validateCapabilities(template,issues);
  return issues;
}

export function assertValidTemplate(template: CanvasTemplate): void {
  const issues = validateTemplate(template);
  if (issues.length) throw new Error(`Ungültige Vorlage „${template.name}“: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join(' ')}`);
}
