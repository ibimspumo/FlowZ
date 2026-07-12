import type { NodeKind } from '../types';
import { getLocale } from '../i18n';

const IMAGE_RESULTS=new Set<NodeKind>(['imageGeneration','imageUpscale','imageTransform','backgroundRemoval','logoDesign','artboard','videoFrame']);
const VIDEO_RESULTS=new Set<NodeKind>(['videoGeneration']);

export function resultExportLabel(kind:NodeKind,mediaType?:string){
  const en=getLocale()==='en';
  if(VIDEO_RESULTS.has(kind)||mediaType?.startsWith('video/'))return en?'Export video':'Video exportieren';
  if(IMAGE_RESULTS.has(kind)||mediaType?.startsWith('image/'))return en?'Export image':'Bild exportieren';
  return en?'Export text':'Text exportieren';
}
