import { mediaUrl } from "../persistence/media";

const HASH=/^[a-f0-9]{64}$/;
const loaded=new Map<string,Promise<string>>();
const ready=new Set<string>();

export function artboardFontFamily(hash:string){
  if(!HASH.test(hash))throw new Error("Ungültige Artboard-Schriftreferenz.");
  return `flowz-font-${hash.slice(0,32)}`;
}

/** Loads exactly the persisted CAS bytes. No family is exposed before FontFace.load succeeds. */
export function loadArtboardFont(hash:string,style="normal",weight=400){
  const key=`${hash}:${style}:${weight}`; const current=loaded.get(key);if(current)return current;
  if(typeof FontFace==="undefined"||!document.fonts)return Promise.reject(new Error("Schriften werden von dieser WebView nicht unterstützt."));
  const family=artboardFontFamily(hash);
  const promise=new FontFace(family,`url(${JSON.stringify(mediaUrl(hash))})`,{style,weight:String(weight),display:"block"}).load().then((face)=>{document.fonts.add(face);ready.add(key);return family;},(error)=>{loaded.delete(key);throw error;});
  loaded.set(key,promise);return promise;
}
export function isArtboardFontLoaded(hash:string,style="normal",weight=400){return ready.has(`${hash}:${style}:${weight}`);}
