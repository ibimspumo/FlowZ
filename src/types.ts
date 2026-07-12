import type { Edge, Node } from "@xyflow/react";
import type { UpdatePolicy } from "./domain/project";

export type DataType =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "json"
  | "textList"
  | "imageList"
  | "videoList"
  | "audioList"
  | "jsonList"
  | "list";
export type NodeStatus =
  | "idle"
  | "stale"
  | "running"
  | "fresh"
  | "temporary"
  | "error";
export type NodeKind =
  | "textInput"
  | "imageInput"
  | "videoInput"
  | "audioInput"
  | "imageCollection"
  | "videoCollection"
  | "assetText"
  | "assetImage"
  | "textGeneration"
  | "imageGeneration"
  | "imageUpscale"
  | "imageTransform"
  | "imageTrimTransparent"
  | "backgroundRemoval"
  | "videoGeneration"
  | "videoFrame"
  | "imageAnalysis"
  | "transcription"
  | "webpage"
  | "research"
  | "brandBrief"
  | "audienceAnalysis"
  | "brandNames"
  | "domainCheck"
  | "handlePlan"
  | "fontPairing"
  | "colorPalette"
  | "logoDesign"
  | "artboard"
  | "unsupported";

export type MediaMetadata = {
  kind: "video" | "audio";
  container: string;
  codecs: string[];
  durationSeconds: number;
  width?: number;
  height?: number;
  fps?: number;
  sampleRate?: number;
  channels?: number;
  playable: boolean;
  playbackWarning?: string;
};

export type HistoryItem = {
  id: string;
  createdAt: string;
  value: string;
  cost?: number;
  costProvenance?: "actual" | "estimated" | "unknown";
  model?: string;
  prompt?: string;
  parameters?: Record<string, string | number | boolean>;
  assetId?: string;
  blobHash?: string;
  mediaType?: string;
  outputValues?: Record<string, string | undefined>;
  libraryAssetId?: string;
  assetVersionId?: string;
  assetVersion?: number;
  assetName?: string;
  assetKind?: "prompt" | "text" | "image";
  assetSourceProjectId?: string;
  assetSourceNodeId?: string;
  assetSourceResultId?: string;
  persisted?: boolean;
  active?: boolean;
  timestamps?: TranscriptionTimestamps;
  /** Results with the same provider run identity are variants of one run. */
  runId?: string;
  /** Immutable billing identity; may differ from a UI variant group run. */
  costRunId?: string;
};
export type ImageCollectionItem = Pick<
  HistoryItem,
  | "id"
  | "runId"
  | "createdAt"
  | "value"
  | "assetId"
  | "blobHash"
  | "mediaType"
  | "persisted"
>;
export type VideoCollectionItem = ImageCollectionItem & {
  parameters?: Record<string, string | number | boolean>;
};
export type TranscriptionTimestamp = {
  start: number;
  end: number;
  text: string;
};
export type TranscriptionTimestamps = {
  segments: TranscriptionTimestamp[];
  words: TranscriptionTimestamp[];
};

export type FlowNodeData = Record<string, unknown> & {
  kind: NodeKind;
  label: string;
  labelId?: string;
  status: NodeStatus;
  updatePolicy: UpdatePolicy;
  value?: string;
  prompt?: string;
  model?: string;
  aspectRatio?: string;
  resolution?: string;
  duration?: number | "auto";
  generateAudio?: boolean;
  bitrateMode?: "standard" | "high";
  seed?: number;
  endpointConfigs?: Record<
    string,
    {
      duration: number | "auto";
      resolution: string;
      aspectRatio: string;
      generateAudio: boolean;
      bitrateMode: "standard" | "high";
      seed?: number;
    }
  >;
  imageEndpointConfigs?: Record<
    string,
    {
      size: string;
      aspectRatio: string;
      outputFormat: string;
      variants: number;
      seed?: number;
      quality?: string;
      background?: string;
      inputFidelity?: string;
      safetyTolerance?: string;
      thinkingLevel?: string;
      webSearch?: boolean;
      steps?: number;
      guidance?: number;
      acceleration?: string;
      safetyChecker?: boolean;
      streamingEnabled?: boolean;
    }
  >;
  outputFormat?: string;
  upscaleMode?: "factor" | "target";
  factor?: number;
  targetResolution?: "720p" | "1080p" | "1440p" | "2160p";
  noise?: number;
  topazModel?: string;
  faceEnhancement?: boolean;
  subjectDetection?: "All" | "Foreground" | "Background";
  faceEnhancementCreativity?: number;
  faceEnhancementStrength?: number;
  sharpen?: number;
  denoise?: number;
  fixCompression?: number;
  strength?: number;
  creativity?: number;
  texture?: number;
  redefinePrompt?: string;
  autoprompt?: boolean;
  detail?: number;
  enhancementStrength?: "low" | "medium" | "high";
  premiumConfirmed?: boolean;
  cropToFill?: boolean;
  transformMode?: "fit" | "fill" | "free";
  transformAspect?:
    | "original"
    | "1:1"
    | "16:9"
    | "9:16"
    | "4:3"
    | "3:4"
    | "custom";
  targetWidth?: number;
  targetHeight?: number;
  dimensionLock?: boolean;
  noUpscale?: boolean;
  transformQuality?: number;
  transformBackground?: string;
  cropX?: number;
  cropY?: number;
  cropWidth?: number;
  cropHeight?: number;
  trimThreshold?: number;
  trimPadding?: number;
  variants?: number;
  /** Number of sibling results produced by one deliberate generation action. */
  variantCount?: number;
  /** Only meaningful and shown while a typed list input is connected. */
  listProcessingMode?: "map" | "aggregate";
  quality?: string;
  background?: string;
  inputFidelity?: string;
  safetyTolerance?: string;
  thinkingLevel?: string;
  webSearch?: boolean;
  steps?: number;
  guidance?: number;
  acceleration?: string;
  safetyChecker?: boolean;
  frameMode?: "first" | "last" | "seconds" | "percent";
  frameValue?: number;
  outputMode?: "free" | "single";
  language?: string;
  timestamps?: boolean;
  cost?: number;
  costProvenance?: "actual" | "estimated" | "unknown";
  error?: string;
  fileName?: string;
  history?: HistoryItem[];
  unsupportedModuleId?: string;
  persisted?: boolean;
  assetId?: string;
  url?: string;
  includeScreenshot?: boolean;
  query?: string;
  resultCount?: number;
  freshness?: "all" | "day" | "week" | "month" | "year";
  brandName?: string;
  offer?: string;
  audience?: string;
  problem?: string;
  promise?: string;
  personality?: string;
  differentiators?: string;
  constraints?: string;
  candidateCount?: number;
  iteration?: number;
  tlds?: string[];
  privacyConsent?: boolean;
  /** Optional direct domain candidate. When set it visibly overrides a connected naming artifact. */
  domainName?: string;
  handle?: string;
  fontPresetSeed?: number;
  fontMood?: string;
  fontSpecimenText?: string;
  fontSpecimenExpanded?: boolean;
  headingFont?: string;
  headingFontVariant?: number;
  headingFontAxes?: Record<string, number>;
  headingFontBlobHash?: string;
  headingFontLicenseBlobHash?: string;
  headingFontStyle?: string;
  headingFontWeight?: number;
  headingFontLicense?: string;
  headingFontSubsets?: string[];
  bodyFont?: string;
  bodyFontVariant?: number;
  bodyFontAxes?: Record<string, number>;
  bodyFontBlobHash?: string;
  bodyFontLicenseBlobHash?: string;
  bodyFontStyle?: string;
  bodyFontWeight?: number;
  bodyFontLicense?: string;
  bodyFontSubsets?: string[];
  paletteDirection?: string;
  selectedNameId?: string;
  /** First-class Artboard document linked from this flow node. */
  artboardWorkspaceId?: string;
  artboardWorkspaceName?: string;
  artboardRevisionId?: string;
  artboardRevisionNumber?: number;
  artboardInputSnapshotId?: string;
  artboardLinkedInputSignature?: string;
  /** Canonical renderer output supplied by the Artboard workspace shell. */
  artboardPreviewSvg?: string;
  artboardActiveImageHash?: string;
  artboardSelectedImageHashes?: string[];
  exportFolderGrant?: string;
  exportFolderLabel?: string;
  exportNameTemplate?: string;
  exportOverwrite?: "rename" | "replace" | "error";
  exportedFiles?: string[];
  outputValues?: Record<string, string | string[] | undefined>;
  /** Runtime-only materialization. Durable collection nodes store result IDs only. */
  collectionItems?: ImageCollectionItem[];
  /** Runtime-only video materialization. Durable collection nodes store result IDs only. */
  videoCollectionItems?: VideoCollectionItem[];
  collectionResultIds?: string[];
  /** Result IDs deliberately exposed as individual image sockets. */
  fanOutResultIds?: string[];
  libraryAssetId?: string;
  assetVersionId?: string;
  assetVersion?: number;
  assetName?: string;
  assetKind?: "prompt" | "text" | "image";
  assetSourceProjectId?: string;
  assetSourceNodeId?: string;
  assetSourceResultId?: string;
  blobHash?: string;
  posterHash?: string;
  startFrameHash?: string;
  endFrameHash?: string;
  mediaType?: string;
  mediaMetadata?: MediaMetadata;
};

export type FlowNode = Node<FlowNodeData>;
export type FlowEdge = Edge<{ dataType: DataType; order?: number }>;

export type NodeDefinition = {
  kind: NodeKind;
  label: string;
  description: string;
  category: "Eingabe" | "Kontext" | "Marke" | "Modell" | "System";
  inputs: {
    id: string;
    label: string;
    type: DataType;
    optional?: boolean;
    multiple?: boolean;
  }[];
  outputs: { id: string; label: string; type: DataType }[];
  defaults: Partial<FlowNodeData>;
  hidden?: boolean;
};

export type AiImageResult = {
  dataUrl: string;
  resultId?: string;
  assetId?: string;
  persisted: boolean;
};
export type AiResult = {
  content?: string;
  images: string[];
  imageResults?: AiImageResult[];
  costMicrounits?: number;
  generationId?: string;
  assetId?: string;
  resultId?: string;
  persistenceError?: string;
};
export type CapabilityDescriptor =
  | { type: "enum"; values: string[] }
  | { type: "range"; min: number; max: number }
  | { type: "boolean" };
export type ModelOption = {
  id: string;
  name: string;
  supportedParameters: string[];
  parameterDescriptors: Record<string, CapabilityDescriptor>;
  supportsStreaming: boolean;
  endpoints?: string;
  supportsTimestamps?: boolean;
  timestampReason?: string;
  inputModalities?: string[];
  outputModalities?: string[];
};
