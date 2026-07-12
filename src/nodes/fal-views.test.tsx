import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "../i18n";
import { canonicalNodeRegistry } from ".";
import { FalImageGenerationBody } from "./image/views";
import { FalVideoGenerationBody } from "./video/views";

function props(kind:"imageGeneration"|"videoGeneration"){const module=canonicalNodeRegistry.forKind(kind);return{node:{id:`${kind}-view`,moduleId:module.id,moduleVersion:module.version,position:{x:0,y:0},config:module.defaultConfig,updatePolicy:"manual"},selected:false,runtimeProps:{id:`${kind}-view`,selected:false,data:{kind,label:module.metadata.label.fallback,status:"idle",updatePolicy:"manual",...module.defaultConfig}}} as any;}
const render=(body:ReactNode)=>renderToStaticMarkup(<ReactFlowProvider>{body}</ReactFlowProvider>);
describe("fal module view localization",()=>{afterEach(()=>setLocale("de"));it("renders image controls in both locales",()=>{setLocale("de");expect(render(<FalImageGenerationBody {...props("imageGeneration")}/>)).toContain("Bild generieren");setLocale("en");const html=render(<FalImageGenerationBody {...props("imageGeneration")}/>);expect(html).toContain("Generate image");expect(html).toContain("Instruction");});it("renders the video workflow in English",()=>{setLocale("en");const html=render(<FalVideoGenerationBody {...props("videoGeneration")}/>);expect(html).toContain("Model family");expect(html).toContain("Duration");expect(html).toContain("Generate video");});});
