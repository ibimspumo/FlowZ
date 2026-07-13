import type { ExportItem } from '../api';
import type { HistoryItem, NodeKind } from '../types';
import { getLocale } from '../i18n';

const IMAGE_RESULTS=new Set<NodeKind>(['imageGeneration','imageUpscale','imageTransform','backgroundRemoval','logoDesign','artboard','videoFrame']);
const VIDEO_RESULTS=new Set<NodeKind>(['videoGeneration']);

export function resultExportLabel(kind:NodeKind,mediaType?:string){
  const en=getLocale()==='en';
  if(VIDEO_RESULTS.has(kind)||mediaType?.startsWith('video/'))return en?'Export video':'Video exportieren';
  if(IMAGE_RESULTS.has(kind)||mediaType?.startsWith('image/'))return en?'Export image':'Bild exportieren';
  return en?'Export text':'Text exportieren';
}

export function resultExportItems(items: readonly HistoryItem[]): ExportItem[] {
  return items.map((item) => item.blobHash ? { blobHash: item.blobHash } : { text: item.value });
}

export function resultExportRun(items: readonly HistoryItem[]): string {
  if (items.length === 1) return items[0]?.runId || items[0]?.id || 'result';
  return items[0]?.runId ? `${items[0].runId}-selection` : 'selection';
}
