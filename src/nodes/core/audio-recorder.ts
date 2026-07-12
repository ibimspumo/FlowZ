import type { ImportedMedia } from "../../persistence/media";

export type AudioRecorderStatus = "idle" | "requesting" | "recording" | "finishing";
export type AudioRecorderSnapshot = { status: AudioRecorderStatus; seconds: number; error?: string };

type RecorderLike = {
  state: "inactive" | "recording" | "paused";
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((event: { error?: unknown }) => void) | null;
  start(timeslice?: number): void;
  stop(): void;
  pause(): void;
  resume(): void;
};

type StreamLike = { getTracks(): Array<{ stop(): void }> };

export type AudioRecorderDependencies = {
  getUserMedia: () => Promise<StreamLike>;
  createRecorder: (stream: StreamLike, mimeType: string) => RecorderLike;
  chooseMimeType: () => string;
  begin: (projectId: string, nodeId: string, revision: number, mimeType: string) => Promise<string>;
  append: (sessionId: string, bytes: ArrayBuffer) => Promise<number>;
  finish: (sessionId: string) => Promise<ImportedMedia>;
  finalize: (stageId: string, projectId: string, nodeId: string) => Promise<ImportedMedia>;
  abort: (sessionId: string) => Promise<boolean>;
  cancelStage: (stageId: string) => Promise<void>;
  now?: () => number;
  setInterval?: (callback: () => void, delay: number) => TimerHandle;
  clearInterval?: (timer: TimerHandle) => void;
};

type TimerHandle = ReturnType<typeof globalThis.setInterval> | number;

const MAX_PENDING_CHUNKS = 4;
const RESUME_PENDING_CHUNKS = 1;

export class AudioRecorderController {
  private snapshot: AudioRecorderSnapshot = { status: "idle", seconds: 0 };
  private listeners = new Set<() => void>();
  private recorder?: RecorderLike;
  private stream?: StreamLike;
  private sessionId?: string;
  private stageId?: string;
  private queue = Promise.resolve();
  private queueError?: unknown;
  private pendingChunks = 0;
  private startedAt = 0;
  private timer?: TimerHandle;
  private stopPromise?: Promise<void>;
  private resolveStop?: () => void;
  private disposed = false;
  private operation = 0;

  constructor(private readonly dependencies: AudioRecorderDependencies) {}

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = () => this.snapshot;

  private emit(patch: Partial<AudioRecorderSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  async start(projectId: string, nodeId: string, revision: number) {
    if (this.snapshot.status !== "idle" || this.disposed) return;
    const operation = ++this.operation;
    this.emit({ status: "requesting", seconds: 0, error: undefined });
    try {
      const stream = await this.dependencies.getUserMedia();
      if (this.disposed || operation !== this.operation) { stream.getTracks().forEach((track) => track.stop()); return; }
      this.stream = stream;
      const mimeType = this.dependencies.chooseMimeType();
      if (!mimeType) throw new Error("NO_SUPPORTED_AUDIO_RECORDER");
      this.sessionId = await this.dependencies.begin(projectId, nodeId, revision, mimeType);
      if (this.disposed || operation !== this.operation) { await this.cancel(); return; }
      const recorder = this.dependencies.createRecorder(stream, mimeType);
      this.recorder = recorder;
      this.queue = Promise.resolve(); this.queueError = undefined; this.pendingChunks = 0;
      this.stopPromise = new Promise<void>((resolve) => { this.resolveStop = resolve; });
      recorder.ondataavailable = (event) => this.enqueue(event.data);
      recorder.onstop = () => { this.resolveStop?.(); this.resolveStop = undefined; };
      recorder.onerror = (event) => { const error = event.error ?? new Error("AUDIO_RECORDER_FAILED"); this.queueError = error; void this.fail(error); };
      recorder.start(1_000);
      this.startedAt = (this.dependencies.now ?? Date.now)();
      const setTimer = this.dependencies.setInterval ?? globalThis.setInterval;
      this.timer = setTimer(() => this.emit({ seconds: Math.max(0, ((this.dependencies.now ?? Date.now)() - this.startedAt) / 1_000) }), 250);
      this.emit({ status: "recording", seconds: 0 });
    } catch (error) {
      await this.cleanup(true);
      if (!this.disposed && operation === this.operation) this.emit({ status: "idle", seconds: 0 });
      throw error;
    }
  }

  private enqueue(blob: Blob) {
    if (!blob.size || !this.sessionId || this.disposed) return;
    const sessionId = this.sessionId;
    this.pendingChunks += 1;
    if (this.pendingChunks >= MAX_PENDING_CHUNKS && this.recorder?.state === "recording") this.recorder.pause();
    this.queue = this.queue
      .then(async () => { const bytes = await blob.arrayBuffer(); await this.dependencies.append(sessionId, bytes); })
      .catch((error) => { this.queueError = error; })
      .finally(() => {
        this.pendingChunks = Math.max(0, this.pendingChunks - 1);
        if (this.pendingChunks <= RESUME_PENDING_CHUNKS && this.recorder?.state === "paused") this.recorder.resume();
      });
  }

  async stop(projectId: string, nodeId: string): Promise<ImportedMedia> {
    if (this.snapshot.status !== "recording" || !this.recorder || !this.sessionId) throw new Error("AUDIO_RECORDER_NOT_RUNNING");
    const operation = this.operation;
    this.emit({ status: "finishing" });
    this.stopTimer();
    try {
      if (this.recorder.state !== "inactive") this.recorder.stop();
      await this.stopPromise;
      await this.queue;
      if (this.queueError) throw this.queueError;
      if (this.disposed || operation !== this.operation) throw new DOMException("Aborted", "AbortError");
      const sessionId = this.sessionId;
      const staged = await this.dependencies.finish(sessionId);
      this.sessionId = undefined;
      if (!staged.stageId) throw new Error("AUDIO_RECORDING_STAGE_MISSING");
      this.stageId = staged.stageId;
      const imported = await this.dependencies.finalize(staged.stageId, projectId, nodeId);
      this.stageId = undefined;
      await this.cleanup(false);
      if (!this.disposed && operation === this.operation) this.emit({ status: "idle", seconds: 0 });
      return imported;
    } catch (error) {
      await this.cleanup(true);
      if (!this.disposed && operation === this.operation) this.emit({ status: "idle", seconds: 0 });
      throw error;
    }
  }

  async cancel() {
    ++this.operation;
    await this.cleanup(true);
    if (!this.disposed) this.emit({ status: "idle", seconds: 0, error: undefined });
  }

  async dispose() {
    this.disposed = true;
    ++this.operation;
    await this.cleanup(true);
    this.listeners.clear();
  }

  private async fail(error: unknown) {
    ++this.operation;
    await this.cleanup(true);
    if (!this.disposed) this.emit({ status: "idle", seconds: 0, error: error instanceof Error ? error.message : String(error) });
  }

  private stopTimer() {
    if (this.timer !== undefined) (this.dependencies.clearInterval ?? globalThis.clearInterval)(this.timer);
    this.timer = undefined;
  }

  private async cleanup(abortNative: boolean) {
    this.stopTimer();
    const recorder = this.recorder;
    this.recorder = undefined;
    if (recorder && recorder.state !== "inactive") {
      try { recorder.stop(); } catch { /* Already stopped by the platform. */ }
    }
    this.resolveStop?.(); this.resolveStop = undefined;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    if (abortNative && this.sessionId) await this.dependencies.abort(this.sessionId).catch(() => false);
    this.sessionId = undefined;
    if (this.stageId) await this.dependencies.cancelStage(this.stageId).catch(() => undefined);
    this.stageId = undefined;
    this.queue = Promise.resolve(); this.queueError = undefined; this.pendingChunks = 0;
  }
}

export function chooseBrowserAudioMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  return ["audio/webm;codecs=opus", "audio/mp4"].find((value) => MediaRecorder.isTypeSupported(value)) ?? "";
}
