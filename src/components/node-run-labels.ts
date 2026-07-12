import type { NodeKind } from '../types';
import { getLocale } from '../i18n';

const LABELS: Partial<Record<NodeKind, [idle: string, running: string]>> = {
  textGeneration: ['Text generieren', 'Text wird generiert …'],
  imageGeneration: ['Bild generieren', 'Bild wird generiert …'], logoDesign: ['Logo generieren', 'Logo wird generiert …'],
  videoGeneration: ['Video generieren', 'Video wird generiert …'], imageAnalysis: ['Bild analysieren', 'Bild wird analysiert …'],
  transcription: ['Transkribieren', 'Audio wird transkribiert …'], imageUpscale: ['Hochskalieren', 'Bild wird hochskaliert …'],
  backgroundRemoval: ['Freistellen', 'Bild wird freigestellt …'], imageTransform: ['Bild bearbeiten', 'Bild wird bearbeitet …'],
  imageTrimTransparent: ['Transparenz beschneiden', 'Transparenz wird beschnitten …'],
  videoFrame: ['Frame extrahieren', 'Frame wird extrahiert …'], research: ['Recherchieren', 'Recherche läuft …'],
  webpage: ['Webseite einlesen', 'Webseite wird eingelesen …'],
  audienceAnalysis: ['Zielgruppe analysieren', 'Zielgruppe wird analysiert …'], brandNames: ['Namen generieren', 'Namen werden generiert …'],
  domainCheck: ['Domains prüfen', 'Domains werden geprüft …'],
  fontPairing: ['Font-Pairing erstellen', 'Font-Pairing wird erstellt …'], colorPalette: ['Farbpalette erstellen', 'Farbpalette wird erstellt …'],
};

const PASSIVE = new Set<NodeKind>(['textInput','imageCollection','videoCollection','assetText','assetImage','brandBrief','handlePlan','artboard']);

export function nodeRunLabel(kind: NodeKind, running: boolean): string | null {
  if (PASSIVE.has(kind)) return null;
  if(getLocale()==='en'){
    const labels:Partial<Record<NodeKind,[string,string]>>={textGeneration:['Generate text','Generating text …'],imageGeneration:['Generate image','Generating image …'],logoDesign:['Generate logo','Generating logo …'],videoGeneration:['Generate video','Generating video …'],imageAnalysis:['Analyze image','Analyzing image …'],transcription:['Transcribe','Transcribing audio …'],imageUpscale:['Upscale','Upscaling image …'],backgroundRemoval:['Remove background','Removing background …'],imageTransform:['Edit image','Editing image …'],videoFrame:['Extract frame','Extracting frame …'],research:['Research','Researching …'],webpage:['Read webpage','Reading webpage …'],audienceAnalysis:['Analyze audience','Analyzing audience …'],brandNames:['Generate names','Generating names …'],domainCheck:['Check domains','Checking domains …'],fontPairing:['Create font pairing','Creating font pairing …'],colorPalette:['Create color palette','Creating color palette …']};
    return labels[kind]?.[running?1:0]??(running?'Running …':'Run');
  }
  return LABELS[kind]?.[running ? 1 : 0] ?? (running ? 'Wird ausgeführt …' : 'Ausführen');
}
