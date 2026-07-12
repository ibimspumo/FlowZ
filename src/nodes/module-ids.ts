import type { NodeKind } from "../types";

/** Canonical durable identity table; dependency-free so migrations can use it safely. */
export const MODULE_ID_BY_KIND = {
  textInput: "core.text-input", imageInput: "core.image-input", videoInput: "core.video-input", audioInput: "core.audio-input",
  imageCollection: "core.image-collection", videoCollection: "core.video-collection", assetText: "library.asset-text", assetImage: "library.asset-image",
  textGeneration: "ai.text-generation", imageGeneration: "ai.image-generation", imageUpscale: "image.upscale", imageTransform: "image.transform",
  imageTrimTransparent: "image.trim-transparent", backgroundRemoval: "image.background-removal", videoGeneration: "ai.video-generation",
  videoFrame: "media.video-frame", imageAnalysis: "ai.image-analysis", transcription: "ai.transcription",
  webpage: "context.webpage", research: "context.research", brandBrief: "brand.brief",
  audienceAnalysis: "brand.audience", brandNames: "brand.names", domainCheck: "brand.domains", handlePlan: "brand.handles",
  fontPairing: "brand.font-pairing", colorPalette: "brand.color-palette", logoDesign: "brand.logo-design", artboard: "brand.artboard",
} as const satisfies Record<Exclude<NodeKind, "unsupported">, string>;

export function persistedModuleIdForKind(kind: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(MODULE_ID_BY_KIND, kind)
    ? MODULE_ID_BY_KIND[kind as keyof typeof MODULE_ID_BY_KIND]
    : undefined;
}
