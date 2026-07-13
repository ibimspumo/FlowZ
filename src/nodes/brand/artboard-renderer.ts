import { validateArtboardDocument, type ArtboardDocument, type ArtboardGeometry, type ArtboardLayer, type ArtboardLayerStyle, type ArtboardPaint, type ContainerLayer } from "./artboard-domain";

export type RenderTextLine = { text: string; x: number; y: number };
export type RenderLayer = Exclude<ArtboardLayer, { type: "group" }> & {
  zIndex: number;
  ancestorTransforms: string[];
  ancestorOpacities: number[];
  ancestorClips: { id: string; geometry: ArtboardGeometry }[];
  textLayout?: { fontFamily: string; lineHeight: number; lines: RenderTextLine[] };
};
export type ArtboardRenderPlan = { width: number; height: number; background: ArtboardPaint; layers: RenderLayer[] };
export type ArtboardAssetResolver = (hash: string) => string;

const escapeXml = (value: string) => value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&apos;", '"': "&quot;" })[character]!);
const allowedAsset = /^(?:flowz-media:|data:image\/(?:png|jpeg|webp|gif);base64,)/i;
const allowedFontAsset = /^flowz-media:(?:\/\/localhost\/)?[a-f0-9]{64}$/;

function wrapParagraph(paragraph: string, capacity: number): string[] {
  if (!paragraph) return [""];
  const words = paragraph.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const chunks = word.length <= capacity ? [word] : Array.from({ length: Math.ceil(word.length / capacity) }, (_, index) => word.slice(index * capacity, (index + 1) * capacity));
    for (const chunk of chunks) {
      const candidate = current ? `${current} ${chunk}` : chunk;
      if (candidate.length <= capacity) current = candidate;
      else { if (current) lines.push(current); current = chunk; }
    }
  }
  if (current) lines.push(current);
  return lines;
}

export function layoutText(layer: Extract<ArtboardLayer, { type: "text" }>): RenderLayer["textLayout"] {
  const lineHeight = layer.fontSize * 1.2;
  const capacity = Math.max(1, Math.floor(layer.geometry.width / (layer.fontSize * 0.56)));
  const lines = layer.text.split("\n").flatMap((paragraph) => wrapParagraph(paragraph, capacity));
  const maximum = Math.max(1, Math.floor(layer.geometry.height / lineHeight));
  const visible = lines.slice(0, maximum);
  if (lines.length > maximum && visible.length) {
    const last = visible.length - 1;
    visible[last] = `${visible[last].slice(0, Math.max(0, capacity - 1)).trimEnd()}…`;
  }
  const x = layer.align === "left" ? 0 : layer.align === "center" ? layer.geometry.width / 2 : layer.geometry.width;
  return { fontFamily: layer.fontFamily ?? "Arial", lineHeight, lines: visible.map((text, index) => ({ text, x, y: layer.fontSize + index * lineHeight })) };
}

function layoutContainerChildren(container: ContainerLayer, document: ArtboardDocument, origin: {x:number;y:number}): Map<string, ArtboardGeometry> {
  const result = new Map<string, ArtboardGeometry>();
  const children = container.childIds.map((id) => document.layers[id]);
  const layout=container.layout;const { padding } = layout; const contentWidth = Math.max(1, container.geometry.width - padding * 2); const contentHeight = Math.max(1, container.geometry.height - padding * 2);
  const startX = origin.x + container.geometry.x + padding; const startY = origin.y + container.geometry.y + padding;
  if (layout.mode === "free") { children.forEach((child) => result.set(child.id, {...child.geometry,x:startX+child.geometry.x,y:startY+child.geometry.y})); return result; }
  if (layout.mode === "grid") {
    const columns = layout.columns; const width = Math.max(1,(contentWidth-layout.gap*(columns-1))/columns);
    const rows = Math.max(1,Math.ceil(children.length/columns)); const height = Math.max(1,(contentHeight-layout.gap*(rows-1))/rows);
    children.forEach((child,index)=>{const column=index%columns,row=Math.floor(index/columns);const childHeight=layout.align==="stretch"?height:Math.min(child.geometry.height,height);const yOffset=layout.align==="center"?(height-childHeight)/2:layout.align==="end"?height-childHeight:0;result.set(child.id,{...child.geometry,x:startX+column*(width+layout.gap),y:startY+row*(height+layout.gap)+yOffset,width,height:childHeight});});
    return result;
  }
  const row=layout.direction==="row"; const mainSize=row?contentWidth:contentHeight; const intrinsic=children.reduce((sum,child)=>sum+(row?child.geometry.width:child.geometry.height),0); let gap=layout.gap; let cursor=0;
  const free=Math.max(0,mainSize-intrinsic-gap*Math.max(0,children.length-1)); if(layout.justify==="center")cursor=free/2;else if(layout.justify==="end")cursor=free;else if(layout.justify==="space-between"&&children.length>1)gap+=(free/(children.length-1));
  children.forEach((child)=>{let width=child.geometry.width,height=child.geometry.height; if(layout.align==="stretch"){if(row)height=contentHeight;else width=contentWidth;} const crossSize=row?height:width;const crossAvailable=row?contentHeight:contentWidth;const cross=layout.align==="center"?(crossAvailable-crossSize)/2:layout.align==="end"?crossAvailable-crossSize:0;result.set(child.id,{...child.geometry,x:startX+(row?cursor:cross),y:startY+(row?cross:cursor),width,height});cursor+=(row?width:height)+gap;});
  return result;
}

/** Canonical validated and fully laid-out input shared by preview and raster export. */
export function createArtboardRenderPlan(document: ArtboardDocument): ArtboardRenderPlan {
  validateArtboardDocument(document);
  const layers: RenderLayer[] = [];
  const visit = (id: string, ancestorTransforms:string[] = [], ancestorOpacities:number[]=[], ancestorClips:{id:string;geometry:ArtboardGeometry}[]=[], geometryOverride?:ArtboardGeometry, origin={x:0,y:0}) => {
    const layer = document.layers[id];
    if (layer.type === "group") { if (layer.visible) { const {x,y,width,height,rotation}=layer.geometry; const transform=rotation?`rotate(${rotation} ${x+width/2} ${y+height/2})`:""; const opacities=layer.style?.opacity===undefined?ancestorOpacities:[...ancestorOpacities,layer.style.opacity];layer.childIds.forEach((child)=>visit(child,transform?[...ancestorTransforms,transform]:ancestorTransforms,opacities,ancestorClips)); } return; }
    if (!layer.visible) return;
    const geometry=geometryOverride??layer.geometry; const resolved={...layer,geometry} as Exclude<ArtboardLayer,{type:"group"}>;
    layers.push({ ...resolved, ancestorTransforms, ancestorOpacities,ancestorClips, zIndex: layers.length + 1, ...(resolved.type === "text" ? { textLayout: layoutText(resolved) } : {}) });
    if(resolved.type==="container"){
      const childGeometry=layoutContainerChildren(resolved,document,origin);const clip={id:`container-clip-${resolved.id}`,geometry};const nextOrigin={x:0,y:0};
      const transform=geometry.rotation?`rotate(${geometry.rotation} ${geometry.x+geometry.width/2} ${geometry.y+geometry.height/2})`:"";const opacities=resolved.style?.opacity===undefined?ancestorOpacities:[...ancestorOpacities,resolved.style.opacity];resolved.childIds.forEach((child)=>visit(child,transform?[...ancestorTransforms,transform]:ancestorTransforms,opacities,[...ancestorClips,clip],childGeometry.get(child),nextOrigin));
    }
  };
  document.rootLayerIds.forEach((id)=>visit(id));
  return { width: document.format.width, height: document.format.height, background: document.paint, layers };
}

function paintValue(paint:ArtboardPaint,id:string,definitions:string[]){
  if(paint.kind==="solid")return paint.color;
  const radians=(paint.angle-90)*Math.PI/180;const x=Math.cos(radians),y=Math.sin(radians);const x1=(1-x)*50,y1=(1-y)*50,x2=(1+x)*50,y2=(1+y)*50;const gradientId=`flowz-paint-${id}`;
  definitions.push(`<linearGradient id="${gradientId}" x1="${x1}%" y1="${y1}%" x2="${x2}%" y2="${y2}%">${paint.stops.map((stop)=>`<stop offset="${stop.offset*100}%" stop-color="${stop.color}"/>`).join("")}</linearGradient>`);return `url(#${gradientId})`;
}

function styleAttributes(style:ArtboardLayerStyle|undefined,id:string,definitions:string[]){
  const values:string[]=[];if(style?.opacity!==undefined)values.push(`opacity="${style.opacity}"`);if(style?.border?.width)values.push(`stroke="${style.border.color}" stroke-width="${style.border.width}"`);
  if(style?.shadow&&style.shadow.opacity>0){const filter=`shadow-${id}`;definitions.push(`<filter id="${filter}" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="${style.shadow.x}" dy="${style.shadow.y}" stdDeviation="${style.shadow.blur/2}" flood-color="${style.shadow.color}" flood-opacity="${style.shadow.opacity}"/></filter>`);values.push(`filter="url(#${filter})"`);}return values.length?` ${values.join(" ")}`:"";
}

function resolveImage(layer: Extract<RenderLayer, { type: "image" }>, document: ArtboardDocument, resolveAsset: ArtboardAssetResolver): string | undefined {
  const binding = layer.bindingId ? document.bindings[layer.bindingId] : undefined;
  const hash = layer.casHash ?? (binding?.snapshot.kind === "cas" ? binding.snapshot.hash : undefined);
  if (!hash) return undefined;
  const source = resolveAsset(hash);
  if (!allowedAsset.test(source)) throw new Error("Artboard-Assets dürfen nur aus dem lokalen Medienspeicher oder geprüften Bilddaten stammen.");
  return source;
}

export function renderArtboardSvg(document: ArtboardDocument, resolveAsset: ArtboardAssetResolver): string {
  const plan = createArtboardRenderPlan(document);
  const definitions: string[] = [];
  const definedClips=new Set<string>();
  const fontFaces = new Map<string, string>();
  for (const layer of plan.layers) if (layer.type === "text" && layer.fontHash) {
    const family = `flowz-font-${layer.fontHash.slice(0,32)}`;
    const source = resolveAsset(layer.fontHash);
    if (!allowedFontAsset.test(source)) throw new Error("Artboard-Schriften müssen aus der exakten lokalen CAS-Datei geladen werden.");
    const key = `${family}:${layer.fontWeight ?? 400}:${layer.fontStyle ?? "normal"}`;
    fontFaces.set(key, `@font-face{font-family:'${family}';src:url('${source}');font-weight:${layer.fontWeight ?? 400};font-style:${layer.fontStyle ?? "normal"};font-display:block}`);
  }
  if (fontFaces.size) definitions.push(`<style>${[...fontFaces.values()].join("")}</style>`);
  const body = plan.layers.map((layer) => {
    const { x, y, width, height, rotation } = layer.geometry;
    const centerX = x + width / 2; const centerY = y + height / 2;
    const transform = rotation ? ` transform="rotate(${rotation} ${centerX} ${centerY})"` : "";
    for(const clip of layer.ancestorClips)if(!definedClips.has(clip.id)){definedClips.add(clip.id);definitions.push(`<clipPath id="${clip.id}"><rect x="${clip.geometry.x}" y="${clip.geometry.y}" width="${clip.geometry.width}" height="${clip.geometry.height}" rx="${document.layers[clip.id.replace("container-clip-","")]?.style?.borderRadius??0}"/></clipPath>`);}
    const wrap=(value:string)=>{let wrapped=layer.ancestorClips.reduceRight((inner,clip)=>`<g clip-path="url(#${clip.id})">${inner}</g>`,value);wrapped=layer.ancestorOpacities.reduceRight((inner,opacity)=>`<g opacity="${opacity}">${inner}</g>`,wrapped);return layer.ancestorTransforms.reduceRight((inner,parent)=>`<g transform="${parent}">${inner}</g>`,wrapped);};
    const styles=styleAttributes(layer.style,layer.id,definitions);const radius=layer.style?.borderRadius??0;
    if (layer.type === "shape"||layer.type==="container") {const fill=paintValue(layer.fill,layer.id,definitions);return wrap(layer.type==="shape"&&layer.shape === "ellipse"
      ? `<ellipse cx="${centerX}" cy="${centerY}" rx="${width / 2}" ry="${height / 2}" fill="${fill}"${styles}${transform}/>`
      : `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${fill}"${styles}${transform}/>`);}
    const clipId = `clip-${escapeXml(layer.id)}`;
    definitions.push(`<clipPath id="${clipId}"><rect x="0" y="0" width="${width}" height="${height}"/></clipPath>`);
    const groupTransform = `translate(${x} ${y})${rotation ? ` rotate(${rotation} ${width / 2} ${height / 2})` : ""}`;
    if (layer.type === "image") {
      const source = resolveImage(layer, document, resolveAsset); if (!source) return "";
      const aspect = layer.fit === "cover" ? "xMidYMid slice" : layer.fit === "contain" ? "xMidYMid meet" : "none";
      return wrap(`<g transform="${groupTransform}" clip-path="url(#${clipId})"${styles}><image href="${escapeXml(source)}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="${aspect}"/><rect x="0" y="0" width="${width}" height="${height}" rx="${radius}" fill="none"${layer.style?.border?.width?` stroke="${layer.style.border.color}" stroke-width="${layer.style.border.width}"`:""}/></g>`);
    }
    const layout = layer.textLayout!;
    const anchor = layer.align === "left" ? "start" : layer.align === "center" ? "middle" : "end";
    const lines = layout.lines.map((line) => `<tspan x="${line.x}" y="${line.y}">${escapeXml(line.text)}</tspan>`).join("");
    const family=layer.fontHash?`flowz-font-${layer.fontHash.slice(0,32)}`:layout.fontFamily;
    const axes=layer.fontAxes?` font-variation-settings="${escapeXml(Object.entries(layer.fontAxes).map(([tag,value])=>`'${tag}' ${value}`).join(", "))}"`:"";
    return wrap(`<g transform="${groupTransform}" clip-path="url(#${clipId})"${styles}><text fill="${layer.color}" font-family="${escapeXml(family)}" font-size="${layer.fontSize}" font-weight="${layer.fontWeight??400}" font-style="${layer.fontStyle??"normal"}"${axes} text-anchor="${anchor}">${lines}</text></g>`);
  }).join("");
  const background=paintValue(plan.background,"__board",definitions);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${plan.width}" height="${plan.height}" viewBox="0 0 ${plan.width} ${plan.height}" role="img" aria-label="${escapeXml(document.name)}"><defs>${definitions.join("")}</defs><rect width="${plan.width}" height="${plan.height}" fill="${background}"/>${body}</svg>`;
}

export function renderArtboardPreviewHtml(document: ArtboardDocument, resolveAsset: ArtboardAssetResolver): string {
  const svg = renderArtboardSvg(document, resolveAsset);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src flowz-media: data:; style-src 'unsafe-inline'"><style>html,body{margin:0;background:#151315}svg{display:block;max-width:100%;height:auto}</style></head><body>${svg}</body></html>`;
}

export type PngRenderBackend = (svg: string, plan: ArtboardRenderPlan) => Promise<string>;

function svgDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

const browserPngBackend: PngRenderBackend = async (svg, plan) => {
  const canvas = window.document.createElement("canvas"); canvas.width = plan.width; canvas.height = plan.height;
  const context = canvas.getContext("2d"); if (!context) throw new Error("PNG-Export ist in dieser WebView nicht verfügbar.");
  const image = await new Promise<HTMLImageElement>((resolve, reject) => { const candidate = new window.Image(); candidate.onload = () => resolve(candidate); candidate.onerror = () => reject(new Error("Das kanonische Artboard-SVG konnte nicht gerastert werden.")); candidate.src = svgDataUrl(svg); });
  context.drawImage(image, 0, 0, plan.width, plan.height);
  return canvas.toDataURL("image/png");
};

export async function renderArtboardPreviewPngFromDocument(document: ArtboardDocument, resolveAsset: ArtboardAssetResolver, width: number, height: number): Promise<string> {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 1024 || height > 1024) throw new Error("Die visuelle Artboard-Vorschau benötigt sichere Abmessungen bis 1.024 Pixel.");
  const svg = renderArtboardSvg(document, resolveAsset);
  const canvas = window.document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d"); if (!context) throw new Error("Die visuelle Artboard-Vorschau ist in dieser WebView nicht verfügbar.");
  const image = await new Promise<HTMLImageElement>((resolve, reject) => { const candidate = new window.Image(); candidate.onload = () => resolve(candidate); candidate.onerror = () => reject(new Error("Die visuelle Artboard-Vorschau konnte nicht gerastert werden.")); candidate.src = svgDataUrl(svg); });
  context.fillStyle="#151315";context.fillRect(0,0,width,height);const scale=Math.min(width/document.format.width,height/document.format.height);const targetWidth=document.format.width*scale,targetHeight=document.format.height*scale;context.drawImage(image,(width-targetWidth)/2,(height-targetHeight)/2,targetWidth,targetHeight);
  const png = canvas.toDataURL("image/png"); if (!png.startsWith("data:image/png;base64,")) throw new Error("Die visuelle Artboard-Vorschau ist kein gültiges PNG."); return png;
}

export async function renderArtboardPngFromDocument(document: ArtboardDocument, resolveAsset: ArtboardAssetResolver, backend: PngRenderBackend = browserPngBackend): Promise<string> {
  const plan = createArtboardRenderPlan(document); const svg = renderArtboardSvg(document, resolveAsset);
  const png = await backend(svg, plan); if (!png.startsWith("data:image/png;base64,")) throw new Error("Der PNG-Renderer hat kein PNG geliefert."); return png;
}
