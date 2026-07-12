import { useRef, useState, type DragEvent } from "react";
import type { JsonValue } from "../domain/project";
import { appErrorMessage, localizeErrorMessage, useI18n, type TranslationKey } from "../i18n";
import {
  assetVersionDirectMediaBinding,
  directMediaBindingFromConfig,
  projectResultDirectMediaBinding,
  resolveDirectMediaInputs,
  type DirectMediaBinding,
} from "../nodes/direct-media";
import { decodeAssetDrag, FLOWZ_ASSET_MIME } from "./asset-drag";
import { getLibraryAssetReference } from "../persistence/assets";
import { storeLibraryResult } from "../persistence/library";
import { isDesktopRuntime } from "../persistence/projects";
import { useFlowStore } from "../store";

class DirectImageError extends Error {
  constructor(readonly key: TranslationKey) { super(key); }
}

function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new DirectImageError("direct.readFailed"));
    reader.readAsDataURL(file);
  });
}

export function DirectImageSource({
  nodeId,
  data,
  ports,
  optional = false,
  exclusivePorts = false,
}: {
  nodeId: string;
  data: Record<string, JsonValue>;
  ports: readonly string[];
  optional?: boolean;
  exclusivePorts?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<{ key?: TranslationKey; detail?: unknown }>(),
    edges = useFlowStore((state) => state.edges),
    inputsForPort = useFlowStore((state) => state.inputsForPort),
    { t } = useI18n();
  void edges;
  const occupiedPorts = ports.filter((port) => inputsForPort(nodeId, port).length > 0),
    connected = ports.flatMap((port) => inputsForPort(nodeId, port)),
    portConflict = exclusivePorts && occupiedPorts.length > 1,
    binding = directMediaBindingFromConfig(data),
    resolution = resolveDirectMediaInputs(connected, binding),
    label = portConflict && resolution.source !== "local-override"
      ? t("direct.conflict")
      : resolution.source === "local-override"
      ? t("direct.override")
      : resolution.source === "cable"
        ? t("direct.connected")
        : resolution.source === "local-fallback"
          ? t("direct.local")
          : optional
            ? t("direct.none")
            : t("direct.missing");
  const importFile = async (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) { setError({key:"direct.chooseImageError"}); return; }
    if (!isDesktopRuntime()) { setError({key:"direct.desktopOnly"}); return; }
    setBusy(true); setError(undefined);
    try {
      const before = useFlowStore.getState(), projectId = before.document?.id;
      if (!projectId) throw new DirectImageError("direct.noProject");
      const revision = await before.flushPendingSave(), dataUrl = await readImage(file);
      const result = await storeLibraryResult({ projectId, nodeId, kind: "input-image", dataUrl, originalName: file.name, parameters: { projectRevision: revision } });
      if (!result.blobHash || !result.resultId || !result.mediaType) throw new DirectImageError("direct.incomplete");
      const current = useFlowStore.getState();
      if (current.document?.id !== projectId || current.revision !== revision || current.saveState !== "saved" || !current.nodes.some((node) => node.id === nodeId)) return;
      const next: DirectMediaBinding = projectResultDirectMediaBinding(projectId, revision, result, binding?.priority ?? "fallback");
      if (!current.bindDirectMediaToNode(nodeId, next)) throw new DirectImageError("direct.incompatible");
    } catch (reason) { setError(reason instanceof DirectImageError ? {key:reason.key} : {detail:appErrorMessage("disk_error",reason instanceof Error?reason.message:String(reason))}); }
    finally { setBusy(false); if (inputRef.current) inputRef.current.value = ""; }
  };
  const dropFile = (event: DragEvent<HTMLDivElement>) => {
    const encodedAsset = event.dataTransfer.getData(FLOWZ_ASSET_MIME);
    if (encodedAsset) {
      event.preventDefault(); event.stopPropagation();
      const asset = decodeAssetDrag(encodedAsset);
      if (!asset || asset.kind !== "image") { setError({key:"direct.notImage"}); return; }
      const projectId = useFlowStore.getState().document?.id;
      setBusy(true); setError(undefined);
      void getLibraryAssetReference(asset.versionId)
        .then((reference) => {
          const current = useFlowStore.getState();
          if (!projectId || current.document?.id !== projectId || !current.bindDirectMediaToNode(nodeId, assetVersionDirectMediaBinding(asset, reference, binding?.priority ?? "fallback"))) {
            throw new DirectImageError("direct.assetIncompatible");
          }
        })
        .catch((reason) => setError(reason instanceof DirectImageError ? {key:reason.key} : {detail:appErrorMessage("disk_error",reason instanceof Error?reason.message:String(reason))}))
        .finally(() => setBusy(false));
      return;
    }
    if (!event.dataTransfer.files.length) return;
    event.preventDefault(); event.stopPropagation();
    void importFile(event.dataTransfer.files[0]);
  };
  const updatePriority = () => {
    if (!binding) return;
    useFlowStore.getState().bindDirectMediaToNode(nodeId, { ...binding, priority: binding.priority === "override" ? "fallback" : "override" });
  };
  return <div className={`direct-image-source ${resolution.source}`} onDragOver={(event) => { if (event.dataTransfer.types.includes("Files") || event.dataTransfer.types.includes(FLOWZ_ASSET_MIME)) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }} onDrop={dropFile}>
    <div className="direct-source" role="status" aria-live="polite">
      {binding ? <img src={`flowz-media://localhost/${binding.blobHash}`} alt="" /> : null}
      <span>{t("direct.source")}</span><strong>{label}</strong>
    </div>
    {portConflict && resolution.source !== "local-override" ? <small className="direct-source-note" role="alert">{t("direct.portConflict")}</small> : null}
    {resolution.shadowedCableCount ? <small className="direct-source-note">{t("direct.shadowed",{count:resolution.shadowedCableCount})}</small> : null}
    {resolution.source === "cable" && binding ? <small className="direct-source-note">{t("direct.fallbackStored")}</small> : null}
    <div className="direct-source-actions">
      <input ref={inputRef} className="visually-hidden" type="file" accept="image/*" onChange={(event) => void importFile(event.currentTarget.files?.[0])} />
      <button type="button" className="secondary" disabled={busy} onClick={() => inputRef.current?.click()}>{busy ? t("direct.importing") : binding ? t("direct.replace") : t("direct.choose")}</button>
      {binding && connected.length ? <button type="button" className="secondary" aria-pressed={binding.priority === "override"} onClick={updatePriority}>{binding.priority === "override" ? t("direct.useConnection") : t("direct.overrideLocal")}</button> : null}
      {binding ? <button type="button" className="icon-button" aria-label={t("direct.remove")} title={t("direct.remove")} onClick={() => useFlowStore.getState().clearDirectMediaFromNode(nodeId)}>×</button> : null}
    </div>
    {error ? <div className="node-error" role="alert">{error.key ? t(error.key) : localizeErrorMessage(error.detail)}</div> : null}
  </div>;
}
