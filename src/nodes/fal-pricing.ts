import manifestJson from "./fal-pricing-manifest.json";
import type { JsonValue } from "../domain/project";
import type { FalImageConfig, FalImageModel } from "./image/capabilities";
import { falImageRequestConfig, validateFalImageConfig } from "./image/capabilities";
import type { FalVideoCapabilities, FalVideoEndpointConfig, FalVideoPortOccupancy } from "./video/capabilities";
import { validateFalVideoConfig } from "./video/capabilities";
import { falEmpiricalCostEstimate, type FalEmpiricalCostEstimate } from "../api";

type PricingEntry=Record<string,unknown>;
const endpoints=(manifestJson as unknown as {schemaVersion:number;currency:"USD";auditedAt:string;endpoints:Record<string,PricingEntry>}).endpoints;

export type FalCostEstimateReason="configuration-conflict"|"provider-usage-unknown"|"automatic-duration"|"unpriced-resolution"|"unsupported-combination";
export type FalPricingSnapshot={
  schemaVersion:1;endpoint:string;adapterSchemaHash:string;pricingManifestVersion:number;priceAsOf:string;source:string;currency:"USD";
  unit:string;formula:string;amountMicrounits:number;confidence:"formula"|"projection"|"minimum"|"tentative"|"empirical";billableConfig:Record<string,JsonValue>;
  provenance?:"official"|"local-actual";empirical?:{sampleCount:number;usedSampleCount:number;rejectedOutliers:number;p25Microunits:number;p75Microunits:number};
};
export type FalCostContext={schemaVersion:1;pricingManifestVersion:number;billableConfig:Record<string,JsonValue>};
export type FalCostEstimate=
  | {state:"available";amountMicrounits:number;snapshot:FalPricingSnapshot}
  | {state:"unavailable";reason:FalCostEstimateReason;source?:string};
export type FalCostDisplayEstimate=FalCostEstimate|{state:"empirical";amountMicrounits:number;snapshot:FalPricingSnapshot};

const money=(usd:number)=>Math.round(usd*1_000_000);
const record=(value:unknown):Record<string,unknown>|undefined=>value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
const entry=(endpoint:string)=>endpoints[endpoint];
const dimensions:Record<string,[number,number]>={square_hd:[1024,1024],square:[512,512],portrait_4_3:[768,1024],portrait_16_9:[576,1024],landscape_4_3:[1024,768],landscape_16_9:[1024,576]};
const gpt2Size:Record<string,string>={square_hd:"1024x1024",portrait_4_3:"1024x768",landscape_4_3:"1024x768"};

export function falImageCostContext(input:{model:FalImageModel;endpoint:string;config:FalImageConfig;referenceCount:number;maskCount?:number}):FalCostContext{
  return {schemaVersion:1,pricingManifestVersion:manifestJson.schemaVersion,billableConfig:{
    modality:input.endpoint.endsWith("/edit")||input.referenceCount>0||(input.maskCount??0)>0?"edit":"text",
    config:falImageRequestConfig(input.model,input.config,input.referenceCount) as Record<string,JsonValue>,
    referenceCount:input.referenceCount,mask:(input.maskCount??0)>0,
  }};
}

export function falVideoCostContext(input:{capability:FalVideoCapabilities;config:FalVideoEndpointConfig}):FalCostContext{
  return {schemaVersion:1,pricingManifestVersion:manifestJson.schemaVersion,billableConfig:{modality:input.capability.mode,duration:input.config.duration,resolution:input.config.resolution,generateAudio:input.config.generateAudio,aspectRatio:input.config.aspectRatio,bitrateMode:input.config.bitrateMode}};
}

function available(endpoint:string,schemaHash:string,pricing:PricingEntry,amountMicrounits:number,confidence:FalPricingSnapshot["confidence"],formula:string,billableConfig:Record<string,JsonValue>):FalCostEstimate{
  return {state:"available",amountMicrounits,snapshot:{schemaVersion:1,endpoint,adapterSchemaHash:schemaHash,pricingManifestVersion:manifestJson.schemaVersion,priceAsOf:manifestJson.auditedAt,source:String(pricing.source),currency:"USD",unit:String(pricing.unit),formula,amountMicrounits,confidence,provenance:"official",billableConfig}};
}

export function falEmpiricalSnapshot(endpoint:string,schemaHash:string,context:FalCostContext,estimate:FalEmpiricalCostEstimate):FalCostDisplayEstimate|undefined{
  if(estimate.state!=="available"||estimate.medianMicrounits==null||estimate.p25Microunits==null||estimate.p75Microunits==null)return;
  return {state:"empirical",amountMicrounits:estimate.medianMicrounits,snapshot:{schemaVersion:1,endpoint,adapterSchemaHash:schemaHash,pricingManifestVersion:context.pricingManifestVersion,priceAsOf:estimate.lastObservedAt??"unknown",source:"local-actual-history",currency:"USD",unit:"comparable-actual-runs",formula:"robust median of exact-version comparable actual runs",amountMicrounits:estimate.medianMicrounits,confidence:"empirical",provenance:"local-actual",billableConfig:context.billableConfig,empirical:{sampleCount:estimate.sampleCount,usedSampleCount:estimate.usedSampleCount,rejectedOutliers:estimate.rejectedOutliers,p25Microunits:estimate.p25Microunits,p75Microunits:estimate.p75Microunits}}};
}

export async function loadFalEmpiricalCost(endpoint:string,schemaHash:string,context:FalCostContext):Promise<FalCostDisplayEstimate|undefined>{
  try{return falEmpiricalSnapshot(endpoint,schemaHash,context,await falEmpiricalCostEstimate({endpoint,adapterSchemaHash:schemaHash,pricingManifestVersion:context.pricingManifestVersion,billableConfig:context.billableConfig}));}catch{return undefined;}
}
export async function resolveFalCostEstimate(official:FalCostEstimate,endpoint:string,schemaHash:string,context:FalCostContext):Promise<FalCostDisplayEstimate>{
  return official.state==="available"?official:(await loadFalEmpiricalCost(endpoint,schemaHash,context))??official;
}

export function estimateFalImageCost(input:{model:FalImageModel;endpoint:string|undefined;config:FalImageConfig;referenceCount:number;maskCount?:number;prompt:string}):FalCostEstimate{
  const {model,endpoint,config,referenceCount,prompt}=input;
  if(!endpoint||validateFalImageConfig(model,config,referenceCount,prompt,input.maskCount??0).length)return{state:"unavailable",reason:"configuration-conflict"};
  const pricing=entry(endpoint);if(!pricing)return{state:"unavailable",reason:"unsupported-combination"};
  const variants=config.variants;
  if(pricing.kind==="token-unknown")return{state:"unavailable",reason:"provider-usage-unknown",source:String(pricing.source)};
  if(pricing.kind==="per-output"){
    const rate=record(pricing.rates)?.[config.size];if(typeof rate!=="number")return{state:"unavailable",reason:"unpriced-resolution",source:String(pricing.source)};
    const search=config.webSearch?Number(pricing.webSearchPerRequest??0):0;const amount=money(rate*variants+search);
    return available(endpoint,model.schemaHash,pricing,amount,"formula","outputs × rate(size) + optional web-search request surcharge",{size:config.size,variants,webSearch:Boolean(config.webSearch),referenceCount});
  }
  if(pricing.kind==="rounded-megapixel"){
    const size=dimensions[config.size];if(!size)return{state:"unavailable",reason:"unpriced-resolution",source:String(pricing.source)};
    const roundedMp=Math.ceil(size[0]*size[1]/1_000_000);const amount=money(Number(pricing.usdPerMegapixel)*roundedMp*variants);
    return available(endpoint,model.schemaHash,pricing,amount,"formula","outputs × ceil(width × height / 1,000,000) × USD/MP",{size:config.size,width:size[0],height:size[1],roundedMegapixels:roundedMp,variants,referenceCount});
  }
  if(pricing.kind==="seedream-tier"||pricing.kind==="seedream-edit-tier"){
    const large=config.size==="auto_2K";if(config.size.startsWith("auto_")&&!large&&config.size!=="auto_1K")return{state:"unavailable",reason:"unpriced-resolution",source:String(pricing.source)};
    const base=Number(large?pricing.large:pricing.small);const inputSurcharge=pricing.kind==="seedream-edit-tier"?Number(pricing.additionalInput)*Math.max(0,referenceCount-1):0;
    const amount=money(variants*(base+inputSurcharge));
    return available(endpoint,model.schemaHash,pricing,amount,"tentative","outputs × (resolution tier + additional input images after the first)",{size:config.size,variants,referenceCount,additionalChargedInputs:Math.max(0,referenceCount-1)});
  }
  if(pricing.kind==="gpt-image-2-projection"||pricing.kind==="gpt-image-2-edit-projection"){
    if((input.maskCount??0)>0)return{state:"unavailable",reason:"provider-usage-unknown",source:String(pricing.source)};
    if(pricing.kind==="gpt-image-2-edit-projection"&&referenceCount!==1)return{state:"unavailable",reason:"provider-usage-unknown",source:String(pricing.source)};
    const size=gpt2Size[config.size],quality=config.quality;if(!size||!quality||quality==="auto")return{state:"unavailable",reason:"provider-usage-unknown",source:String(pricing.source)};
    const rate=record(record(pricing.tables)?.[size])?.[quality];if(typeof rate!=="number")return{state:"unavailable",reason:"provider-usage-unknown",source:String(pricing.source)};
    return available(endpoint,model.schemaHash,pricing,money(rate*variants),"projection","outputs × official size/quality projection; actual token usage may differ",{size,quality,variants,referenceCount});
  }
  if(pricing.kind==="gpt-image-1.5-minimum"||pricing.kind==="gpt-image-1.5-edit-minimum"){
    const quality=config.quality;const rate=quality?record(record(pricing.tables)?.[config.size])?.[quality]:undefined;if(typeof rate!=="number")return{state:"unavailable",reason:"provider-usage-unknown",source:String(pricing.source)};
    return available(endpoint,model.schemaHash,pricing,money(rate*variants),"minimum","outputs × output-image base price; variable text/input-image tokens are additional",{size:config.size,quality:quality!,variants,referenceCount,inputFidelity:config.inputFidelity??"none"});
  }
  return{state:"unavailable",reason:"provider-usage-unknown",source:String(pricing.source)};
}

export function estimateFalVideoCost(input:{capability:FalVideoCapabilities|undefined;config:FalVideoEndpointConfig;occupancy:FalVideoPortOccupancy}):FalCostEstimate{
  const {capability,config,occupancy}=input;if(!capability||validateFalVideoConfig(capability,config,occupancy).length)return{state:"unavailable",reason:"configuration-conflict"};
  const pricing=entry(capability.endpoint);if(!pricing)return{state:"unavailable",reason:"unsupported-combination"};
  if(config.duration==="auto")return{state:"unavailable",reason:"automatic-duration",source:String(pricing.source)};
  if(config.resolution!=="720p")return{state:"unavailable",reason:"unpriced-resolution",source:String(pricing.source)};
  const amount=money(Number(pricing.usdPerSecond)*config.duration);
  return available(capability.endpoint,capability.schemaHash,pricing,amount,"formula","generated seconds × 720p fast-tier USD/second; audio has no surcharge",{duration:config.duration,resolution:config.resolution,generateAudio:config.generateAudio,audioSurchargeMicrounits:0,mode:capability.mode,referenceCount:occupancy.references});
}

export const FAL_PRICING_MANIFEST=manifestJson;
