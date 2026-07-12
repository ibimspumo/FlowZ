import { validateArtboardDocument, type ArtboardDocument, type ArtboardLayer } from "./artboard-domain";

export type RenderTextLine = { text: string; x: number; y: number };
export type RenderLayer = Exclude<ArtboardLayer, { type: "group" }> & {
  zIndex: number;
  ancestorTransforms: string[];
  textLayout?: { fontFamily: "Arial"; lineHeight: number; lines: RenderTextLine[] };
};
export type ArtboardRenderPlan = { width: number; height: number; background: string; layers: RenderLayer[] };
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
  return { fontFamily: "Arial", lineHeight, lines: visible.map((text, index) => ({ text, x, y: layer.fontSize + index * lineHeight })) };
}

/** Canonical validated and fully laid-out input shared by preview and raster export. */
export function createArtboardRenderPlan(document: ArtboardDocument): ArtboardRenderPlan {
  validateArtboardDocument(document);
  const layers: RenderLayer[] = [];
  const visit = (id: string, ancestorTransforms:string[] = []) => {
    const layer = document.layers[id];
    if (layer.type === "group") { if (layer.visible) { const {x,y,width,height,rotation}=layer.geometry; const transform=rotation?`rotate(${rotation} ${x+width/2} ${y+height/2})`:""; layer.childIds.forEach((child)=>visit(child,transform?[...ancestorTransforms,transform]:ancestorTransforms)); } return; }
    if (layer.visible) layers.push({ ...layer, ancestorTransforms, zIndex: layers.length + 1, ...(layer.type === "text" ? { textLayout: layoutText(layer) } : {}) });
  };
  document.rootLayerIds.forEach((id)=>visit(id));
  return { width: document.format.width, height: document.format.height, background: document.paint.color, layers };
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
    const wrap=(value:string)=>layer.ancestorTransforms.reduceRight((inner,parent)=>`<g transform="${parent}">${inner}</g>`,value);
    if (layer.type === "shape") return wrap(layer.shape === "ellipse"
      ? `<ellipse cx="${centerX}" cy="${centerY}" rx="${width / 2}" ry="${height / 2}" fill="${layer.fill.color}"${transform}/>`
      : `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${layer.fill.color}"${transform}/>`);
    const clipId = `clip-${escapeXml(layer.id)}`;
    definitions.push(`<clipPath id="${clipId}"><rect x="0" y="0" width="${width}" height="${height}"/></clipPath>`);
    const groupTransform = `translate(${x} ${y})${rotation ? ` rotate(${rotation} ${width / 2} ${height / 2})` : ""}`;
    if (layer.type === "image") {
      const source = resolveImage(layer, document, resolveAsset); if (!source) return "";
      const aspect = layer.fit === "cover" ? "xMidYMid slice" : layer.fit === "contain" ? "xMidYMid meet" : "none";
      return wrap(`<g transform="${groupTransform}" clip-path="url(#${clipId})"><image href="${escapeXml(source)}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="${aspect}"/></g>`);
    }
    const layout = layer.textLayout!;
    const anchor = layer.align === "left" ? "start" : layer.align === "center" ? "middle" : "end";
    const lines = layout.lines.map((line) => `<tspan x="${line.x}" y="${line.y}">${escapeXml(line.text)}</tspan>`).join("");
    const family=layer.fontHash?`flowz-font-${layer.fontHash.slice(0,32)}`:layout.fontFamily;
    const axes=layer.fontAxes?` font-variation-settings="${escapeXml(Object.entries(layer.fontAxes).map(([tag,value])=>`'${tag}' ${value}`).join(", "))}"`:"";
    return wrap(`<g transform="${groupTransform}" clip-path="url(#${clipId})"><text fill="${layer.color}" font-family="${escapeXml(family)}" font-size="${layer.fontSize}" font-weight="${layer.fontWeight??400}" font-style="${layer.fontStyle??"normal"}"${axes} text-anchor="${anchor}">${lines}</text></g>`);
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${plan.width}" height="${plan.height}" viewBox="0 0 ${plan.width} ${plan.height}" role="img" aria-label="${escapeXml(document.name)}"><defs>${definitions.join("")}</defs><rect width="${plan.width}" height="${plan.height}" fill="${plan.background}"/>${body}</svg>`;
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

export async function renderArtboardPngFromDocument(document: ArtboardDocument, resolveAsset: ArtboardAssetResolver, backend: PngRenderBackend = browserPngBackend): Promise<string> {
  const plan = createArtboardRenderPlan(document); const svg = renderArtboardSvg(document, resolveAsset);
  const png = await backend(svg, plan); if (!png.startsWith("data:image/png;base64,")) throw new Error("Der PNG-Renderer hat kein PNG geliefert."); return png;
}
