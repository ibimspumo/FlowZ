import {
  cancelFalImage,
  cancelFalImageTool,
  cancelFalRun,
  runFalImage,
  runFalImageTool,
  runFalVideo,
} from "../api";
import type { NodeExecutionServices } from "../engine/node-module";
import { currentExecutionFingerprint } from "../store";

/** Desktop implementation of the provider-neutral Fal service boundary. The
 * Rust commands own uploads, credentials, paid-run journals, resume and CAS. */
export function createFalExecutionServices(
  projectId: string,
): NonNullable<NodeExecutionServices["fal"]> {
  const fingerprint = async (nodeId: string) => ({
    execution: currentExecutionFingerprint(nodeId) ?? "",
  });
  return {
    image: async (request) => {
      const cancel = () => {
        void cancelFalImage(request.runId).catch(() => false);
      };
      request.signal.addEventListener("abort", cancel, { once: true });
      try {
        request.signal.throwIfAborted();
        const result = await runFalImage({
          runId: request.runId,
          projectId,
          nodeId: request.nodeId,
          modelId: request.modelId,
          endpoint: request.endpoint,
          schemaHash: request.schemaHash,
          prompt: request.prompt,
          references: request.references,
          mask: request.mask,
          config: request.config,
          costEstimate: request.costEstimate,
          costContext: request.costContext,
          inputFingerprint: await fingerprint(request.nodeId),
          streaming: request.streaming,
        });
        request.signal.throwIfAborted();
        return result;
      } finally {
        request.signal.removeEventListener("abort", cancel);
      }
    },
    imageTool: async (request) => {
      const cancel = () => {
        void cancelFalImageTool(request.runId).catch(() => false);
      };
      request.signal.addEventListener("abort", cancel, { once: true });
      try {
        request.signal.throwIfAborted();
        const result = await runFalImageTool({
          runId: request.runId,
          projectId,
          nodeId: request.nodeId,
          endpoint: request.endpoint,
          schemaHash: request.schemaHash,
          source: request.source,
          config: request.config,
          estimatedCostMicrounits: request.estimatedCostMicrounits,
          inputFingerprint: await fingerprint(request.nodeId),
        });
        request.signal.throwIfAborted();
        return result;
      } finally {
        request.signal.removeEventListener("abort", cancel);
      }
    },
    video: async (request) => {
      const cancel = () => {
        void cancelFalRun(request.runId).catch(() => false);
      };
      request.signal.addEventListener("abort", cancel, { once: true });
      try {
        request.signal.throwIfAborted();
        const result = await runFalVideo({
          runId: request.runId,
          projectId,
          nodeId: request.nodeId,
          endpoint: request.endpoint,
          schemaHash: request.schemaHash,
          prompt: request.prompt,
          duration: request.duration,
          resolution: request.resolution,
          aspectRatio: request.aspectRatio,
          generateAudio: request.generateAudio,
          bitrateMode: request.bitrateMode,
          seed: request.seed,
          startFrame: request.startFrame,
          endFrame: request.endFrame,
          references: request.references,
          estimatedCostMicrounits: request.estimatedCostMicrounits,
          costEstimate: request.costEstimate,
          costContext: request.costContext,
          inputFingerprint: await fingerprint(request.nodeId),
        });
        request.signal.throwIfAborted();
        return result;
      } finally {
        request.signal.removeEventListener("abort", cancel);
      }
    },
  };
}
