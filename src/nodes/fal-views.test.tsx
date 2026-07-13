import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "../i18n";
import { canonicalNodeRegistry } from ".";
import { FalImageGenerationBody } from "./image/views";
import { FalVideoGenerationBody } from "./video/views";

function props(kind:"imageGeneration"|"videoGeneration",config:Record<string,unknown>={}){const module=canonicalNodeRegistry.forKind(kind);const data={...module.defaultConfig,...config};return{node:{id:`${kind}-view`,moduleId:module.id,moduleVersion:module.version,position:{x:0,y:0},config:data,updatePolicy:"manual"},selected:false,runtimeProps:{id:`${kind}-view`,selected:false,data:{kind,label:module.metadata.label.fallback,status:"idle",updatePolicy:"manual",...data}}} as any;}
const render=(body:ReactNode)=>renderToStaticMarkup(<ReactFlowProvider>{body}</ReactFlowProvider>);
describe("fal module view localization",()=>{afterEach(()=>setLocale("de"));it("renders image controls in both locales",()=>{setLocale("de");expect(render(<FalImageGenerationBody {...props("imageGeneration")}/>)).toContain("Bild generieren");setLocale("en");const html=render(<FalImageGenerationBody {...props("imageGeneration")}/>);expect(html).toContain("Generate image");expect(html).toContain("Instruction");});it("renders every FLUX setting that can block a paid run",()=>{setLocale("en");const html=render(<FalImageGenerationBody {...props("imageGeneration",{model:"fal-ai/flux/schnell",resolution:"square_hd",aspectRatio:"auto",outputFormat:"png",variants:1,steps:4,guidance:3.5,acceleration:"none",safetyChecker:false})}/>);expect(html).toContain("Steps");expect(html).toContain("Guidance");expect(html).toContain("Acceleration");expect(html).toContain("Use safety checker");});it("renders the video workflow in English",()=>{setLocale("en");const html=render(<FalVideoGenerationBody {...props("videoGeneration")}/>);expect(html).toContain("Model family");expect(html).toContain("Duration");expect(html).toContain("Generate video");});});
