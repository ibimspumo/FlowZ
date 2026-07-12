import {readFile} from 'node:fs/promises';

const catalog=JSON.parse(await readFile(new URL('../src/nodes/brand/google-fonts.catalog.json',import.meta.url),'utf8'));
if(catalog.version!==3||!/^[a-f0-9]{40}$/.test(catalog.commit)||catalog.families.length!==2020)throw new Error('Google-Fonts-Katalog ist unvollständig, ungepinnt oder hat eine unbekannte Version.');
if(catalog.hashPolicy!=='Font binaries are not bundled; SHA-256 is computed and persisted after the pinned file is downloaded.')throw new Error('Font-Hash-Policy wurde unerwartet verändert.');
const prefix=`https://raw.githubusercontent.com/google/fonts/${catalog.commit}/`,families=new Set(),disabled=[];
let previous='';
for(const font of catalog.families){
  if(!font.family||families.has(font.family)||font.family.localeCompare(previous)<0)throw new Error(`Doppelte oder unsortierte Familie: ${font.family}`);families.add(font.family);previous=font.family;
  const expectedRoot={OFL:'ofl',APACHE2:'apache',UFL:'ufl'}[font.license];if(!expectedRoot||!font.path.startsWith(`${expectedRoot}/`)||!font.metadataUrl.startsWith(`${prefix}${font.path}/`)||!/^[a-f0-9]{64}$/.test(font.metadataSha256)||!font.variants.length||!Number.isInteger(font.defaultVariant)||!font.variants[font.defaultVariant])throw new Error(`Ungültiger Katalogeintrag: ${font.family}`);
  const files=new Set();for(const variant of font.variants){if(!variant.file||files.has(variant.file)||variant.url!==`${prefix}${font.path.split('/').map(encodeURIComponent).join('/')}/${encodeURIComponent(variant.file)}`||!['normal','italic'].includes(variant.style)||!Number.isInteger(variant.weight)||variant.weight<1||variant.weight>1000)throw new Error(`Ungültige Variante: ${font.family}/${variant.file}`);files.add(variant.file);}
  if(font.axes.some(axis=>!axis.tag||axis.tag.length!==4||!Number.isFinite(axis.min)||!Number.isFinite(axis.max)||axis.min>axis.max))throw new Error(`Ungültige Achse: ${font.family}`);
  if(font.licenseUrl){if(!font.licenseUrl.startsWith(`${prefix}${font.path}/`)||!/^[a-f0-9]{64}$/.test(font.licenseSha256))throw new Error(`Ungültige Lizenz: ${font.family}`);}else disabled.push(font.family);
}
if(disabled.length!==12||catalog.families.length-disabled.length!==2008)throw new Error(`Snapshot-Wahrheit stimmt nicht: ${catalog.families.length} gesamt, ${catalog.families.length-disabled.length} auswählbar, ${disabled.length} deaktiviert.`);
process.stdout.write(`Verified 2,020 families: 2,008 selectable and 12 disabled for missing family license files at ${catalog.commit}.\n`);
