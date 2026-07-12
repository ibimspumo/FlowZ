import { invoke } from '@tauri-apps/api/core';
import { isDesktopRuntime } from './projects';

export type LibraryResult = {
  resultId: string;
  runId: string;
  projectId: string;
  nodeId: string;
  kind: string;
  textValue?: string;
  blobHash?: string;
  assetId?: string;
  mediaType?: string;
  dataUrl?: string;
  hydrationError?: string;
  createdAt: string;
  costMicrounits?: number;
  model?: string;
  prompt?: string;
  parameters?: Record<string, unknown>;
  active: boolean;
};

export type LibraryResultPage = {
  items: LibraryResult[];
  total: number;
  page: number;
  pageSize: number;
};

export type LibraryResultQuery = {
  projectId?: string;
  nodeId?: string;
  kind?: string;
  query?: string;
  page?: number;
  pageSize?: number;
};

export type LibraryResultContent = {
  resultId: string;
  textValue?: string;
  blobHash?: string;
  mediaType?: string;
  /** Immutable local CAS URL; never a provider URL. */
  mediaUrl?: string;
};

export type StoreLibraryResult = {
  /** Reuses one provider run for multiple immutable variants. */
  runId?: string;
  projectId: string;
  nodeId: string;
  model?: string;
  kind: 'text' | 'image' | 'input-image' | 'webpage';
  text?: string;
  dataUrl?: string;
  originalName?: string;
  costMicrounits?: number;
  prompt?: string;
  parameters?: Record<string, string | number | boolean>;
};

export async function storeLibraryResult(request: StoreLibraryResult): Promise<LibraryResult> {
  if (!isDesktopRuntime()) throw new Error('Die Bibliothek ist nur in der Desktop-App verfügbar.');
  return invoke<LibraryResult>('library_store_result', { request });
}

export async function loadProjectResults(projectId: string): Promise<LibraryResult[]> {
  if (!isDesktopRuntime()) return [];
  return invoke<LibraryResult[]>('library_project_results', { projectId });
}

/** Paginated server-side history. Page sizes are clamped to 1–100 by Rust. */
export async function loadLibraryResultPage(request: LibraryResultQuery = {}): Promise<LibraryResultPage> {
  if (!isDesktopRuntime()) return { items: [], total: 0, page: Math.min(1_000_000, Math.max(0, request.page ?? 0)), pageSize: Math.min(100, Math.max(1, request.pageSize ?? 40)) };
  return invoke<LibraryResultPage>('library_result_search', { request });
}

/** Resolves up to 100 immutable result payloads in one fail-closed project-bound batch. */
export async function loadLibraryResultContents(projectId: string, resultIds: string[]): Promise<LibraryResultContent[]> {
  if (!isDesktopRuntime()) return [];
  return invoke<LibraryResultContent[]>('library_result_contents', { projectId, resultIds });
}

export async function loadOrphanResults(projectId: string): Promise<LibraryResult[]> {
  if (!isDesktopRuntime()) return [];
  return invoke<LibraryResult[]>('library_orphan_results', { projectId });
}
export async function reassignResult(projectId: string, resultId: string, nodeId: string): Promise<void> {
  await invoke('library_reassign_result', { projectId, resultId, nodeId });
}

export async function loadLibraryResultData(projectId: string, resultId: string): Promise<string | undefined> {
  if (!isDesktopRuntime()) return undefined;
  return (await invoke<string | null>('library_result_data', { projectId, resultId })) ?? undefined;
}

export async function setActiveLibraryResult(projectId: string, nodeId: string, resultId: string): Promise<void> {
  if (!isDesktopRuntime()) return;
  await invoke('library_set_active_result', { projectId, nodeId, resultId });
}

export type StorageBreakdown = { totalBytes: number; totalBlobs: number; projects: { projectId: string; projectName: string; nodeId: string; mediaType: string; referencedBytes: number; resultCount: number }[] };
export type CostBreakdown = { actualMicrounits: number; estimatedMicrounits: number; unknownRuns: number; rows: { nodeId: string; model: string; day: string; provenance: 'actual'|'estimated'|'unknown'; amountMicrounits?: number; runs: number }[] };
export async function loadStorageBreakdown(): Promise<StorageBreakdown> { return invoke('library_storage_breakdown'); }
export async function loadProjectCosts(projectId: string): Promise<CostBreakdown> { return invoke('library_project_costs', { projectId }); }
export async function deleteLibraryResult(projectId: string, resultId: string, protectedIds:string[]): Promise<number> { return invoke('library_delete_result', { projectId, resultId,protectedIds }); }
export async function clearNodeHistory(projectId: string, nodeId: string, protectedIds:string[]): Promise<number> { return invoke('library_clear_node_history', { projectId, nodeId,protectedIds }); }
export async function deleteProjectAndAssets(projectId: string, confirmation: string): Promise<void> { await invoke('library_delete_project', { projectId, confirmation }); }
