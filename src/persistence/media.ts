import { invoke } from '@tauri-apps/api/core';
import { isDesktopRuntime } from './projects';
import type { MediaMetadata } from '../types';

export type ImportedMedia = {
  hash: string; sizeBytes: number; mediaType: string; originalName?: string; createdAt: string;
  metadata: MediaMetadata; posterHash?: string;
  startFrameHash?: string; endFrameHash?: string;
  resultId?: string; assetId?: string;
  stageId?: string;
};
export type PendingMediaStage = { stageId: string; projectId: string; nodeId: string; kind: 'audio' | 'video'; origin: 'recording' | 'file' | 'drop'; originalName?: string; createdAt: string };

const locallyCancelledImports = new Set<string>();

export function isMediaImportCancellationRequested(operationId: string): boolean {
  return locallyCancelledImports.has(operationId);
}

export function clearMediaImportCancellation(operationId: string): void {
  locallyCancelledImports.delete(operationId);
}

export function mediaUrl(hash: string): string {
  if (!/^[a-f0-9]{64}$/i.test(hash)) throw new Error('Ungültige Medien-ID.');
  return `flowz-media://localhost/${hash.toLowerCase()}`;
}

export async function pickMediaStage(kind: 'video' | 'audio', projectId: string, nodeId: string, projectRevision: number, operationId: string): Promise<ImportedMedia> {
  if (!isDesktopRuntime()) throw new Error('Medienimporte sind nur in der Desktop-App verfügbar.');
  return invoke<ImportedMedia>('media_pick_stage', { kind, projectId, nodeId, projectRevision, operationId });
}

export async function stageDroppedMedia(token: string, kind: 'video' | 'audio', projectId: string, nodeId: string, projectRevision: number, operationId: string): Promise<ImportedMedia> {
  if (!isDesktopRuntime()) throw new Error('Medienimporte sind nur in der Desktop-App verfügbar.');
  return invoke<ImportedMedia>('media_drop_stage', { token, kind, projectId, nodeId, projectRevision, operationId });
}

export async function finalizeMediaStage(stageId: string, kind: 'video' | 'audio', projectId: string, nodeId: string): Promise<ImportedMedia> {
  return invoke<ImportedMedia>('media_finalize_stage', { stageId, kind, projectId, nodeId });
}

export async function cancelMediaStage(stageId: string): Promise<void> {
  await invoke('media_cancel_stage', { stageId });
}

export async function pendingMediaStages(projectId: string, nodeId: string): Promise<PendingMediaStage[]> {
  if (!isDesktopRuntime()) return [];
  return invoke<PendingMediaStage[]>('media_pending_stages', { projectId, nodeId });
}

export async function cancelMediaImport(operationId: string): Promise<boolean> {
  locallyCancelledImports.add(operationId);
  return invoke<boolean>('media_cancel_import', { operationId });
}

export async function beginRecordingSession(projectId: string, nodeId: string, projectRevision: number, mimeType: string): Promise<string> {
  if (!isDesktopRuntime()) throw new Error('Mikrofonaufnahmen sind nur in der Desktop-App verfügbar.');
  return invoke<string>('recording_begin', { projectId, nodeId, projectRevision, mimeType });
}

export async function appendRecordingChunk(sessionId: string, chunk: ArrayBuffer): Promise<number> {
  if (!isDesktopRuntime()) throw new Error('Mikrofonaufnahmen sind nur in der Desktop-App verfügbar.');
  return invoke<number>('recording_append', chunk, { headers: { 'x-flowz-recording-session': sessionId } });
}

export async function finishRecordingSession(sessionId: string): Promise<ImportedMedia> {
  if (!isDesktopRuntime()) throw new Error('Mikrofonaufnahmen sind nur in der Desktop-App verfügbar.');
  return invoke<ImportedMedia>('recording_finish', { sessionId });
}

export async function abortRecordingSession(sessionId: string): Promise<boolean> {
  if (!isDesktopRuntime()) return false;
  return invoke<boolean>('recording_abort', { sessionId });
}

export function mediaDisplay(item: ImportedMedia) {
  return {
    blobHash: item.hash, mediaType: item.mediaType, mediaMetadata: item.metadata,
    ...(item.originalName ? { fileName: item.originalName } : {}),
    ...(item.posterHash ? { posterHash: item.posterHash } : {}),
    ...(item.startFrameHash ? { startFrameHash: item.startFrameHash } : {}),
    ...(item.endFrameHash ? { endFrameHash: item.endFrameHash } : {}),
    ...(item.metadata.kind === 'video' ? { outputValues: { video: `flowz-cas:${item.hash}`, ...(item.startFrameHash ? { startFrame: `flowz-cas:${item.startFrameHash}` } : {}), ...(item.endFrameHash ? { endFrame: `flowz-cas:${item.endFrameHash}` } : {}) } } : {}),
  };
}

export function mediaHistoryParameters(item: ImportedMedia): Record<string, string | number | boolean> {
  const metadata = item.metadata;
  const parameters: Record<string, string | number | boolean> = {
    durationSeconds: metadata.durationSeconds, container: metadata.container, codecs: metadata.codecs.join(' + '), playable: metadata.playable,
  };
  for (const [key, value] of Object.entries({ width: metadata.width, height: metadata.height, fps: metadata.fps, sampleRate: metadata.sampleRate, channels: metadata.channels })) {
    if (value !== undefined) parameters[key] = value;
  }
  if (item.posterHash) parameters.posterHash = item.posterHash;
  if (item.startFrameHash) parameters.startFrameHash = item.startFrameHash;
  if (item.endFrameHash) parameters.endFrameHash = item.endFrameHash;
  if (item.originalName) parameters.fileName = item.originalName;
  if (metadata.playbackWarning) parameters.playbackWarning = metadata.playbackWarning;
  return parameters;
}
