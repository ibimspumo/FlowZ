import { invoke } from '@tauri-apps/api/core';
import { isDesktopRuntime } from './projects';

export type AssetKind = 'prompt' | 'text' | 'image';
export type LibraryAssetSummary = {
  assetId: string;
  versionId: string;
  version: number;
  name: string;
  kind: AssetKind;
  previewText?: string;
  mediaType?: string;
  createdAt: string;
  sourceProjectId?: string;
  sourceNodeId?: string;
  sourceResultId?: string;
};
export type LibraryAssetPage = { items: LibraryAssetSummary[]; total: number; page: number; pageSize: number };
export type LibraryAssetPayload = LibraryAssetSummary & { text?: string; dataUrl?: string; blobHash?: string };
export type SaveLibraryAssetRequest = {
  name: string;
  kind: AssetKind;
  text?: string;
  dataUrl?: string;
  originalName?: string;
  sourceProjectId?: string;
  sourceNodeId?: string;
  sourceResultId?: string;
};

export async function saveLibraryAsset(request: SaveLibraryAssetRequest): Promise<LibraryAssetSummary> {
  if (!isDesktopRuntime()) throw new Error('Globale Assets sind nur in der Desktop-App persistent.');
  return invoke('library_asset_save', { request });
}

export async function searchLibraryAssets(query = '', kind?: AssetKind, page = 0, pageSize = 30): Promise<LibraryAssetPage> {
  if (!isDesktopRuntime()) return { items: [], total: 0, page, pageSize };
  return invoke('library_asset_search', { query, kind, page, pageSize });
}

export async function getLibraryAssetContent(versionId: string): Promise<LibraryAssetPayload> {
  if (!isDesktopRuntime()) throw new Error('Globale Assets sind nur in der Desktop-App verfügbar.');
  return invoke('library_asset_content', { versionId });
}

export async function getLibraryAssetReference(versionId: string): Promise<{versionId:string;blobHash?:string;mediaType?:string}> {
  if (!isDesktopRuntime()) throw new Error('Globale Assets sind nur in der Desktop-App verfügbar.');
  return invoke('library_asset_reference', { versionId });
}

export async function getLibraryAssetThumbnail(versionId: string): Promise<string | undefined> {
  if (!isDesktopRuntime()) return;
  return (await invoke<string | null>('library_asset_thumbnail', { versionId })) ?? undefined;
}

export async function getLibraryAssetContents(versionIds: string[]): Promise<LibraryAssetPayload[]> {
  if (!isDesktopRuntime() || !versionIds.length) return [];
  return invoke('library_asset_contents', { versionIds });
}
