import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  AlertCircle,
  Check,
  CircleDot,
  LoaderCircle,
  Play,
  Square,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { JsonValue } from "../domain/project";
import type { RuntimeValue } from "../domain/values";
import type { NodeViewProps } from "../engine/node-module";
import { registerNodeExecution } from "../engine/node-execution-bridge";
import { dispatchAppNodeExecution } from "./dispatch";
import { canonicalNodeRegistry } from ".";
import { createFalExecutionServices } from "./fal-transport";
import { nodeSpecifications } from "./module-specifications";
import { NodeShell } from "../components/NodeShell";
import { NodeHistoryLauncher } from "../components/NodeHistoryLauncher";
import { NodeCostSummary } from "../components/NodeCostSummary";
import { NodePolicyControl } from "../components/NodePolicyControl";
import { VariantOutputSockets, variantOutputItems } from "../components/VariantOutputSockets";
import { ListProcessingControl } from "../components/ListProcessingControl";
import { nodePortRailRowCount, nodePortRailStyle, nodePortSocketStyle } from "../components/node-port-layout";
import { mediaUrl } from "../persistence/media";
import { currentExecutionFingerprint, useFlowStore } from "../store";
import type { FlowNode, FlowNodeData, HistoryItem, NodeKind } from "../types";
import { appErrorMessage, localizeErrorMessage, providerErrorMessage, useI18n } from "../i18n";
import { formatCost } from "../components/cost-format";
import type { FalCostDisplayEstimate } from "./fal-pricing";
import {
  localizedCanonicalNodeLabel,
  localizedNodeDescription,
  localizedPortLabel,
} from "../i18n-schema";
import {
  pendingFalImageRuns,
  pendingFalImageToolRuns,
  pendingFalRuns,
  resumeFalImage,
  resumeFalImageTool,
  resumeFalVideo,
} from "../api";
import { classifyRunError, visibleRunErrorMessage } from "../components/run-error-classification";
import { PaidExecutionConflictError, pendingPaidRunState, runPaidNodeOnce } from "./paid-execution-gate";
import { falExecutionFailure } from "./fal-execution-failure";
import { KeyboardPortAction } from "../components/KeyboardPortAction";
import { connectedInputPortIds } from "./direct-media";
import { runtimeValuesFromDisplay } from "./runtime-display-values";

export type FalRuntimeNode = NodeProps<FlowNode>;
const colors: Record<string, string> = {
  text: "#39a9ff",
  image: "#ef3c99",
  video: "#a67cff",
  json: "#29d3c2",
  imageList: "#ef3c99",
  videoList: "#a67cff",
};
export function falRuntimeNode(
  props: NodeViewProps<Record<string, JsonValue>>,
  kind: NodeKind,
): FalRuntimeNode {
  const value = props.runtimeProps as Partial<FalRuntimeNode> | undefined;
  if (
    !value ||
    typeof value.id !== "string" ||
    !value.data ||
    value.data.kind !== kind
  )
    throw new Error(`Fal view mismatch for ${kind}.`);
  return value as FalRuntimeNode;
}
export function FalFrame({
  node,
  selected,
  children,
}: {
  node: FalRuntimeNode;
  selected: boolean;
  children: ReactNode;
}) {
  const remove = useFlowStore((s) => s.deleteNode),
    edges = useFlowStore((s) => s.edges),
    { t } = useI18n(),
    definition = nodeSpecifications[node.data.kind];
  const visibleOutputs = definition.outputs.filter((port) => {
    if (!port.type.endsWith("List")) return true;
    const materialized = node.data.outputValues?.[port.id];
    return (Array.isArray(materialized) && materialized.length > 1)
      || edges.some((edge) => edge.source === node.id && edge.sourceHandle?.split("::")[0] === port.id);
  });
  const variants = variantOutputItems(node.data);
  const portRowCount = nodePortRailRowCount(
    definition.inputs.length,
    visibleOutputs.length,
    variants.map((item) => item.index),
  );
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
        ports: (
          <div className="node-port-space" style={nodePortRailStyle(portRowCount)}>
            {definition.inputs.map((port, index) => (
              <div
                key={`i${port.id}`}
                className="socket socket-in"
                style={nodePortSocketStyle(index)}
              >
                <Handle
                  type="target"
                  position={Position.Left}
                  id={port.id}
                  style={{ background: colors[port.type] }}
                />
                <KeyboardPortAction nodeId={node.id} nodeKind={node.data.kind} portId={port.id} portLabel={port.label} dataType={port.type} direction="input" />
                <span>
                  {localizedPortLabel(port.id, port.type, port.label)}
                </span>
              </div>
            ))}
            {visibleOutputs.map((port, index) => (
              <div
                key={`o${port.id}`}
                className="socket socket-out"
                style={nodePortSocketStyle(index)}
              >
                <span>
                  {localizedPortLabel(port.id, port.type, port.label)}
                </span>
                <KeyboardPortAction nodeId={node.id} nodeKind={node.data.kind} portId={port.id} portLabel={port.label} dataType={port.type} direction="output" />
                <Handle
                  type="source"
                  position={Position.Right}
                  id={port.id}
                  style={{ background: colors[port.type] }}
                />
              </div>
            ))}
            <VariantOutputSockets nodeId={node.id} kind={node.data.kind} data={node.data} offset={visibleOutputs.length} colors={colors} />
          </div>
        ),
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
              {node.data.status === "fresh"
                ? t("node.status.fresh")
                : node.data.status === "running"
                  ? t("node.status.running")
                  : t("node.status.ready")}
            </span>
            <NodeCostSummary data={node.data} />
          </footer>
        ),
      }}
    />
  );
}

export function FalCostEstimateView({estimate}:{estimate:FalCostDisplayEstimate}){
  const {t,locale}=useI18n();
  if(estimate.state==="empirical"){
    const observed=new Date(estimate.snapshot.priceAsOf),date=Number.isNaN(observed.getTime())?estimate.snapshot.priceAsOf:new Intl.DateTimeFormat(locale,{dateStyle:"medium"}).format(observed);
    const range=t("pricing.empiricalDetail",{count:estimate.snapshot.empirical?.usedSampleCount??0,low:formatCost((estimate.snapshot.empirical?.p25Microunits??0)/1_000_000,"estimated"),high:formatCost((estimate.snapshot.empirical?.p75Microunits??0)/1_000_000,"estimated"),date});
    const label=t("pricing.empirical");
    return <div className="fal-cost-estimate is-empirical" role="status" aria-live="polite" aria-label={`${label}: ${formatCost(estimate.amountMicrounits/1_000_000,"estimated")}. ${range}`} title={range}><span>{label}</span><strong>{formatCost(estimate.amountMicrounits/1_000_000,"estimated")}</strong><small>{range}</small></div>;
  }
  if(estimate.state==="available"){
    const minimum=estimate.snapshot.confidence==="minimum";
    const label=t(minimum?"pricing.minimum":"pricing.estimated");
    const basis=t("pricing.basis",{date:estimate.snapshot.priceAsOf});
    const detail=basis;
    return <div className="fal-cost-estimate" role="status" aria-live="polite" aria-label={`${label}: ${formatCost(estimate.amountMicrounits/1_000_000,"estimated")}. ${detail}`} title={detail}><span>{label}</span><strong>{formatCost(estimate.amountMicrounits/1_000_000,"estimated")}</strong><small>{basis}</small></div>;
  }
  const reason=estimate.reason==="configuration-conflict"?t("pricing.conflict"):estimate.reason==="provider-usage-unknown"?t("pricing.providerUnknown"):estimate.reason==="automatic-duration"?t("pricing.autoDuration"):estimate.reason==="unpriced-resolution"?t("pricing.unpricedResolution"):t("pricing.unsupported");
  return <div className="fal-cost-estimate is-unavailable" role="status" aria-live="polite" title={reason}><span>{t("pricing.unavailable")}</span><small>{reason}</small></div>;
}

function runtimeInputs(
  nodeId: string,
  kind: NodeKind,
): Record<string, readonly RuntimeValue[]> {
  const state = useFlowStore.getState(),
    definition = nodeSpecifications[kind],
    result: Record<string, RuntimeValue[]> = {};
  for (const port of definition.inputs) {
    const raw = state.inputsForPort(nodeId, port.id);
    result[port.id] = runtimeValuesFromDisplay(raw, port.type);
  }
  return result;
}
function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

type FalCommittedMedia = {
  resultId: string;
  assetId: string;
  blobHash: string;
  mediaType: string;
};
export function commitFalMedia(
  node: FalRuntimeNode,
  payload: {
    runId: string;
    targetCurrent: boolean;
    contractError?: string;
    items: FalCommittedMedia[];
    kind: "image" | "video";
    costMicrounits?: number;
    costProvenance?: HistoryItem["costProvenance"];
    startFrameHash?: string;
    endFrameHash?: string;
    mediaMetadata?: FlowNodeData["mediaMetadata"];
    posterHash?: string;
  },
) {
  const firstMedia = payload.items[0];
  if (!firstMedia) throw new Error("fal.ai returned no media result.");
  const history: HistoryItem[] = payload.items.map((item, index) => ({
    id: item.resultId,
    runId: payload.runId,
    createdAt: new Date().toISOString(),
    value: mediaUrl(item.blobHash),
    assetId: item.assetId,
    blobHash: item.blobHash,
    mediaType: item.mediaType,
    model: String(node.data.model ?? "fal.ai"),
    prompt: String(node.data.prompt ?? ""),
    cost:
      payload.costMicrounits == null || index > 0
        ? undefined
        : payload.costMicrounits / 1_000_000,
    costProvenance: payload.costProvenance,
    persisted: true,
    active: payload.targetCurrent && index === 0,
  }));
  const outputs: Record<string, string | string[] | undefined> =
    payload.kind === "image"
      ? {
          image: `flowz-cas:${firstMedia.blobHash}`,
          ...(history.length > 1 ? { images: history.map((item) => `flowz-cas:${item.blobHash}`) } : {}),
        }
      : {
          video: `flowz-cas:${firstMedia.blobHash}`,
          ...(history.length > 1 ? { videos: history.map((item) => `flowz-cas:${item.blobHash}`) } : {}),
          startFrame: payload.startFrameHash
            ? `flowz-cas:${payload.startFrameHash}`
            : undefined,
          endFrame: payload.endFrameHash
            ? `flowz-cas:${payload.endFrameHash}`
            : undefined,
        };
  useFlowStore
    .getState()
    .updateNode(
      node.id,
      {
        status: payload.targetCurrent ? "fresh" : "stale",
        ...(payload.targetCurrent
          ? {
              value: mediaUrl(firstMedia.blobHash),
              assetId: firstMedia.assetId,
              blobHash: firstMedia.blobHash,
              mediaType: firstMedia.mediaType,
              mediaMetadata: payload.mediaMetadata,
              posterHash: payload.posterHash,
              outputValues: outputs,
            }
          : {}),
        history: [
          ...history,
          ...(node.data.history ?? []).map((item) => ({
            ...item,
            active: payload.targetCurrent ? false : item.active,
          })),
        ],
        cost: history[0].cost,
        costProvenance: payload.costProvenance,
        persisted: true,
        error: payload.contractError
          ? appErrorMessage("validation_failed", payload.contractError)
          : !payload.targetCurrent
            ? appErrorMessage("project_changed", "Das bezahlte Ergebnis wurde gespeichert, aber nicht aktiviert.")
            : undefined,
      },
      true,
    );
}

export function useFalExecution(node: FalRuntimeNode) {
  const update = useFlowStore((s) => s.updateNode),
    controller = useRef<AbortController | undefined>(undefined),
    projectId = useFlowStore((s) => s.document?.id);
  const execute = () => {
    const contract = currentExecutionFingerprint(node.id) ?? `unavailable:${node.id}`;
    if (!projectId) return Promise.reject(new Error(appErrorMessage("project_unknown")));
    return runPaidNodeOnce({ projectId, nodeId: node.id, contract, operation: async () => {
      const state = useFlowStore.getState(),
        graph = state.document?.graph.nodes.find((item) => item.id === node.id);
      if (!graph || state.document?.id !== projectId) throw new Error(appErrorMessage("project_changed"));
      const active = new AbortController();
      controller.current = active;
      try {
        const pending = await (async () => {
          try {
            return node.data.kind === "videoGeneration"
              ? await pendingFalRuns(projectId, node.id)
              : node.data.kind === "imageGeneration" || node.data.kind === "logoDesign"
                ? await pendingFalImageRuns(projectId, node.id)
                : await pendingFalImageToolRuns(projectId, node.id);
          } catch (reason) {
            throw new Error(appErrorMessage("disk_error", reason instanceof Error ? reason.message : String(reason)));
          }
        })();
        if (pending.length) {
          const state = pendingPaidRunState(pending[0].phase);
          const code = state === "unknown" ? "paid_submit_unknown" : state === "cancel-requested" ? "cancel_requested" : "paid_run_in_flight";
          throw new Error(appErrorMessage(code, pending[0].error));
        }
        update(node.id, { status: "running", error: undefined }, false);
        await state.flushPendingSave();
        active.signal.throwIfAborted();
      const module = canonicalNodeRegistry.forKind(node.data.kind);
      const result = await dispatchAppNodeExecution(module, graph, {
        signal: active.signal,
        inputs: runtimeInputs(node.id, node.data.kind),
        connectedInputPorts: connectedInputPortIds(state.edges, node.id),
        services: { fal: createFalExecutionServices(projectId) },
      });
      const metadata = metadataRecord(result.metadata);
      const output = result.outputs.image ?? result.outputs.video;
      if (
        !output ||
        output.kind !== "scalar" ||
        (output.value.type !== "image" && output.value.type !== "video")
      )
        throw new Error(providerErrorMessage("fal.ai", "Es wurde kein Medienergebnis zurückgegeben."));
      const assetId = output.value.assetId,
        kind = output.value.type,
        outputMimeType = output.value.mimeType;
      const rawResults = Array.isArray(metadata.results)
        ? (metadata.results as Record<string, unknown>[])
        : [];
      const items: FalCommittedMedia[] = (
        rawResults.length
          ? rawResults
          : [
              {
                resultId: metadata.resultId,
                assetId,
                blobHash: metadata.videoHash ?? metadata.blobHash ?? assetId,
                mediaType: outputMimeType,
              },
            ]
      ).map((item) => ({
        resultId: String(item.resultId ?? crypto.randomUUID()),
        assetId: String(item.assetId ?? assetId),
        blobHash: String(item.blobHash ?? metadata.videoHash ?? assetId),
        mediaType: String(
          item.mediaType ??
            outputMimeType ??
            (kind === "video" ? "video/mp4" : "image/png"),
        ),
      }));
      commitFalMedia(node, {
        runId: String(metadata.runId ?? ""),
        targetCurrent: metadata.targetCurrent !== false,
        items,
        kind,
        costMicrounits:
          typeof metadata.costMicrounits === "number"
            ? metadata.costMicrounits
            : undefined,
        costProvenance:
          metadata.costProvenance as HistoryItem["costProvenance"],
        startFrameHash:
          typeof metadata.startFrameHash === "string"
            ? metadata.startFrameHash
            : undefined,
        endFrameHash:
          typeof metadata.endFrameHash === "string"
            ? metadata.endFrameHash
            : undefined,
        mediaMetadata: metadata.mediaMetadata as FlowNodeData["mediaMetadata"],
        posterHash:
          typeof metadata.posterHash === "string"
            ? metadata.posterHash
            : undefined,
      });
      } catch (error) {
        const failure = falExecutionFailure(error, active.signal.aborted);
        update(node.id, { status: failure.status, error: failure.error }, true);
        throw new Error(failure.thrown);
      } finally {
        if (controller.current === active) controller.current = undefined;
      }
    }}).catch((error) => {
      if (!(error instanceof PaidExecutionConflictError)) throw error;
      const typed = appErrorMessage("paid_run_in_flight");
      throw new Error(typed);
    });
  };
  const cancel = async () => controller.current?.abort();
  useEffect(
    () =>
      projectId
        ? registerNodeExecution(projectId, node.id, {
            execute,
            cancel,
            cost: { paid: true },
          })
        : undefined,
    [projectId, node.id, node.data],
  );
  return {
    execute,
    cancel,
    running: node.data.status === "running",
    update: (patch: Partial<FlowNodeData>) =>
      update(node.id, { ...patch, status: "stale" }, true),
  };
}

export function FalRunButton({
  running,
  run,
  cancel,
  label,
}: {
  running: boolean;
  run: () => Promise<void>;
  cancel: () => Promise<void>;
  label: string;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="run-button"
      onClick={() => void (running ? cancel() : run()).catch(() => undefined)}
    >
      {running ? (
        <>
          <Square size={14} />
          <span>{t("common.cancel")}</span>
        </>
      ) : (
        <>
          <Play size={15} />
          <span>{label}</span>
        </>
      )}
    </button>
  );
}

/** Recovery never submits a second paid request. It only rejoins the durable
 * Rust-side journal entry and activates the already persisted result. */
export function FalRecoveryButton({ node }: { node: FalRuntimeNode }) {
  const projectId = useFlowStore((state) => state.document?.id),
    update = useFlowStore((state) => state.updateNode),
    [runId, setRunId] = useState<string>(),
    { t } = useI18n();
  useEffect(() => {
    let active = true;
    if (!projectId) return;
    const pending =
      node.data.kind === "videoGeneration"
        ? pendingFalRuns(projectId, node.id)
        : node.data.kind === "imageGeneration" ||
            node.data.kind === "logoDesign"
          ? pendingFalImageRuns(projectId, node.id)
          : pendingFalImageToolRuns(projectId, node.id);
    void pending
      .then((runs) => {
        if (active)
          setRunId(
            runs.find(
              (run) =>
                !["completed", "failed", "cancelled"].includes(run.phase),
            )?.runId,
          );
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [projectId, node.id, node.data.kind, node.data.status]);
  if (!projectId || !runId || node.data.status === "running") return null;
  const resume = () => runPaidNodeOnce({ projectId, nodeId: node.id, contract: `resume:${runId}`, operation: async () => {
    update(node.id, { status: "running", error: undefined }, false);
    try {
      if (node.data.kind === "videoGeneration") {
        const result = await resumeFalVideo(runId);
        commitFalMedia(node, {
          runId: result.runId,
          targetCurrent: result.targetCurrent,
          contractError: result.contractError,
          kind: "video",
          items: [
            {
              resultId: result.resultId,
              assetId: result.videoHash,
              blobHash: result.videoHash,
              mediaType: result.mediaType,
            },
          ],
          costMicrounits: result.costMicrounits,
          costProvenance: result.costProvenance,
          startFrameHash: result.startFrameHash,
          endFrameHash: result.endFrameHash,
          mediaMetadata: result.mediaMetadata,
          posterHash: result.posterHash,
        });
      } else if (
        node.data.kind === "imageGeneration" ||
        node.data.kind === "logoDesign"
      ) {
        const result = await resumeFalImage(runId);
        commitFalMedia(node, {
          runId: result.runId,
          targetCurrent: result.targetCurrent,
          contractError: result.contractError,
          kind: "image",
          items: result.images.map((item) => ({
            resultId: item.resultId,
            assetId: item.assetId,
            blobHash: item.blobHash,
            mediaType: item.mediaType,
          })),
          costMicrounits: result.costMicrounits,
          costProvenance: result.costProvenance,
        });
      } else {
        const result = await resumeFalImageTool(runId);
        commitFalMedia(node, {
          runId: result.runId,
          targetCurrent: result.targetCurrent,
          contractError: result.contractError,
          kind: "image",
          items: [
            {
              resultId: result.resultId,
              assetId: result.assetId,
              blobHash: result.blobHash,
              mediaType: result.mediaType,
            },
          ],
          costMicrounits: result.costMicrounits,
          costProvenance: result.costProvenance,
        });
      }
      setRunId(undefined);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const unknown = classifyRunError(raw) === "paid-submit-unknown" || /nicht (?:sicher )?(?:erneut )?gesendet|keine sichere fal\.ai-Request-ID|unbekannte[nr]? Ausgang/i.test(raw);
      update(
        node.id,
        {
          status: "error",
          error: unknown ? appErrorMessage("paid_submit_unknown", visibleRunErrorMessage(raw)) : providerErrorMessage("fal.ai", raw),
        },
        true,
      );
    }
  }});
  return (
    <button type="button" className="secondary" onClick={() => void resume()}>
      {t("fal.resume")}
    </button>
  );
}
