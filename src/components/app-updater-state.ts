export class OperationGate {
  private generation = 0;
  private alive = true;

  begin(): number { return ++this.generation; }
  isCurrent(token: number): boolean { return this.alive && token === this.generation; }
  invalidate(): void { this.generation += 1; }
  dispose(): void { this.alive = false; this.invalidate(); }
}

export type DownloadProgress = Readonly<{ downloaded: number; total?: number }>;

export const UPDATER_ERROR_ALERT_PROPS = Object.freeze({
  role: 'alert' as const,
  'aria-live': 'assertive' as const,
  'aria-atomic': true,
});

export function startDownload(total?: number): DownloadProgress {
  return { downloaded: 0, ...(total && total > 0 ? { total } : {}) };
}

export function advanceDownload(progress: DownloadProgress, chunkLength: number): DownloadProgress {
  if (!Number.isFinite(chunkLength) || chunkLength < 0) return progress;
  const downloaded = progress.downloaded + chunkLength;
  return { ...progress, downloaded: progress.total ? Math.min(downloaded, progress.total) : downloaded };
}

export function finishDownload(progress: DownloadProgress): DownloadProgress {
  return progress.total ? { ...progress, downloaded: progress.total } : progress;
}

export function updaterErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export async function attemptUpdaterAction(action: () => Promise<void>): Promise<string | undefined> {
  try { await action(); return undefined; }
  catch (cause) { return updaterErrorMessage(cause); }
}
