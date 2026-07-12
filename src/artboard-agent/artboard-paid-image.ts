import { cancelFalImage, completedFalImage, pendingFalImageRuns, resumeFalImage, runFalImage, type FalImageResult } from "../api";
import type { ArtboardWorkspace } from "../nodes/brand/artboard-domain";
import { defaultFalImageConfig, falImageEndpoint, falImageRequestConfig, falImageStreamingMode, validateFalImageConfig, type FalImageConfig, type FalImageModel } from "../nodes/image/capabilities";
import { estimateFalImageCost, falImageCostContext, resolveFalCostEstimate } from "../nodes/fal-pricing";
import type { ArtboardProposalRepository } from "./proposal-repository";
import type { ArtboardImageGenerationIntent, PersistedArtboardProposal, ResolvedArtboardProposal } from "./proposals";
import { canonicalStringify } from "../engine/fingerprint";

export type ArtboardPaidImageContext={workspace:ArtboardWorkspace;workspaceId:string;branchId:string;revision:{id:string;number:number};proposalId:string;intent:ArtboardImageGenerationIntent};

export function resolveIntentReferences(context:ArtboardPaidImageContext):string[]{
  const board=context.workspace.boards[context.intent.boardId];
  if(!board)throw new Error("Das Ziel-Artboard existiert nicht mehr.");
  return context.intent.referenceBindingIds.map((id)=>{
    const binding=board.document.bindings[id];
    if(!binding||binding.snapshot.kind!=="cas"||!/^[a-f0-9]{64}$/.test(binding.snapshot.hash))throw new Error(`Referenz ${id} ist keine lokal gespeicherte CAS-Bildrevision.`);
    return `flowz-cas:${binding.snapshot.hash}`;
  });
}

export async function artboardIntentRunId(context:ArtboardPaidImageContext,requestIdentity:unknown={}):Promise<string>{
  const bytes=new TextEncoder().encode(canonicalStringify({workspaceId:context.workspaceId,branchId:context.branchId,proposalId:context.proposalId,intentId:context.intent.id,revision:context.revision,requestIdentity}));
  const hash=new Uint8Array(await crypto.subtle.digest("SHA-256",bytes));
  hash[6]=(hash[6]&0x0f)|0x50;hash[8]=(hash[8]&0x3f)|0x80;
  const hex=[...hash.slice(0,16)].map((value)=>value.toString(16).padStart(2,"0")).join("");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export function artboardIntentConfig(model:FalImageModel,intent:ArtboardImageGenerationIntent,patch?:Partial<FalImageConfig>):FalImageConfig{
  const base=defaultFalImageConfig(model),config={...base,...patch,aspectRatio:intent.aspectRatio};
  if(config.background==="transparent"&&!(model.background as readonly string[]).includes("transparent"))throw new Error("Dieser exakte Endpoint unterstützt keine Transparenz.");
  return config;
}

export function artboardIntentRequestIdentity(context:ArtboardPaidImageContext,model:FalImageModel,config:FalImageConfig){
  const references=resolveIntentReferences(context),endpoint=falImageEndpoint(model,references.length);
  const errors=validateFalImageConfig(model,config,references.length,context.intent.prompt);
  if(!endpoint||errors.length)throw new Error(errors.join(" ")||"Für diese Eingänge existiert kein geprüfter Endpoint.");
  const requestConfig=falImageRequestConfig(model,config,references.length),streaming=Boolean(config.streamingEnabled&&falImageStreamingMode(model,endpoint));
  return {modelId:model.id,endpoint,schemaHash:model.schemaHash,prompt:context.intent.prompt,references,config:requestConfig,streaming};
}

export async function executeArtboardImageIntent(context:ArtboardPaidImageContext,model:FalImageModel,config:FalImageConfig,signal:AbortSignal):Promise<FalImageResult>{
  if(!context.intent.requiresExplicitConfirmation)throw new Error("Der kostenpflichtige Auftrag besitzt keine explizite Bestätigungspflicht.");
  const requestIdentity=artboardIntentRequestIdentity(context,model,config),{references,endpoint}=requestIdentity;
  const official=estimateFalImageCost({model,endpoint,config,referenceCount:references.length,prompt:context.intent.prompt});
  const costContext=falImageCostContext({model,endpoint,config,referenceCount:references.length});
  const estimate=await resolveFalCostEstimate(official,endpoint,model.schemaHash,costContext);
  if(estimate.state==="unavailable")throw new Error("Für diese Konfiguration ist keine belastbare Vorabkostenschätzung verfügbar.");
  const requestConfig=requestIdentity.config,streaming=requestIdentity.streaming;
  const runId=await artboardIntentRunId(context,requestIdentity),nodeId=`artboard-intent:${context.intent.id}`;
  const completed=await completedFalImage(runId);if(completed)return completed;
  const pending=(await pendingFalImageRuns(context.workspaceId,nodeId)).find((run)=>run.runId===runId);
  if(pending){if(["cancelled","failed","submitUnknown"].includes(pending.phase))throw new Error("Der bestätigte Lauf kann nicht sicher erneut gesendet werden.");return resumeFalImage(runId);}
  signal.throwIfAborted();
  const cancel=()=>void cancelFalImage(runId);signal.addEventListener("abort",cancel,{once:true});
  try{return await runFalImage({runId,projectId:context.workspaceId,nodeId,modelId:model.id,endpoint,schemaHash:model.schemaHash,prompt:context.intent.prompt,references,config:requestConfig,inputFingerprint:{kind:"artboard-paid-image",proposalId:context.proposalId,intentId:context.intent.id,revisionId:context.revision.id,requestContract:{...requestIdentity,mask:null}},streaming,costEstimate:estimate.snapshot,costContext,artboardTarget:{workspaceId:context.workspaceId,branchId:context.branchId,boardId:context.intent.boardId,expectedRevisionId:context.revision.id,expectedRevisionNumber:context.revision.number,proposalId:context.proposalId,intentId:context.intent.id}});}finally{signal.removeEventListener("abort",cancel);}
}

export async function persistPaidResultProposal(repository:ArtboardProposalRepository,context:ArtboardPaidImageContext,result:FalImageResult,current:{workspace:ArtboardWorkspace;branchId:string;revision:{id:string;number:number}}):Promise<ResolvedArtboardProposal>{
  const image=result.images[0];if(!image||!/^[a-f0-9]{64}$/.test(image.blobHash))throw new Error("Das bezahlte Bild wurde nicht vollständig im lokalen CAS gespeichert.");
  const proposalId=`paid-result-${context.intent.id}-${result.runId}`.slice(0,128),existing=await repository.findProposal(proposalId);if(existing?.resolved)return existing.resolved;
  const board=current.workspace.boards[context.intent.boardId];if(!board)throw new Error("Das bezahlte Asset wurde gesichert, aber das Ziel-Artboard existiert nicht mehr.");
  const layerId=`generated-${context.intent.id}`;
  const layers=structuredClone(board.document.layers);
  layers[layerId]={id:layerId,type:"image",name:context.intent.role,locked:false,visible:true,version:(layers[layerId]?.version??0)+1,geometry:layers[layerId]?.geometry??{x:0,y:0,width:board.document.format.width,height:board.document.format.height,rotation:0},casHash:image.blobHash,fit:"cover"};
  const rootLayerIds=board.document.rootLayerIds.includes(layerId)?[...board.document.rootLayerIds]:[...board.document.rootLayerIds,layerId];
  const operation={type:"set-layer-tree" as const,boardId:board.id,rootLayerIds,layers};
  const resolved:ResolvedArtboardProposal={proposalId,summary:`Bezahltes Bild „${context.intent.role}“ als neue Ebene vorschlagen.`,batch:{operationId:`apply-${result.runId}`,expectedRevisionId:current.revision.id,expectedRevisionNumber:current.revision.number,operations:[operation]},changes:[{id:layerId,label:`Bild „${context.intent.role}“ hinzufügen`,kind:layers[layerId]?"add":"change",boardName:board.name}],warnings:context.revision.id===current.revision.id?undefined:["Der Workspace wurde während der Generierung geändert. Dieser Vorschlag wurde sicher auf den aktuellen Stand neu abgeleitet."]};
  const now=new Date().toISOString();
  const receiptResult={kind:"paid-image",runId:result.runId,modelId:result.modelId,endpoint:result.endpoint,resultId:image.resultId,assetId:image.assetId,blobHash:image.blobHash,mediaType:image.mediaType,costMicrounits:result.costMicrounits,costProvenance:result.costProvenance,targetCurrent:result.targetCurrent};
  const receiptHash=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(canonicalStringify(receiptResult))));
  const payloadFingerprint=[...receiptHash].map((value)=>value.toString(16).padStart(2,"0")).join("");
  const persisted:PersistedArtboardProposal={proposalId,workspaceId:context.workspaceId,branchId:current.branchId,expectedRevisionId:current.revision.id,expectedRevisionNumber:current.revision.number,state:"frozen",operations:[operation],imageGenerationIntents:[],receipts:[{operationId:`paid-${result.runId}`,payloadFingerprint,result:receiptResult}],createdAt:now,updatedAt:now,resolved};
  await repository.saveProposal(persisted);return resolved;
}
