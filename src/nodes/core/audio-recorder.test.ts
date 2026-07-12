import { describe, expect, it, vi } from "vitest";
import type { ImportedMedia } from "../../persistence/media";
import { AudioRecorderController, type AudioRecorderDependencies } from "./audio-recorder";

class FakeRecorder {
  state: "inactive" | "recording" | "paused" = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: { error?: unknown }) => void) | null = null;
  start = vi.fn(() => { this.state = "recording"; });
  stop = vi.fn(() => { this.state = "inactive"; this.onstop?.(); });
  pause = vi.fn(() => { this.state = "paused"; });
  resume = vi.fn(() => { this.state = "recording"; });
  chunk(value: string) { this.ondataavailable?.({ data: new Blob([value]) }); }
}

const staged = { hash: "a".repeat(64), sizeBytes: 3, mediaType: "audio/webm", createdAt: "now", metadata: { kind: "audio", container: "webm", codecs: ["opus"], durationSeconds: 1, sampleRate: 48_000, channels: 1, playable: true }, stageId: "stage" } satisfies ImportedMedia;
const imported = { ...staged, stageId: undefined, assetId: "asset", resultId: "result" } satisfies ImportedMedia;

function setup(overrides: Partial<AudioRecorderDependencies> = {}) {
  const recorder = new FakeRecorder(); const stopTrack = vi.fn();
  const dependencies: AudioRecorderDependencies = {
    getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })),
    createRecorder: vi.fn(() => recorder), chooseMimeType: () => "audio/webm;codecs=opus",
    begin: vi.fn(async () => "session"), append: vi.fn(async () => 3), finish: vi.fn(async () => staged),
    finalize: vi.fn(async () => imported), abort: vi.fn(async () => true), cancelStage: vi.fn(async () => undefined),
    setInterval: vi.fn(() => 1 as never), clearInterval: vi.fn(), ...overrides,
  };
  return { controller: new AudioRecorderController(dependencies), dependencies, recorder, stopTrack };
}

describe("module-owned audio recorder", () => {
  it("requests permission only on start, streams chunks, stages and finalizes the recording", async () => {
    const { controller, dependencies, recorder, stopTrack } = setup();
    expect(dependencies.getUserMedia).not.toHaveBeenCalled();
    await controller.start("project", "node", 7);
    expect(controller.getSnapshot().status).toBe("recording");
    expect(dependencies.begin).toHaveBeenCalledWith("project", "node", 7, "audio/webm;codecs=opus");
    recorder.chunk("abc");
    const result = await controller.stop("project", "node");
    expect(result).toBe(imported);
    expect(dependencies.append).toHaveBeenCalledOnce();
    expect(dependencies.finish).toHaveBeenCalledWith("session");
    expect(dependencies.finalize).toHaveBeenCalledWith("stage", "project", "node");
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({ status: "idle", seconds: 0 });
  });

  it("pauses capture under IPC backpressure and resumes after the queue drains", async () => {
    const pending: Array<() => void> = [];
    const { controller, recorder } = setup({ append: vi.fn(() => new Promise<number>((resolve) => pending.push(() => resolve(1)))) });
    await controller.start("project", "node", 1);
    for (let index = 0; index < 4; index++) recorder.chunk(String(index));
    await vi.waitFor(() => expect(recorder.pause).toHaveBeenCalledOnce());
    for (let index = 0; index < 4; index++) {
      await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
      pending.shift()?.();
    }
    await vi.waitFor(() => expect(recorder.resume).toHaveBeenCalledOnce());
    await controller.cancel();
  });

  it("discards native sessions and stops tracks on cancel or unmount", async () => {
    const cancelled = setup(); await cancelled.controller.start("project", "node", 1); await cancelled.controller.cancel();
    expect(cancelled.dependencies.abort).toHaveBeenCalledWith("session"); expect(cancelled.stopTrack).toHaveBeenCalledOnce();

    let resolvePermission!: (stream: { getTracks: () => Array<{ stop: () => void }> }) => void;
    const stopLateTrack = vi.fn();
    const late = setup({ getUserMedia: () => new Promise((resolve) => { resolvePermission = resolve; }) });
    const starting = late.controller.start("project", "node", 1); const disposal = late.controller.dispose();
    resolvePermission({ getTracks: () => [{ stop: stopLateTrack }] });
    await Promise.all([starting, disposal]);
    expect(stopLateTrack).toHaveBeenCalledOnce(); expect(late.dependencies.begin).not.toHaveBeenCalled();
  });

  it("cancels a staged file and cleans the session when finishing fails", async () => {
    const failure = setup({ finalize: vi.fn(async () => { throw new Error("decode failed"); }) });
    await failure.controller.start("project", "node", 1);
    await expect(failure.controller.stop("project", "node")).rejects.toThrow("decode failed");
    expect(failure.dependencies.cancelStage).toHaveBeenCalledWith("stage");
    expect(failure.stopTrack).toHaveBeenCalledOnce();
  });

  it("surfaces asynchronous recorder failures after native cleanup", async () => {
    const failure = setup(); await failure.controller.start("project", "node", 1);
    failure.recorder.onerror?.({ error: new Error("device lost") });
    await vi.waitFor(() => expect(failure.controller.getSnapshot()).toMatchObject({ status: "idle", error: "device lost" }));
    expect(failure.dependencies.abort).toHaveBeenCalledWith("session");
    expect(failure.stopTrack).toHaveBeenCalledOnce();
  });
});
