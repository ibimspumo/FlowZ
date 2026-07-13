import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  AlertCircle,
  Check,
  CircleDot,
  LoaderCircle,
  LockKeyhole,
  Mic,
  Play,
  Square,
  Trash2,
  Upload,
} from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { JsonValue } from "../domain/project";
import type { NodeViewProps } from "../engine/node-module";
import { registerNodeExecution } from "../engine/node-execution-bridge";
import { canonicalNodeRegistry } from ".";
import { dispatchAppNodeExecution } from "./dispatch";
import { nodeSpecifications } from "./module-specifications";
import {
  currentExecutionFingerprint as optionalExecutionFingerprint,
  useFlowStore,
} from "../store";
import type { FlowNode, FlowNodeData, NodeKind } from "../types";
import { NodeShell } from "../components/NodeShell";
import { CustomSelect } from "../components/CustomSelect";
import { MediaPreview } from "../components/MediaPreview";
import { DeferredMarkdown } from "../components/DeferredMarkdown";
import { DirectImageSource } from "../components/DirectImageSource";
import { NodeHistoryLauncher } from "../components/NodeHistoryLauncher";
import { NodeCostSummary } from "../components/NodeCostSummary";
import { NodePolicyControl } from "../components/NodePolicyControl";
import { VariantOutputSockets, variantOutputItems } from "../components/VariantOutputSockets";
import { ListProcessingControl } from "../components/ListProcessingControl";
import { nodePortRailRowCount, nodePortRailStyle, nodePortSocketStyle } from "../components/node-port-layout";
import {
  mediaUrl,
  cancelMediaImport,
  cancelMediaStage,
  clearMediaImportCancellation,
  finalizeMediaStage,
  isMediaImportCancellationRequested,
  mediaDisplay,
  mediaHistoryParameters,
  pickMediaStage,
  beginRecordingSession,
  appendRecordingChunk,
  finishRecordingSession,
  abortRecordingSession,
} from "../persistence/media";
import { isDesktopRuntime } from "../persistence/projects";
import { storeLibraryResult } from "../persistence/library";
import {
  extractVideoFrame,
  fetchWebpage,
  runWebResearch,
  transformImage,
  trimTransparentImage,
} from "../api";
import { executeListProcessing } from "../engine/list-execution";
import { connectedInputEdgeCount, connectedInputPortIds, directMediaBindingFromConfig, resolveDirectMediaInputs } from "./direct-media";
import {
  appErrorMessage,
  formatNumber,
  formatDuration,
  localizeErrorMessage,
  useI18n,
  type TranslationKey,
} from "../i18n";
import {
  localizedCanonicalNodeLabel,
  localizedNodeDescription,
  localizedPortLabel,
} from "../i18n-schema";
import { AudioRecorderController, chooseBrowserAudioMimeType, type AudioRecorderDependencies } from "./core/audio-recorder";
import { KeyboardPortAction } from "../components/KeyboardPortAction";
import { currentExecutionSnapshot } from "./execution-snapshot";

type RuntimeProps = NodeProps<FlowNode>;
const socketColors: Record<string, string> = {
  text: "#39a9ff",
  image: "#ef3c99",
  video: "#a67cff",
  audio: "#ff9f43",
  json: "#29d3c2",
  textList: "#39a9ff",
  imageList: "#ef3c99",
  videoList: "#a67cff",
  audioList: "#ff9f43",
  jsonList: "#29d3c2",
  list: "#29d3c2",
};
const currentExecutionFingerprint = (nodeId: string) =>
  optionalExecutionFingerprint(nodeId) ?? "";
export function moduleRuntimeProps(
  props: NodeViewProps<Record<string, JsonValue>>,
  expected: NodeKind,
): RuntimeProps {
  const value = props.runtimeProps as Partial<RuntimeProps> | undefined;
  if (
    !value ||
    typeof value.id !== "string" ||
    !value.data ||
    value.data.kind !== expected
  )
    throw new Error(`Runtime view mismatch for ${expected}.`);
  return value as RuntimeProps;
}

const runtime = moduleRuntimeProps;

function Ports({ node }: { node: RuntimeProps }) {
  useI18n();
  const definition = nodeSpecifications[node.data.kind];
  const edges = useFlowStore((state) => state.edges);
  const outputs = definition.outputs.filter((port) => {
    if (!port.type.endsWith("List") && port.type !== "list") return true;
    const materialized = node.data.outputValues?.[port.id];
    return (Array.isArray(materialized) && materialized.length > 1)
      || edges.some((edge) => edge.source === node.id && edge.sourceHandle?.split("::")[0] === port.id)
      || node.data.kind === "imageCollection" || node.data.kind === "videoCollection";
  });
  const variants = variantOutputItems(node.data);
  const rowCount = nodePortRailRowCount(
    definition.inputs.length,
    outputs.length,
    variants.map((item) => item.index),
  );
  return (
    <div className="node-port-space" style={nodePortRailStyle(rowCount)}>
      {definition.inputs.map((port, index) => (
        <div
          key={`i:${port.id}`}
          className="socket socket-in"
          style={nodePortSocketStyle(index)}
        >
          <Handle
            type="target"
            position={Position.Left}
            id={port.id}
            style={{ background: socketColors[port.type] }}
          />
          <KeyboardPortAction nodeId={node.id} nodeKind={node.data.kind} portId={port.id} portLabel={port.label} dataType={port.type} direction="input" />
          <span>{localizedPortLabel(port.id, port.type, port.label)}</span>
        </div>
      ))}
      {outputs.map((port, index) => (
        <div
          key={`o:${port.id}`}
          className="socket socket-out"
          style={nodePortSocketStyle(index)}
        >
          <span>{localizedPortLabel(port.id, port.type, port.label)}</span>
          <KeyboardPortAction nodeId={node.id} nodeKind={node.data.kind} portId={port.id} portLabel={port.label} dataType={port.type} direction="output" />
          <Handle
            type="source"
            position={Position.Right}
            id={port.id}
            style={{ background: socketColors[port.type] }}
          />
        </div>
      ))}
      <VariantOutputSockets nodeId={node.id} kind={node.data.kind} data={node.data} offset={outputs.length} colors={socketColors} />
    </div>
  );
}

export function ModuleNodeFrame({
  node,
  selected,
  children,
}: {
  node: RuntimeProps;
  selected: boolean;
  children: ReactNode;
}) {
  const remove = useFlowStore((state) => state.deleteNode);
  const { t } = useI18n();
  const definition = nodeSpecifications[node.data.kind];
  const statusKey = (
    {
      idle: "node.status.ready",
      stale: "node.status.stale",
      running: "node.status.running",
      fresh: "node.status.fresh",
      temporary: "node.status.stale",
      error: "node.status.error",
    } as const
  )[node.data.status] as TranslationKey;
  const Status =
    node.data.status === "running"
      ? LoaderCircle
      : node.data.status === "fresh"
        ? Check
        : CircleDot;
  return (
    <NodeShell
      selected={selected}
      status={node.data.status}
      slots={{
        ports: <Ports node={node} />,
        header: (
          <header className="node-header">
            <div className="node-heading">
              <strong>
                {localizedCanonicalNodeLabel(
                  node.data.labelId,
                  node.data.kind,
                  node.data.label,
                )}
              </strong>
              <span>
                {localizedNodeDescription(
                  node.data.kind,
                  definition.description,
                )}
              </span>
            </div>
            <NodePolicyControl nodeId={node.id} kind={node.data.kind} value={node.data.updatePolicy} />
            <button
              type="button"
              className="icon-button"
              onClick={() => remove(node.id)}
              aria-label={t("common.delete")}
            >
              <Trash2 size={15} />
            </button>
          </header>
        ),
        body: (
          <div
            className="node-content nodrag nowheel nopan"
            onWheel={(event) => event.stopPropagation()}
          >
            <ListProcessingControl nodeId={node.id} data={node.data} />
            {children}
            <NodeHistoryLauncher nodeId={node.id} data={node.data}/>
            {node.data.error ? (
              <div className="node-error" role="alert">
                <AlertCircle size={14} />
                <span>{localizeErrorMessage(node.data.error)}</span>
              </div>
            ) : null}
          </div>
        ),
        footer: (
          <footer className="node-footer">
            <span role="status" aria-live="polite" aria-atomic="true">
              <Status
                className={node.data.status === "running" ? "spin" : undefined}
                size={13}
              />
              {t(statusKey)}
            </span>
            <NodeCostSummary data={node.data} />
          </footer>
        ),
      }}
    />
  );
}

const Frame = ModuleNodeFrame;

export function useModuleNodeUpdate(node: RuntimeProps) {
  const update = useFlowStore((state) => state.updateNode);
  return (patch: Partial<FlowNodeData>, propagate = true) =>
    update(node.id, patch, propagate);
}
const useUpdate = useModuleNodeUpdate;

export function TextInputBody(props: NodeViewProps<Record<string, JsonValue>>) {
  const node = runtime(props, "textInput");
  const update = useUpdate(node);
  const { t } = useI18n();
  return (
    <Frame node={node} selected={props.selected}>
      <textarea
        aria-label={t("node.output")}
        value={String(node.data.value ?? "")}
        onChange={(event) =>
          update({
            value: event.currentTarget.value,
            outputValues: { text: event.currentTarget.value },
            status: "fresh",
            persisted: true,
          })
        }
        placeholder={t("node.inputTextPlaceholder")}
      />
    </Frame>
  );
}

export function ImageCollectionBody(
  props: NodeViewProps<Record<string, JsonValue>>,
) {
  const node = runtime(props, "imageCollection");
  const items = node.data.collectionItems ?? [];
  const { t } = useI18n();
  return (
    <Frame node={node} selected={props.selected}>
      <div className="curated-source">
        <div className="curated-strip">
          {items.map((item, index) => (
            <img
              key={item.id}
              src={item.value}
              alt={`${t("node.output")} ${index + 1}`}
            />
          ))}
        </div>
        <div className="structured-note">
          <LockKeyhole size={11} />
          {t("node.immutableImages", { count: items.length })}
        </div>
      </div>
    </Frame>
  );
}
export function VideoCollectionBody(
  props: NodeViewProps<Record<string, JsonValue>>,
) {
  const node = runtime(props, "videoCollection");
  const items = node.data.videoCollectionItems ?? [];
  const { t } = useI18n();
  return (
    <Frame node={node} selected={props.selected}>
      <div className="curated-source">
        <div className="curated-strip curated-videos">
          {items.slice(0, 4).map((item, index) => (
            <video
              key={item.id}
              src={item.blobHash ? mediaUrl(item.blobHash) : undefined}
              controls
              muted
              playsInline
              aria-label={`Video ${index + 1}`}
            />
          ))}
        </div>
        <div className="structured-note">
          <LockKeyhole size={11} />
          {t("node.immutableVideos", { count: items.length })}
        </div>
      </div>
    </Frame>
  );
}

function AssetBody(
  props: NodeViewProps<Record<string, JsonValue>>,
  options: { kind: "assetText" | "assetImage"; type: "text" | "image"; localizedType: string; previewImage: boolean },
) {
  const node = runtime(props, options.kind);
  const { t } = useI18n();
  const type = localizedPortLabel(
    options.type,
    options.type,
    options.localizedType,
  );
  return (
    <Frame node={node} selected={props.selected}>
      <div className="asset-reference">
        <div className="asset-reference-meta">
          <LockKeyhole size={13} />
          <span>
            {t("node.assetVersion", {
              type,
              version: node.data.assetVersion ?? 1,
            })}
          </span>
        </div>
        {options.previewImage && node.data.value ? (
          <img
            src={String(node.data.value)}
            alt={String(node.data.assetName ?? "Asset")}
          />
        ) : node.data.value ? (
          <DeferredMarkdown value={String(node.data.value)} />
        ) : (
          <div className="node-error">{t("node.assetUnavailable")}</div>
        )}
      </div>
    </Frame>
  );
}
export function AssetTextBody(props: NodeViewProps<Record<string, JsonValue>>) {
  return AssetBody(props, { kind: "assetText", type: "text", localizedType: "Text", previewImage: false });
}
export function AssetImageBody(
  props: NodeViewProps<Record<string, JsonValue>>,
) {
  return AssetBody(props, { kind: "assetImage", type: "image", localizedType: "Bild", previewImage: true });
}

export function ImageInputBody(
  props: NodeViewProps<Record<string, JsonValue>>,
) {
  const node = runtime(props, "imageInput"),
    update = useUpdate(node);
  const input = useRef<HTMLInputElement>(null);
  const { t } = useI18n();
  const importFile = async (file?: File) => {
    if (!file) return;
    try {
      if (!file.type.startsWith("image/"))
        throw new Error("Bitte wähle eine Bilddatei.");
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () =>
          reject(new Error("Das Bild konnte nicht gelesen werden."));
        reader.readAsDataURL(file);
      });
      let stored: Awaited<ReturnType<typeof storeLibraryResult>> | undefined;
      if (isDesktopRuntime()) {
        const state = useFlowStore.getState();
        const projectId = state.document?.id;
        if (projectId) {
          const revision = await state.flushPendingSave();
          const executionSnapshot = await currentExecutionSnapshot(node.id, revision);
          stored = await storeLibraryResult({
            projectId,
            nodeId: node.id,
            kind: "image",
            dataUrl,
            originalName: file.name,
            expectedRevision: revision,
            inputFingerprint: executionSnapshot,
          });
        }
      }
      if (stored && !stored.active)
        throw new Error(
          appErrorMessage(
            "project_changed",
            "Das importierte Bild wurde gespeichert, aber nicht aktiviert.",
          ),
        );
      update({
        value: dataUrl,
        fileName: file.name,
        assetId: stored?.assetId,
        blobHash: stored?.blobHash,
        mediaType: stored?.mediaType,
        outputValues: {
          image: stored?.blobHash ? `flowz-cas:${stored.blobHash}` : dataUrl,
        },
        persisted: Boolean(stored),
        status: stored ? "fresh" : "temporary",
        error: undefined,
      });
    } catch (error) {
      update({ status: "error", error: String(error) });
    }
  };
  return (
    <Frame node={node} selected={props.selected}>
      <label
        className={`image-drop ${node.data.value ? "has-image" : ""}`}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          void importFile(event.dataTransfer.files[0]);
        }}
      >
        <input
          ref={input}
          type="file"
          accept="image/*"
          onChange={(event) => void importFile(event.currentTarget.files?.[0])}
        />
        {node.data.value ? (
          <img src={String(node.data.value)} alt={t("node.importedPreview")} />
        ) : (
          <>
            <Upload size={20} />
            <span>{t("node.chooseImage")}</span>
          </>
        )}
      </label>
    </Frame>
  );
}

function MediaInputBody(
  props: NodeViewProps<Record<string, JsonValue>>,
  options: { kind: "videoInput" | "audioInput"; mediaKind: "video" | "audio"; chooseLabel: "node.chooseVideo" | "node.chooseAudio" },
) {
  const node = runtime(props, options.kind),
    update = useUpdate(node);
  const [operation, setOperation] = useState<string>();
  const { t } = useI18n();
  const recorderRef = useRef<AudioRecorderController | undefined>(undefined);
  if (!recorderRef.current) recorderRef.current = new AudioRecorderController({
    getUserMedia: async () => navigator.mediaDevices.getUserMedia({ audio: true }),
    createRecorder: (stream, mimeType) => new MediaRecorder(stream as MediaStream, { mimeType }) as unknown as ReturnType<AudioRecorderDependencies["createRecorder"]>,
    chooseMimeType: chooseBrowserAudioMimeType,
    begin: beginRecordingSession,
    append: appendRecordingChunk,
    finish: finishRecordingSession,
    finalize: (stageId, projectId, nodeId) => finalizeMediaStage(stageId, "audio", projectId, nodeId),
    abort: abortRecordingSession,
    cancelStage: cancelMediaStage,
  });
  const recorder = recorderRef.current;
  const recording = useSyncExternalStore(recorder.subscribe, recorder.getSnapshot, recorder.getSnapshot);
  useEffect(() => () => { void recorder.dispose(); }, [recorder]);
  useEffect(() => { if (recording.error) update({ status: "error", error: recording.error }); }, [recording.error]);
  const applyImported = (imported: Awaited<ReturnType<typeof finalizeMediaStage>>) => update({
    ...mediaDisplay(imported), value: imported.hash, assetId: imported.assetId, blobHash: imported.hash,
    mediaType: imported.mediaType, mediaMetadata: mediaDisplay(imported).mediaMetadata,
    persisted: true, status: "fresh", error: undefined,
  } as Partial<FlowNodeData>);
  const startRecording = async () => {
    try {
      const projectId = useFlowStore.getState().document?.id;
      if (!projectId) throw new Error("Kein aktives Projekt.");
      const revision = await useFlowStore.getState().flushPendingSave();
      await recorder.start(projectId, node.id, revision);
    } catch (error) { update({ status: "error", error: String(error) }); }
  };
  const stopRecording = async () => {
    try {
      const projectId = useFlowStore.getState().document?.id;
      if (!projectId) throw new Error("Kein aktives Projekt.");
      applyImported(await recorder.stop(projectId, node.id));
    } catch (error) { update({ status: "error", error: String(error) }); await recorder.cancel(); }
  };
  const run = async () => {
    if (operation) {
      await cancelMediaImport(operation);
      return;
    }
    const id = crypto.randomUUID();
    let stage: string | undefined;
    try {
      setOperation(id);
      const projectId = useFlowStore.getState().document?.id;
      if (!projectId) throw new Error("Kein aktives Projekt.");
      const revision = await useFlowStore.getState().flushPendingSave();
      const picked = await pickMediaStage(
        options.mediaKind,
        projectId,
        node.id,
        revision,
        id,
      );
      stage = picked.stageId;
      if (!stage || isMediaImportCancellationRequested(id))
        throw new Error("Medienimport abgebrochen.");
      const imported = await finalizeMediaStage(
        stage,
        options.mediaKind,
        projectId,
        node.id,
      );
      stage = undefined;
      applyImported(imported);
    } catch (error) {
      if (stage) await cancelMediaStage(stage).catch(() => undefined);
      if (!/abgebrochen/i.test(String(error)))
        update({ status: "error", error: String(error) });
    } finally {
      clearMediaImportCancellation(id);
      setOperation(undefined);
    }
  };
  return (
    <Frame node={node} selected={props.selected}>
      <div className="media-import">
        {node.data.blobHash && node.data.mediaMetadata ? (
          <MediaPreview
            hash={node.data.blobHash}
            posterHash={node.data.posterHash}
            metadata={node.data.mediaMetadata}
            fileName={node.data.fileName}
          />
        ) : null}
        <button
          type="button"
          className="media-import-empty"
          onClick={() => void run()}
          disabled={recording.status !== "idle"}
        >
          {operation ? (
            <Square size={20} />
          ) : (
            <Upload size={20} />
          )}
          <span>
            {operation
              ? t("node.cancelImport")
              : t(options.chooseLabel)}
          </span>
        </button>
        {options.kind === "audioInput" ? <div className="audio-recording-controls">
          {recording.status === "idle" ? <button type="button" className="secondary" disabled={Boolean(operation)} onClick={() => void startRecording()}><Mic size={14}/>{t("node.recordAudio")}</button> : null}
          {recording.status === "requesting" ? <span role="status"><LoaderCircle className="spin" size={13}/>{t("node.recordingPermission")}</span> : null}
          {recording.status === "recording" ? <><span role="status"><i className="recording-dot"/>{t("node.recordingActive")} · {formatDuration(recording.seconds)}</span><button type="button" className="primary" onClick={() => void stopRecording()}><Square size={12}/>{t("node.stopRecording")}</button><button type="button" className="secondary danger" onClick={() => void recorder.cancel()}>{t("node.discardRecording")}</button></> : null}
          {recording.status === "finishing" ? <span role="status"><LoaderCircle className="spin" size={13}/>{t("node.recordingFinishing")}</span> : null}
        </div> : null}
      </div>
    </Frame>
  );
}
export function VideoInputBody(
  props: NodeViewProps<Record<string, JsonValue>>,
) {
  return MediaInputBody(props, { kind: "videoInput", mediaKind: "video", chooseLabel: "node.chooseVideo" });
}
export function AudioInputBody(
  props: NodeViewProps<Record<string, JsonValue>>,
) {
  return MediaInputBody(props, { kind: "audioInput", mediaKind: "audio", chooseLabel: "node.chooseAudio" });
}

function ContextBody(
  props: NodeViewProps<Record<string, JsonValue>>,
  kind: "webpage" | "research",
) {
  const node = runtime(props, kind),
    update = useUpdate(node);
  const projectId = useFlowStore((state) => state.document?.id);
  const inputsForPort = useFlowStore((state) => state.inputsForPort);
  const controller = useRef<AbortController | undefined>(undefined);
  const { t } = useI18n();
  const execute = async () => {
    const graph = useFlowStore
      .getState()
      .document?.graph.nodes.find((item) => item.id === node.id);
    if (!graph || !projectId) return;
    controller.current = new AbortController();
    update({ status: "running", error: undefined }, false);
    try {
      const state = useFlowStore.getState();
      const desktop = isDesktopRuntime();
      const revision = desktop ? await state.flushPendingSave() : undefined;
      const executionSnapshot = revision == null
        ? undefined
        : await currentExecutionSnapshot(node.id, revision);
      const module = canonicalNodeRegistry.forKind(kind);
      const text = (
        kind === "webpage"
          ? inputsForPort(node.id, "url")
          : inputsForPort(node.id, "query")
      ).map((value) => ({
        kind: "scalar" as const,
        value: { type: "text" as const, value },
      }));
      const result = await dispatchAppNodeExecution(module, graph, {
        signal: controller.current.signal,
        inputs: { [kind === "webpage" ? "url" : "query"]: text },
        services: {
          webpage: {
            fetch: ({ url, includeScreenshot }) =>
              fetchWebpage(url, includeScreenshot),
          },
          research: {
            search: ({ query, resultCount, freshness }) =>
              runWebResearch(query, resultCount, freshness),
          },
        },
      });
      const output = result.outputs.text;
      const value =
        output?.kind === "scalar" && output.value.type === "text"
          ? output.value.value
          : "";
      const fingerprint =
        executionSnapshot?.executionFingerprint ??
        currentExecutionFingerprint(node.id);
      const screenshot =
        typeof result.metadata?.screenshotDataUrl === "string"
          ? result.metadata.screenshotDataUrl
          : undefined;
      const parameters = {
        executionFingerprint: fingerprint,
        provider: String(
          result.metadata?.provider ??
            result.metadata?.screenshotProvider ??
            kind,
        ),
        ...(typeof result.metadata?.finalUrl === "string"
          ? { finalUrl: result.metadata.finalUrl }
          : {}),
        ...(typeof result.metadata?.executedQuery === "string"
          ? { executedQuery: result.metadata.executedQuery }
          : {}),
        ...(typeof result.metadata?.resultCount === "number"
          ? { resultCount: result.metadata.resultCount }
          : {}),
      };
      const stored = isDesktopRuntime()
        ? await storeLibraryResult({
            projectId,
            nodeId: node.id,
            kind: kind === "webpage" ? "webpage" : "text",
            text: value,
            ...(screenshot
              ? { dataUrl: screenshot, originalName: "webpage-screenshot.png" }
              : {}),
            parameters,
            expectedRevision: revision!,
            inputFingerprint: executionSnapshot!,
          })
        : undefined;
      const screenshotValue = stored?.blobHash
        ? `flowz-cas:${stored.blobHash}`
        : undefined;
      const targetCurrent = stored ? stored.active : true;
      const completedHistory = {
        id: stored?.resultId ?? crypto.randomUUID(),
        createdAt: stored?.createdAt ?? new Date().toISOString(),
        value,
        assetId: stored?.assetId,
        blobHash: stored?.blobHash,
        mediaType: stored?.mediaType,
        parameters,
        persisted: Boolean(stored),
        active: targetCurrent,
      };
      if (!targetCurrent) {
        update({
          status: "stale",
          persisted: Boolean(stored),
          error: appErrorMessage(
            "project_changed",
            "Das Ergebnis wurde sicher gespeichert, aber nicht aktiviert.",
          ),
          history: [completedHistory, ...(node.data.history ?? [])],
        });
        return;
      }
      update({
        status: "fresh",
        value,
        outputValues: {
          text: value,
          ...(screenshotValue ? { screenshot: screenshotValue } : {}),
        },
        assetId: stored?.assetId,
        blobHash: stored?.blobHash,
        mediaType: stored?.mediaType,
        persisted: Boolean(stored),
        error: undefined,
        history: [
          completedHistory,
          ...(node.data.history ?? []).map((item) => ({
            ...item,
            active: false,
          })),
        ],
      });
    } catch (error) {
      if (!controller.current?.signal.aborted)
        update({ status: "error", error: String(error) });
    } finally {
      controller.current = undefined;
    }
  };
  useEffect(
    () =>
      projectId
        ? registerNodeExecution(projectId, node.id, {
            execute,
            cancel: () => controller.current?.abort(),
            cost: { paid: kind === "research" },
          })
        : undefined,
    [
      projectId,
      node.id,
      kind,
      node.data.url,
      node.data.query,
      node.data.resultCount,
      node.data.freshness,
      node.data.includeScreenshot,
    ],
  );
  return (
    <Frame node={node} selected={props.selected}>
      {kind === "webpage" ? (
        <>
          <label className="field-label">
            URL
            <input
              type="url"
              value={String(node.data.url ?? "")}
              onChange={(event) =>
                update({ url: event.currentTarget.value, status: "stale" })
              }
            />
          </label>
          <label className="check-control">
            <input
              type="checkbox"
              checked={Boolean(node.data.includeScreenshot)}
              onChange={(event) =>
                update({
                  includeScreenshot: event.currentTarget.checked,
                  status: "stale",
                })
              }
            />
            <span>{t("node.captureScreenshot")}</span>
          </label>
        </>
      ) : (
        <>
          <label className="field-label">
            {t("node.searchQuery")}
            <textarea
              value={String(node.data.query ?? "")}
              onChange={(event) =>
                update({ query: event.currentTarget.value, status: "stale" })
              }
            />
          </label>
          <div className="parameter-row">
            <CustomSelect
              label={t("node.results")}
              value={String(node.data.resultCount ?? 8)}
              options={[5, 8, 10, 15, 20].map((value) => ({
                value: String(value),
                label: formatNumber(value),
              }))}
              onChange={(value) =>
                update({ resultCount: Number(value), status: "stale" })
              }
            />
            <CustomSelect
              label={t("node.timeRange")}
              value={String(node.data.freshness ?? "all")}
              options={["all", "day", "week", "month", "year"].map((value) => ({
                value,
                label: value,
              }))}
              onChange={(value) =>
                update({
                  freshness: value as FlowNodeData["freshness"],
                  status: "stale",
                })
              }
            />
          </div>
        </>
      )}
      <button
        type="button"
        className="run-button"
        onClick={
          node.data.status === "running"
            ? () => controller.current?.abort()
            : () => void execute()
        }
      >
        {node.data.status === "running" ? (
          <Square size={15} />
        ) : (
          <Play size={15} />
        )}{" "}
        {node.data.status === "running" ? t("node.cancel") : t("node.execute")}
      </button>
    </Frame>
  );
}
export function WebpageBody(props: NodeViewProps<Record<string, JsonValue>>) {
  return ContextBody(props, "webpage");
}
export function ResearchBody(props: NodeViewProps<Record<string, JsonValue>>) {
  return ContextBody(props, "research");
}

function NativeOperationBody(
  props: NodeViewProps<Record<string, JsonValue>>,
  kind: "videoFrame" | "imageTransform" | "imageTrimTransparent",
) {
  const node = runtime(props, kind),
    update = useUpdate(node),
    projectId = useFlowStore((state) => state.document?.id),
    inputsForPort = useFlowStore((state) => state.inputsForPort);
  const controller = useRef<AbortController | undefined>(undefined);
  const { t } = useI18n();
  const execute = async () => {
    const state = useFlowStore.getState(),
      graph = state.document?.graph.nodes.find((item) => item.id === node.id);
    if (!graph || !projectId) return;
    controller.current = new AbortController();
    update({ status: "running", error: undefined }, false);
    try {
      await state.flushPendingSave();
      const module = canonicalNodeRegistry.forKind(kind);
      const listImages = kind === "videoFrame" ? [] : inputsForPort(node.id, "imageLists"),
        scalarImages = kind === "videoFrame" ? [] : inputsForPort(node.id, "image"),
        directResolution = kind === "videoFrame"
          ? undefined
          : resolveDirectMediaInputs(
              listImages.length ? listImages : scalarImages,
              directMediaBindingFromConfig(graph.config),
              connectedInputEdgeCount(state.edges, node.id, ["image", "imageLists"]),
            ),
        raw = kind === "videoFrame"
          ? inputsForPort(node.id, "video")
          : directResolution?.values ?? [],
        useImageList = directResolution?.source === "cable" && listImages.length > 0;
      const inputs =
        kind === "videoFrame"
          ? {
              video: raw.map((value) => ({
                kind: "scalar" as const,
                value: {
                  type: "video" as const,
                  assetId: value.replace(/^flowz-cas:/, ""),
                },
              })),
            }
          : {
              [useImageList ? "imageLists" : "image"]: useImageList
                ? [
                    {
                      kind: "list" as const,
                      itemType: "image" as const,
                      items: raw.map((value) => ({
                        type: "image" as const,
                        assetId: value.replace(/^flowz-cas:/, ""),
                      })),
                    },
                  ]
                : raw.map((value) => ({
                    kind: "scalar" as const,
                    value: {
                      type: "image" as const,
                      assetId: value.replace(/^flowz-cas:/, ""),
                    },
                  })),
            };
      const groupRunId = crypto.randomUUID();
      let listIndex = 0;
      const result = await dispatchAppNodeExecution(module, graph, {
        signal: controller.current.signal,
        inputs,
        connectedInputPorts: connectedInputPortIds(state.edges, node.id),
        services: {
          listMap: { execute: executeListProcessing },
          videoFrame: {
            extract: async (request) => {
              const source = state.nodes.find(
                (item) =>
                  item.data.blobHash === request.videoAssetId ||
                  item.data.value === request.videoAssetId,
              );
              const duration = source?.data.mediaMetadata?.durationSeconds;
              if (!duration)
                throw new Error("Die Videodauer ist nicht verfügbar.");
              const extracted = await extractVideoFrame({
                projectId,
                nodeId: node.id,
                videoHash: request.videoAssetId,
                mode: request.mode,
                value: request.value,
                durationSeconds: duration,
                executionFingerprint: currentExecutionFingerprint(node.id),
              });
              return { assetId: extracted.imageHash, mediaType: "image/png" };
            },
          },
          imageOperations: {
            transform: async (request) => {
              const currentIndex = listIndex++;
              const transformed = await transformImage({
                runId: crypto.randomUUID(),
                projectId,
                nodeId: node.id,
                source: `flowz-cas:${request.sourceAssetId}`,
                recipe: request.recipe as any,
                executionFingerprint: currentExecutionFingerprint(node.id),
                groupRunId,
                listIndex: currentIndex,
                listCount: raw.length,
                expectedConfig: graph.config,
              });
              return {
                assetId: transformed.blobHash,
                mediaType: transformed.mediaType,
                width: transformed.width,
                height: transformed.height,
              };
            },
            trimTransparent: async (request) => {
              const currentIndex = listIndex++;
              const edge = state.edges.find((item) => item.target === node.id);
              const cableSource = directResolution?.source === "cable";
              if (cableSource && !edge?.sourceHandle)
                throw new Error("Die Bildverbindung fehlt.");
              const trimmed = await trimTransparentImage({
                runId: crypto.randomUUID(),
                projectId,
                nodeId: node.id,
                source: `flowz-cas:${request.sourceAssetId}`,
                recipe: {
                  padding: request.padding,
                  threshold: request.threshold,
                },
                executionFingerprint: currentExecutionFingerprint(node.id),
                groupRunId,
                listIndex: currentIndex,
                listCount: raw.length,
                expectedConfig: graph.config,
                expectedBinding: cableSource && edge?.sourceHandle ? {
                  sourceNodeId: edge.source,
                  sourcePortId: edge.sourceHandle,
                  targetPortId: edge.targetHandle?.split("::")[0] ?? "image",
                  hashes: [request.sourceAssetId],
                } : undefined,
              });
              return {
                assetId: trimmed.blobHash,
                mediaType: trimmed.mediaType,
                width: trimmed.width,
                height: trimmed.height,
                outcome: trimmed.outcome,
              };
            },
          },
        },
      });
      const output = result.outputs.image;
      if (!output || output.kind !== "scalar" || output.value.type !== "image")
        throw new Error("Kein Bild wurde verarbeitet.");
      const hashes =
        result.outputs.images?.kind === "list"
          ? result.outputs.images.items.flatMap((item) =>
              item.type === "image" ? [item.assetId] : [],
            )
          : [output.value.assetId];
      if (!hashes.length) throw new Error("Kein Bild wurde verarbeitet.");
      const hash = hashes[0];
      const createdAt = new Date().toISOString();
      const history = hashes.map((blobHash, index) => ({
        id: `${groupRunId}:${index}`,
        runId: groupRunId,
        createdAt,
        value: mediaUrl(blobHash),
        blobHash,
        mediaType: "image/png",
        persisted: true,
        active: index === 0,
        parameters: { listIndex: index, listCount: hashes.length },
      }));
      update({
        status: "fresh",
        value: mediaUrl(hash),
        blobHash: hash,
        mediaType: output.value.mimeType ?? "image/png",
        outputValues: {
          image: `flowz-cas:${hash}`,
          ...(hashes.length > 1
            ? { images: hashes.map((item) => `flowz-cas:${item}`) }
            : {}),
        },
        history,
        persisted: true,
        cost: 0,
        error: undefined,
      });
    } catch (error) {
      if (!controller.current?.signal.aborted)
        update({ status: "error", error: String(error) });
    } finally {
      controller.current = undefined;
    }
  };
  useEffect(
    () =>
      projectId
        ? registerNodeExecution(projectId, node.id, {
            execute,
            cancel: () => controller.current?.abort(),
            cost: { paid: false },
          })
        : undefined,
    [
      projectId,
      node.id,
      kind,
      node.data.frameMode,
      node.data.frameValue,
      node.data.transformMode,
      node.data.targetWidth,
      node.data.targetHeight,
      node.data.trimPadding,
      node.data.trimThreshold,
    ],
  );
  const fields =
    kind === "videoFrame" ? (
      <>
        <CustomSelect
          label={t("node.position")}
          value={String(node.data.frameMode ?? "last")}
          options={["first", "last", "seconds", "percent"].map((value) => ({
            value,
            label: value,
          }))}
          onChange={(value) =>
            update({
              frameMode: value as FlowNodeData["frameMode"],
              status: "stale",
            })
          }
        />
        {["seconds", "percent"].includes(String(node.data.frameMode)) ? (
          <input
            type="number"
            value={Number(node.data.frameValue ?? 0)}
            onChange={(event) =>
              update({
                frameValue: Number(event.currentTarget.value),
                status: "stale",
              })
            }
          />
        ) : null}
      </>
    ) : kind === "imageTrimTransparent" ? (
      <>
        <label className="field-label">
          {t("node.padding")}
          <input
            type="number"
            min={0}
            max={64}
            value={Number(node.data.trimPadding ?? 2)}
            onChange={(event) =>
              update({
                trimPadding: Number(event.currentTarget.value),
                status: "stale",
              })
            }
          />
        </label>
        <label className="field-label">
          {t("node.alphaThreshold")}
          <input
            type="number"
            min={0}
            max={254}
            value={Number(node.data.trimThreshold ?? 0)}
            onChange={(event) =>
              update({
                trimThreshold: Number(event.currentTarget.value),
                status: "stale",
              })
            }
          />
        </label>
      </>
    ) : (
      <>
        <CustomSelect
          label={t("node.transformMode")}
          value={String(node.data.transformMode ?? "fit")}
          options={["fit", "fill", "free"].map((value) => ({
            value,
            label: value,
          }))}
          onChange={(value) =>
            update({
              transformMode: value as FlowNodeData["transformMode"],
              status: "stale",
            })
          }
        />
        <div className="parameter-row">
          <input
            aria-label={t("node.width")}
            type="number"
            value={Number(node.data.targetWidth ?? 1024)}
            onChange={(event) =>
              update({
                targetWidth: Number(event.currentTarget.value),
                status: "stale",
              })
            }
          />
          <input
            aria-label={t("node.height")}
            type="number"
            value={Number(node.data.targetHeight ?? 1024)}
            onChange={(event) =>
              update({
                targetHeight: Number(event.currentTarget.value),
                status: "stale",
              })
            }
          />
        </div>
      </>
    );
  return (
    <Frame node={node} selected={props.selected}>
      {kind !== "videoFrame" ? <DirectImageSource nodeId={node.id} data={node.data as unknown as Record<string, JsonValue>} ports={["image", "imageLists"]} exclusivePorts /> : null}
      {fields}
      <button
        type="button"
        className="run-button"
        onClick={
          node.data.status === "running"
            ? () => controller.current?.abort()
            : () => void execute()
        }
      >
        {node.data.status === "running" ? (
          <>
            <Square size={15} />
            {t("node.cancel")}
          </>
        ) : (
          <>
            <Play size={15} />
            {t("node.execute")}
          </>
        )}
      </button>
    </Frame>
  );
}
export function VideoFrameBody(
  props: NodeViewProps<Record<string, JsonValue>>,
) {
  return NativeOperationBody(props, "videoFrame");
}
export function ImageTransformBody(
  props: NodeViewProps<Record<string, JsonValue>>,
) {
  return NativeOperationBody(props, "imageTransform");
}
export function ImageTrimTransparentBody(
  props: NodeViewProps<Record<string, JsonValue>>,
) {
  return NativeOperationBody(props, "imageTrimTransparent");
}
