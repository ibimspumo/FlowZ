import type { FontRecord } from '../nodes/brand';

export type PreparedFont={blobHash?:string;licenseBlobHash?:string;mediaUrl:string;fontSha256?:string};
type BrowserFontEntry={face:FontFace;lastUsed:number};
export class BrowserFontRegistry{
  private readonly entries=new Map<string,BrowserFontEntry>();private readonly pending=new Map<string,Promise<string>>();
  constructor(private readonly maximum=64){}
  family(key:string){return `flowz-font-${key.replace(/[^a-z0-9]/gi,'').slice(0,32)}`;}
  async load(key:string,prepared:PreparedFont,style='normal',weight=400):Promise<string>{const existing=this.entries.get(key);if(existing){existing.lastUsed=Date.now();return existing.face.family;}const active=this.pending.get(key);if(active)return active;if(typeof FontFace==='undefined'||typeof document==='undefined'||!document.fonts)throw new Error('Schriftvorschauen werden von dieser WebView nicht unterstützt.');const family=this.family(key);const promise=new FontFace(family,`url(${JSON.stringify(prepared.mediaUrl)})`,{style,weight:String(weight),display:'swap'}).load().then((face)=>{document.fonts.add(face);this.entries.set(key,{face,lastUsed:Date.now()});this.pending.delete(key);this.evict();return family;},(error)=>{this.pending.delete(key);throw error;});this.pending.set(key,promise);return promise;}
  has(key:string){return this.entries.has(key);}
  private evict(){while(this.entries.size>this.maximum){const oldest=[...this.entries].sort((a,b)=>a[1].lastUsed-b[1].lastUsed)[0];if(!oldest)return;document.fonts.delete(oldest[1].face);this.entries.delete(oldest[0]);}}
}
export const browserFontRegistry=new BrowserFontRegistry();
export class FontPreviewLoader{
  private active=0;private readonly queue:{font:FontRecord;signal:AbortSignal;run:(font:FontRecord)=>Promise<PreparedFont>;resolve:(value:PreparedFont)=>void;reject:(error:unknown)=>void}[]=[];
  constructor(private readonly concurrency=2){}
  load(font:FontRecord,signal:AbortSignal,run:(font:FontRecord)=>Promise<PreparedFont>):Promise<PreparedFont>{return new Promise((resolve,reject)=>{if(signal.aborted){reject(new DOMException('Aborted','AbortError'));return;}this.queue.push({font,signal,run,resolve,reject});this.pump();});}
  private pump(){while(this.active<this.concurrency&&this.queue.length){const item=this.queue.shift()!;if(item.signal.aborted){item.reject(new DOMException('Aborted','AbortError'));continue;}this.active+=1;item.run(item.font).then((value)=>item.signal.aborted?item.reject(new DOMException('Aborted','AbortError')):item.resolve(value),item.reject).finally(()=>{this.active-=1;this.pump();});}}
}
export const fontPreviewLoader=new FontPreviewLoader(2);
