import type { DataType, NodeKind } from './types';
import { getLocale, localizedTemplateNodeLabel } from './i18n';

const NODE_LABEL_EN:Record<NodeKind,string>={
  unsupported:'Unsupported node',textInput:'Text input',imageInput:'Image import',videoInput:'Video import',audioInput:'Audio import',imageCollection:'Image selection',videoCollection:'Video selection',assetText:'Text asset',assetImage:'Image asset',
  textGeneration:'Text generation',imageGeneration:'Image generation',imageUpscale:'Upscale image',imageTransform:'Crop / resize image',imageTrimTransparent:'Trim transparency',backgroundRemoval:'Remove background',videoGeneration:'Video generation',videoFrame:'Extract video frame',imageAnalysis:'Image analysis',transcription:'Transcription',
  brandBrief:'Brand brief',audienceAnalysis:'Audience analysis',brandNames:'Brand names',domainCheck:'Check domains',handlePlan:'Social handles',fontPairing:'Font pairing',colorPalette:'Color palette',logoDesign:'Logo design',artboard:'Artboard',webpage:'Webpage',research:'Research',
};
const DESCRIPTION_EN:Record<NodeKind,string>={
  unsupported:'Module unavailable in this FlowZ version',textInput:'Prompt or context',imageInput:'Local reference',videoInput:'Import a local clip safely',audioInput:'Import a recording or audio file',imageCollection:'Immutable curated image list',videoCollection:'Immutable curated video list',assetText:'Read-only global asset version',assetImage:'Read-only global asset version',
  textGeneration:'Generate text with AI',imageGeneration:'Text to image',imageUpscale:'Increase resolution with fal.ai',imageTransform:'Local, precise, and free',imageTrimTransparent:'Trim transparent borders locally',backgroundRemoval:'Remove an image background with Bria',videoGeneration:'Turn text and images into video with fal.ai',videoFrame:'Extract the first, last, or any frame',imageAnalysis:'Understand an image',transcription:'Convert audio accurately into text',
  brandBrief:'Compact, editable brand foundation',audienceAnalysis:'Separate insights and assumptions',brandNames:'Structured candidates with stable IDs',domainCheck:'Timestamped IANA RDAP result',handlePlan:'Syntax and official manual verification paths',fontPairing:'Google Fonts with source and license',colorPalette:'Role-based sRGB colors with WCAG contrast',logoDesign:'Transparent logo variants with fal.ai',artboard:'Editable social composition',webpage:'Read a webpage safely',research:'Source-based web research',
};
const PORT_EN:Record<string,string>={text:'Text',image:'Image',images:'Image list',video:'Video',videos:'Video list',audio:'Audio',audios:'Audio list',prompt:'Text',reference:'Image',references:'Image',referenceLists:'Image list',imageLists:'Image list',textLists:'Variants',texts:'All variants',startFrame:'Start image',endFrame:'End image',mask:'Mask',brief:'Brief',audience:'Audience',names:'Name artifact',domains:'Domain status',handles:'Handle plan',pairing:'Typography',palette:'Color palette',fonts:'Typography',logo:'Logo',artboard:'Artboard',html:'HTML',json:'Artifact',jsonLists:'Artifact list',list:'List',png:'PNG'};
const TYPE_EN:Record<DataType,string>={text:'Text',image:'Image',video:'Video',audio:'Audio',json:'Artifact',textList:'Text list',imageList:'Image list',videoList:'Video list',audioList:'Audio list',jsonList:'Artifact list',list:'List'};

export const localizedNodeLabel=(kind:NodeKind,de:string)=>getLocale()==='en'?NODE_LABEL_EN[kind]:de;
export const localizedNodeDescription=(kind:NodeKind,de:string)=>getLocale()==='en'?DESCRIPTION_EN[kind]:de;
export const localizedPortLabel=(id:string,type:DataType,de:string)=>getLocale()==='en'?(PORT_EN[id]??TYPE_EN[type]):de;
export const localizedCategory=(value:string)=>getLocale()==='en'?({Eingabe:'Input',Kontext:'Context',Marke:'Brand',Modell:'Model',System:'System',Recherche:'Research',Werkzeug:'Tool',Content:'Content',Video:'Video'} as Record<string,string>)[value]??value:value;
export const localizedCanonicalNodeLabel=(labelId:string|undefined,kind:NodeKind,fallback:string)=>!labelId?fallback:labelId===`node:${kind}`?localizedNodeLabel(kind,fallback):localizedTemplateNodeLabel(labelId,fallback);
