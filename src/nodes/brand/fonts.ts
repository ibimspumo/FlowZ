import catalog from './google-fonts.catalog.json';
import type { FontRecord } from './artifacts';

type CatalogFamily = typeof catalog.families[number];
export const GOOGLE_FONTS_SNAPSHOT = catalog;
export const GOOGLE_FONT_CATALOG = catalog.families;
const LICENSE_LABELS:Record<string,FontRecord['license']>={OFL:'OFL-1.1',APACHE2:'Apache-2.0',UFL:'UFL-1.0'};
export type DisabledGoogleFont={family:string;reason:string};
export const DISABLED_GOOGLE_FONTS:DisabledGoogleFont[]=catalog.families.flatMap((font:CatalogFamily)=>{
  const reasons:string[]=[];
  if(!font.variants[font.defaultVariant])reasons.push('keine auswählbare Variante');
  if(!LICENSE_LABELS[font.license])reasons.push('unbekannte Lizenz');
  if(!font.licenseUrl||!font.licenseSha256)reasons.push('keine familienbezogene Lizenzdatei im gepinnten Snapshot');
  return reasons.length?[{family:font.family,reason:reasons.join(', ')}]:[];
});
export const GOOGLE_FONTS: FontRecord[] = catalog.families.flatMap((font:CatalogFamily) => {
  const variant=font.variants[font.defaultVariant];
  const license=LICENSE_LABELS[font.license];if(!variant||!license||!font.licenseUrl||!font.licenseSha256)return [];
  return [{family:font.family,category:font.category as FontRecord['category'],license,path:font.path,
    source:`${catalog.repository}/tree/${catalog.commit}/${font.path}`,metadataUrl:font.metadataUrl,metadataSha256:font.metadataSha256,
    licenseUrl:font.licenseUrl,licenseSha256:font.licenseSha256,fontUrl:variant.url,fontFile:variant.file,style:variant.style,weight:variant.weight,
    axes:font.axes.map(axis=>axis.tag),axisRanges:font.axes.map(axis=>({...axis})),variants:font.variants.map(item=>({...item})),variantIndex:font.defaultVariant,subsets:[...font.subsets]}];
});
const byFamily=new Map(GOOGLE_FONTS.map(font=>[font.family,font]));
export function findFont(family: string, variantIndex?:number, axisValues?:Record<string,number>): FontRecord { const base=byFamily.get(family);if(!base)throw new Error(`Schrift „${family}“ fehlt im gepinnten Google-Fonts-Katalog.`);const index=variantIndex==null?base.variantIndex:Math.max(0,Math.min(base.variants.length-1,Math.floor(variantIndex)));const variant=base.variants[index];return{...base,variantIndex:index,fontUrl:variant.url,fontFile:variant.file,style:variant.style,weight:variant.weight,axisRanges:base.axisRanges.map(axis=>({...axis,...(axisValues?.[axis.tag]==null?{}:{value:Math.min(axis.max,Math.max(axis.min,axisValues[axis.tag]))})}))}; }
export function validateFontRecord(font: FontRecord): boolean { const pinned=`/${catalog.commit}/`;return ['OFL-1.1','Apache-2.0','UFL-1.0'].includes(font.license)&&font.source.includes(catalog.commit)&&[font.metadataUrl,font.licenseUrl,font.fontUrl].every(url=>url.startsWith('https://raw.githubusercontent.com/google/fonts/')&&url.includes(pinned))&&[font.metadataSha256,font.licenseSha256].every(hash=>/^[a-f0-9]{64}$/.test(hash))&&(!font.fontSha256||/^[a-f0-9]{64}$/.test(font.fontSha256))&&font.axes.every(Boolean)&&font.variants.some(item=>item.file===font.fontFile&&item.url===font.fontUrl); }

export function searchFonts(query:string,filters:{category?:string;subset?:string;variableOnly?:boolean}={}):FontRecord[]{const terms=query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);return GOOGLE_FONTS.filter(font=>(!filters.category||font.category===filters.category)&&(!filters.subset||font.subsets.includes(filters.subset))&&(!filters.variableOnly||font.variants.some(variant=>variant.variable))&&terms.every(term=>`${font.family} ${font.category} ${font.subsets.join(' ')}`.toLocaleLowerCase().includes(term)));}
