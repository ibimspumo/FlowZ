import { invoke } from '@tauri-apps/api/core';
import type { AiResult, ModelOption } from './types';
import { getTextAiSystemInstruction } from './preferences/text-ai';

const isTauri = () => '__TAURI_INTERNALS__' in window;

function desktopOnly(): never {
  throw new Error('API-Aufrufe funktionieren in der Desktop-App. Starte sie mit „npm run tauri dev“.');
}

export async function keyStatus() { return isTauri() ? invoke<boolean>('openrouter_key_status') : false; }
export async function saveKey(key: string) { if (!isTauri()) desktopOnly(); return invoke<void>('save_openrouter_key', { key }); }
export async function deleteKey() { if (!isTauri()) desktopOnly(); return invoke<void>('delete_openrouter_key'); }
export async function braveKeyStatus() { return isTauri() ? invoke<boolean>('brave_search_key_status') : false; }
export async function saveBraveKey(key: string) { if (!isTauri()) desktopOnly(); return invoke<void>('save_brave_search_key', { key }); }
export async function deleteBraveKey() { if (!isTauri()) desktopOnly(); return invoke<void>('delete_brave_search_key'); }
export async function falKeyStatus() { return isTauri() ? invoke<boolean>('fal_key_status') : false; }
export async function saveFalKey(key: string) { if (!isTauri()) desktopOnly(); return invoke<void>('save_fal_key', { key }); }
export async function deleteFalKey() { if (!isTauri()) desktopOnly(); return invoke<void>('delete_fal_key'); }
export async function falUploadCacheStatus() { return isTauri() ? invoke<{ entries: number; nextExpiry?: string }>('fal_upload_cache_status') : { entries: 0 }; }
export async function clearFalUploadCache() { if (!isTauri()) return; return invoke<void>('fal_upload_cache_clear'); }

export type FalEmpiricalCostEstimate = {
  state: 'available' | 'insufficient';
  provenance: 'local-actual';
  sampleCount: number;
  usedSampleCount: number;
  rejectedOutliers: number;
  lastObservedAt: string | null;
  medianMicrounits: number | null;
  p25Microunits: number | null;
  p75Microunits: number | null;
};
export async function falEmpiricalCostEstimate(request: {
  endpoint: string;
  adapterSchemaHash: string;
  pricingManifestVersion: number;
  billableConfig: Record<string, import('./domain/project').JsonValue>;
}): Promise<FalEmpiricalCostEstimate> {
  if (!isTauri()) return { state: 'insufficient', provenance: 'local-actual', sampleCount: 0, usedSampleCount: 0, rejectedOutliers: 0, lastObservedAt: null, medianMicrounits: null, p25Microunits: null, p75Microunits: null };
  return invoke('fal_empirical_cost_estimate', { request });
}

export type ExportItem = { text?: string; blobHash?: string };
export type ExportResult = { files: string[]; folder: string };
export type ExportFolderGrant={grantId:string;displayName:string};
export async function pickExportFolder(projectId:string): Promise<ExportFolderGrant | undefined> { if (!isTauri()) return; return (await invoke<ExportFolderGrant | null>('export_pick_folder',{projectId})) ?? undefined; }
export async function writeExport(request: { projectId:string; grantId:string; project: string; node: string; run: string; nameTemplate: string; overwrite: 'rename'|'replace'|'error'; items: ExportItem[] }): Promise<ExportResult> { if (!isTauri()) desktopOnly(); return invoke('export_write', { request }); }
export async function revealExport(projectId:string,grantId:string,path: string): Promise<void> { if (!isTauri()) return; await invoke('export_reveal', { projectId,grantId,path }); }

export type ArtboardExportFolderGrant={grantId:string;displayName:string};
export type ArtboardExportBoard={boardId:string;boardRevisionId:string;name:string;pngBase64:string};
export type ArtboardExportResult={files:string[];folder:string};
export async function pickArtboardExportFolder(documentId:string):Promise<ArtboardExportFolderGrant|undefined>{if(!isTauri())return;return(await invoke<ArtboardExportFolderGrant|null>('artboard_export_pick_folder',{documentId}))??undefined;}
export async function writeArtboardExport(request:{documentId:string;workspaceId:string;revisionId:string;grantId:string;overwrite:'rename'|'replace'|'error';includeManifest:boolean;boards:ArtboardExportBoard[]}):Promise<ArtboardExportResult>{if(!isTauri())desktopOnly();return invoke('artboard_export_write',{request});}
export async function revealArtboardExport(documentId:string,grantId:string,path:string):Promise<void>{if(!isTauri())return;await invoke('artboard_export_reveal',{documentId,grantId,path});}

export type ArtboardRevisionRecord={id:string;workspaceId:string;branchId:string;parentRevisionId?:string;revisionNumber:number;workspace:import('./nodes/brand/artboard-domain').ArtboardWorkspace;inputSnapshotId?:string;operationId:string;operations:Record<string,unknown>[];createdAt:string};
export type ArtboardBranchRecord={id:string;workspaceId:string;name:string;headRevisionId:string;redoRevisionId?:string;forkRevisionId?:string;createdAt:string};
export type ArtboardWorkspaceRecord={id:string;projectId?:string;nodeId?:string;name:string;createdAt:string;updatedAt:string;branches:ArtboardBranchRecord[]};
export async function createArtboardWorkspace(request:{workspaceId:string;projectId?:string;nodeId?:string;name:string;branchId:string;revisionId:string;operationId:string;workspace:import('./nodes/brand/artboard-domain').ArtboardWorkspace;inputSnapshot?:import('./nodes/brand/artboard-domain').ArtboardInputSnapshot;createdAt:string}):Promise<ArtboardRevisionRecord>{if(!isTauri())desktopOnly();return invoke('artboard_workspace_create',{request});}
export async function openArtboardWorkspace(id:string):Promise<ArtboardWorkspaceRecord|undefined>{if(!isTauri())return;return (await invoke<ArtboardWorkspaceRecord|null>('artboard_workspace_open',{id}))??undefined;}
export async function openArtboardRevision(id:string):Promise<ArtboardRevisionRecord|undefined>{if(!isTauri())return;return (await invoke<ArtboardRevisionRecord|null>('artboard_revision_open',{id}))??undefined;}
export async function applyArtboardOperations(request:{workspaceId:string;branchId:string;revisionId:string;operationId:string;expectedRevisionId:string;expectedRevisionNumber:number;operations:Record<string,unknown>[];workspace:import('./nodes/brand/artboard-domain').ArtboardWorkspace;inputSnapshot?:import('./nodes/brand/artboard-domain').ArtboardInputSnapshot;createdAt:string}):Promise<ArtboardRevisionRecord>{if(!isTauri())desktopOnly();return invoke('artboard_apply_operations',{request});}
export async function createArtboardBranch(request:{workspaceId:string;branchId:string;name:string;fromRevisionId:string;createdAt:string}):Promise<ArtboardBranchRecord>{if(!isTauri())desktopOnly();return invoke('artboard_branch_create',{request});}
export async function moveArtboardHead(request:{workspaceId:string;branchId:string;expectedRevisionId:string;targetRevisionId:string}):Promise<ArtboardBranchRecord>{if(!isTauri())desktopOnly();return invoke('artboard_move_head',{request});}
export async function registerArtboardInputSnapshot(request:{workspaceId:string;snapshot:import('./nodes/brand/artboard-domain').ArtboardInputSnapshot;createdAt:string}):Promise<string>{if(!isTauri())desktopOnly();return invoke('artboard_register_input_snapshot',{request});}
export type ArtboardCompositeResult={boardId:string;active:boolean;selectedIndex?:number;resultId:string;assetId:string;blobHash:string;mediaType:'image/png';width:number;height:number;createdAt:string};
export async function persistArtboardComposites(request:{operationId:string;projectId:string;nodeId:string;workspaceId:string;revisionId:string;composites:{boardId:string;active:boolean;selectedIndex?:number;pngBytes:number[]}[]}):Promise<ArtboardCompositeResult[]>{if(!isTauri())desktopOnly();return invoke('artboard_composites_persist',{request});}

export type FalVideoResult = {
  runId: string; resultId: string; videoHash: string; startFrameHash: string; endFrameHash: string;
  mediaType: string; mediaMetadata: import('./types').MediaMetadata; posterHash?: string;
  costMicrounits?: number; billableUnits?: string; costProvenance: 'actual' | 'estimated' | 'unknown'; targetCurrent: boolean; contractError?: string;
};

export type FalPendingRun = { runId: string; projectId: string; nodeId: string; endpoint: string; phase: string; createdAt: string; error?: string };

export async function runFalVideo(request: {
  runId: string; projectId: string; nodeId: string; endpoint: string; schemaHash: string; prompt: string;
  duration: number | 'auto'; resolution: string; aspectRatio: string; generateAudio: boolean; bitrateMode: 'standard' | 'high'; seed?: number;
  startFrame?: string; endFrame?: string; references: string[];
  inputFingerprint: Record<string, unknown>; estimatedCostMicrounits?: number; costEstimate?: import('./domain/project').JsonValue; costContext?: import('./domain/project').JsonValue;
}): Promise<FalVideoResult> {
  if (!isTauri()) desktopOnly();
  return invoke<FalVideoResult>('fal_video_start', { request });
}
export async function resumeFalVideo(runId: string): Promise<FalVideoResult> {
  if (!isTauri()) desktopOnly(); return invoke<FalVideoResult>('fal_video_resume', { runId });
}
export async function pendingFalRuns(projectId: string, nodeId?: string): Promise<FalPendingRun[]> {
  if (!isTauri()) return []; return invoke<FalPendingRun[]>('fal_pending_runs', { projectId, nodeId });
}
export async function cancelFalRun(runId: string): Promise<boolean> {
  if (!isTauri()) return false; return invoke<boolean>('fal_cancel_run', { runId });
}

export type FalImageResult = {
  runId: string; modelId: string; endpoint: string;
  images: { resultId: string; assetId: string; blobHash: string; mediaType: string; width: number; height: number; hasAlpha: boolean }[];
  costMicrounits?: number; billableUnits?: string; costProvenance: 'actual' | 'estimated' | 'unknown'; targetCurrent: boolean; contractError?: string;
};
export type FalPendingImageRun = { runId: string; projectId: string; nodeId: string; modelId: string; endpoint: string; phase: string; createdAt: string; error?: string; streaming: boolean; resumable: boolean };
export async function runFalImage(request: {
  runId: string; projectId: string; nodeId: string; modelId: string; endpoint: string; schemaHash: string;
  prompt: string; references: string[]; mask?: string; config: Record<string, unknown>; inputFingerprint: Record<string, unknown>;
  streaming: boolean; costEstimate?: import('./domain/project').JsonValue; costContext?: import('./domain/project').JsonValue;
  artboardTarget?: { workspaceId:string; branchId:string; boardId:string; expectedRevisionId:string; expectedRevisionNumber:number; proposalId:string; intentId:string };
}): Promise<FalImageResult> { if (!isTauri()) desktopOnly(); return invoke('fal_image_start', { request }); }
export async function resumeFalImage(runId: string): Promise<FalImageResult> { if (!isTauri()) desktopOnly(); return invoke('fal_image_resume', { runId }); }
export async function completedFalImage(runId: string): Promise<FalImageResult|undefined> { if (!isTauri()) return; return (await invoke<FalImageResult|null>('fal_image_completed', { runId }))??undefined; }
export async function pendingFalImageRuns(projectId: string, nodeId?: string): Promise<FalPendingImageRun[]> { if (!isTauri()) return []; return invoke('fal_image_pending', { projectId, nodeId }); }
export async function cancelFalImage(runId: string): Promise<boolean> { if (!isTauri()) return false; return invoke('fal_image_cancel', { runId }); }
export type FalImageToolResult = {
  runId: string; resultId: string; assetId: string; blobHash: string; mediaType: string;
  width: number; height: number; hasAlpha: boolean; costMicrounits?: number; billableUnits?: string;
  costProvenance: 'actual' | 'estimated' | 'unknown'; targetCurrent: boolean; contractError?: string;
};
export async function runFalImageTool(request: {
  runId: string; projectId: string; nodeId: string; endpoint: string; schemaHash: string;
  source: string; config: Record<string, unknown>; estimatedCostMicrounits?: number; inputFingerprint: Record<string, unknown>;
}): Promise<FalImageToolResult> { if (!isTauri()) desktopOnly(); return invoke('fal_image_tool_start', { request }); }
export async function cancelFalImageTool(runId: string): Promise<boolean> { if (!isTauri()) return false; return invoke('fal_image_tool_cancel', { runId }); }
export type FalPendingImageToolRun = { runId: string; projectId: string; nodeId: string; endpoint: string; phase: string; createdAt: string; error?: string };
export async function pendingFalImageToolRuns(projectId: string, nodeId?: string): Promise<FalPendingImageToolRun[]> { if (!isTauri()) return []; return invoke('fal_image_tool_pending', { projectId, nodeId }); }
export async function resumeFalImageTool(runId: string): Promise<FalImageToolResult> { if (!isTauri()) desktopOnly(); return invoke('fal_image_tool_resume', { runId }); }
export async function extractVideoFrame(request: { projectId: string; nodeId: string; videoHash: string; mode: 'first' | 'last' | 'seconds' | 'percent'; value?: number; durationSeconds: number; executionFingerprint: string }): Promise<{ resultId: string; imageHash: string }> {
  if (!isTauri()) desktopOnly(); return invoke('extract_video_frame_result', { request });
}
export type ImageTransformResult={resultId:string;assetId:string;blobHash:string;mediaType:string;width:number;height:number;hasAlpha:boolean;recipeFingerprint:string;cached:boolean};
export async function transformImage(request:{runId:string;projectId:string;nodeId:string;source:string;recipe:import('./nodes/image').ImageTransformRecipe;executionFingerprint:string;groupRunId:string;listIndex:number;listCount:number;expectedConfig:Record<string,unknown>}):Promise<ImageTransformResult>{if(!isTauri())desktopOnly();return invoke('transform_image',{request});}
export type ImageTrimResult={resultId:string;assetId:string;blobHash:string;mediaType:string;sourceWidth:number;sourceHeight:number;width:number;height:number;recipeFingerprint:string;cached:boolean;outcome:'trimmed'|'no_alpha'|'opaque_noop'|'fully_transparent'|'below_threshold'|'visible_1x1';targetCurrent:boolean};
export async function trimTransparentImage(request:{runId:string;projectId:string;nodeId:string;source:string;recipe:{threshold:number;padding:number};executionFingerprint:string;groupRunId:string;listIndex:number;listCount:number;expectedConfig:Record<string,unknown>;expectedBinding?:{sourceNodeId:string;sourcePortId:string;targetPortId:string;hashes:string[]}}):Promise<ImageTrimResult>{if(!isTauri())desktopOnly();return invoke('trim_transparent_image',{request});}

export type WebpageResult = { finalUrl: string; title?: string; text: string; screenshotDataUrl?: string; screenshotProvider?: string; truncated: boolean };
export async function fetchWebpage(url: string, includeScreenshot: boolean): Promise<WebpageResult> {
  if (!isTauri()) desktopOnly();
  return invoke<WebpageResult>('fetch_webpage', { request: { url, includeScreenshot } });
}

export type ResearchResult = { provider: string; markdown: string; resultCount: number };
export async function runWebResearch(query: string, resultCount: number, freshness: string): Promise<ResearchResult> {
  if (!isTauri()) desktopOnly();
  return invoke<ResearchResult>('run_web_research', { request: { query, resultCount, freshness } });
}

export async function getModels(kind: 'text' | 'image' | 'vision' | 'transcription'): Promise<ModelOption[]> {
  if (!isTauri()) return [];
  const response = await invoke<{ data?: { id: string; name?: string; supported_parameters?: string[] | Record<string, import('./types').CapabilityDescriptor>; supports_streaming?: boolean; endpoints?: string; architecture?: { input_modalities?: string[]; output_modalities?: string[] }; flowz_capabilities?: { timestamps?: boolean; timestampReason?: string } }[] }>('list_models', { kind });
  return (response.data ?? []).map((model) => ({
    id: model.id,
    name: model.name ?? model.id,
    supportedParameters: Array.isArray(model.supported_parameters) ? model.supported_parameters : Object.keys(model.supported_parameters ?? {}),
    parameterDescriptors: Array.isArray(model.supported_parameters) ? {} : model.supported_parameters ?? {},
    supportsStreaming: model.supports_streaming === true,
    endpoints: model.endpoints,
    supportsTimestamps: model.flowz_capabilities?.timestamps === true,
    timestampReason: model.flowz_capabilities?.timestampReason,
    inputModalities: model.architecture?.input_modalities ?? [],
    outputModalities: model.architecture?.output_modalities ?? [],
  }));
}

export type TranscriptionResult = {
  text: string;
  costMicrounits?: number;
  generationId?: string;
  resultId?: string;
  createdAt: string;
  persisted: boolean;
  targetCurrent: boolean;
  persistenceError?: string;
  timestamps?: import('./types').TranscriptionTimestamps;
};

export async function runTranscription(request: {
  runId: string;
  projectId: string;
  nodeId: string;
  sourceNodeId: string;
  sourceResultId: string;
  sourceBlobHash: string;
  model: string;
  language?: string;
  timestamps: boolean;
  executionFingerprint: string;
}): Promise<TranscriptionResult> {
  if (!isTauri()) desktopOnly();
  return invoke<TranscriptionResult>('run_transcription', { request });
}

export async function cancelTranscriptionRun(runId: string): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>('cancel_transcription_run', { runId });
}

export async function runChat(model: string, prompt: string, images: string[] = [], outputMode: 'free' | 'single' = 'free') {
  if (!isTauri()) desktopOnly();
  return invoke<AiResult>('run_chat', { request: { model, prompt, images, outputMode, systemInstruction:getTextAiSystemInstruction() } });
}

export async function runStructuredChat(model: string, prompt: string, schemaName: string, schema: Record<string, unknown>) {
  if (!isTauri()) desktopOnly();
  return invoke<AiResult>('run_chat', { request: { model, prompt, images: [], outputMode: 'structured', schemaName, schema, systemInstruction:getTextAiSystemInstruction() } });
}
export async function storePaidBrandResult(request:{runId:string;projectId:string;nodeId:string;model:string;kind:string;text:string;costMicrounits?:number;parameters:Record<string,unknown>}){
  if(!isTauri())desktopOnly();return invoke<{resultId:string;persisted:boolean;outboxed:boolean;targetCurrent:boolean;persistenceError?:string}>('store_paid_brand_result',{request});
}

export async function checkBrandDomains(labels: string[], tlds: string[], privacyConsent: boolean) {
  if (!isTauri()) desktopOnly();
  return invoke<import('./nodes/brand').DomainCheck[]>('brand_check_domains', { request: { labels, tlds, privacyConsent } });
}

export async function prepareBrandFont(font: import('./nodes/brand').FontRecord) {
  if (!isTauri()) desktopOnly();
  return invoke<{blobHash:string;licenseBlobHash:string;mediaUrl:string;fontSha256:string}>('brand_prepare_font', { request: {
    family:font.family,metadataUrl:font.metadataUrl,metadataSha256:font.metadataSha256,licenseUrl:font.licenseUrl,licenseSha256:font.licenseSha256,
    fontUrl:font.fontUrl,fontSha256:font.fontSha256,fontFile:font.fontFile,axes:font.axes,axisRanges:font.axisRanges.map(({tag,min,max})=>({tag,min,max})),subsets:font.subsets,license:font.license==='OFL-1.1'?'OFL':font.license==='Apache-2.0'?'APACHE2':'UFL',path:font.path,style:font.style,weight:font.weight,variantIndex:font.variantIndex,axisValues:Object.fromEntries(font.axisRanges.filter(axis=>axis.value!=null).map(axis=>[axis.tag,axis.value!])),
  }});
}
export async function previewBrandFont(font: import('./nodes/brand').FontRecord) {
  if (!isTauri()) desktopOnly();
  return invoke<{mediaUrl:string;fontSha256:string}>('brand_preview_font', { request: {
    family:font.family,metadataUrl:font.metadataUrl,metadataSha256:font.metadataSha256,licenseUrl:font.licenseUrl,licenseSha256:font.licenseSha256,
    fontUrl:font.fontUrl,fontSha256:font.fontSha256,fontFile:font.fontFile,axes:font.axes,axisRanges:font.axisRanges.map(({tag,min,max})=>({tag,min,max})),subsets:font.subsets,license:font.license==='OFL-1.1'?'OFL':font.license==='Apache-2.0'?'APACHE2':'UFL',path:font.path,style:font.style,weight:font.weight,variantIndex:font.variantIndex,axisValues:Object.fromEntries(font.axisRanges.filter(axis=>axis.value!=null).map(axis=>[axis.tag,axis.value!])),
  }});
}
export type FontCacheEntry={family:string;style:string;weight:number;variantIndex:number;fontUrl:string;fontFile:string;blobHash:string;licenseBlobHash:string;fontSha256:string;sizeBytes:number;lastUsedAt:string};
export async function listBrandFontCache(){if(!isTauri())return[];return invoke<FontCacheEntry[]>('brand_font_cache_list');}
export async function deleteBrandFontCache(blobHash:string){if(!isTauri())desktopOnly();return invoke<void>('brand_font_cache_delete',{blobHash});}
