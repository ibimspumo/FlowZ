import type { JsonValue } from "../../domain/project";
import type { NodeViewProps } from "../../engine/node-module";
import { CustomSelect } from "../../components/CustomSelect";
import { useFlowStore } from "../../store";
import { formatAspectRatioLabel } from "../image/capabilities";
import {
  FAL_VIDEO_FAMILIES,
  connectedFalVideoOccupancy,
  emptyConnectedFalVideoInputs,
  type FalVideoEndpointConfig,
  falVideoFamily,
  inferFalVideoEndpoint,
  selectFalVideoFamily,
  validateFalVideoConfig,
} from "./capabilities";
import {
  FalCostEstimateView,
  FalFrame,
  FalRecoveryButton,
  FalRunButton,
  falRuntimeNode,
  useFalExecution,
} from "../fal-view";
import { estimateFalVideoCost, falVideoCostContext } from "../fal-pricing";
import { useFalCostDisplay } from "../use-fal-cost-display";
import { useI18n } from "../../i18n";
import { InlineOutputPreview } from "../../components/InlineOutputPreview";
import { connectedInputPortIds } from "../direct-media";

export function FalVideoGenerationBody(
  props: NodeViewProps<Record<string, JsonValue>>,
) {
  const node = falRuntimeNode(props, "videoGeneration"),
    runtime = useFalExecution(node),
    edges = useFlowStore((state) => state.edges),
    inputs = useFlowStore((state) => state.inputsForPort),
    { t } = useI18n();
  const materialized = {
    startFrame: inputs(node.id, "startFrame").length,
    endFrame: inputs(node.id, "endFrame").length,
    references:
      inputs(node.id, "references").length +
      inputs(node.id, "referenceLists").length,
  };
  const connectedPorts = connectedInputPortIds(edges, node.id);
  const occupancy = connectedFalVideoOccupancy(materialized, connectedPorts);
  const family =
    falVideoFamily(String(node.data.model ?? "")) ??
    String(node.data.model ?? "");
  const inference = inferFalVideoEndpoint(family, occupancy),
    capability = inference.endpoint,
    durations = capability?.durations ?? ["auto"],
    durationIndex = Math.max(0, durations.indexOf(node.data.duration as never));
  const currentConfig: FalVideoEndpointConfig = {
      duration:
        node.data.duration === "auto" || typeof node.data.duration === "number"
          ? node.data.duration
          : "auto",
      resolution: String(node.data.resolution ?? ""),
      aspectRatio: String(node.data.aspectRatio ?? ""),
      generateAudio: Boolean(node.data.generateAudio),
      bitrateMode: node.data.bitrateMode === "high" ? "high" : "standard",
      ...(typeof node.data.seed === "number" ? { seed: node.data.seed } : {}),
    },
    officialEstimate = estimateFalVideoCost({
      capability,
      config: currentConfig,
      occupancy,
    });
  const configurationErrors = [
    ...emptyConnectedFalVideoInputs(materialized, connectedPorts),
    ...validateFalVideoConfig(capability, currentConfig, occupancy),
  ];
  const costContext = capability ? falVideoCostContext({ capability, config: currentConfig }) : undefined,
    estimate = useFalCostDisplay(officialEstimate, capability?.endpoint, capability?.schemaHash, costContext);
  return (
    <FalFrame node={node} selected={props.selected}>
      <label className="field-label">
        {t("video.modelFamily")}
        <CustomSelect
          searchable
          label={t("video.modelFamily")}
          value={family}
          options={FAL_VIDEO_FAMILIES.map((item) => ({
            value: item.id,
            label: item.label,
          }))}
          onChange={(value) => { const patch = selectFalVideoFamily(value); if (patch) runtime.update(patch); }}
        />
      </label>
      <label className="field-label">
        {t("history.instruction")}
        <textarea
          value={String(node.data.prompt ?? "")}
          onChange={(event) =>
            runtime.update({ prompt: event.currentTarget.value })
          }
        />
      </label>
      {capability ? (
        <>
          <div className="derived-mode">
            <span>{t("video.mode")}</span>
            <strong>
              {capability.mode === "text-to-video"
                ? t("video.textMode")
                : capability.mode === "image-to-video"
                  ? t("video.imageMode")
                  : t("video.referenceMode")}
            </strong>
            <small>
              {t("video.autoMode")}
            </small>
          </div>
          <label className="field-label duration-control">
            <span>
              {t("video.duration")}{" "}
              <output>
                {durations[durationIndex] === "auto"
                  ? t("common.automatic")
                  : `${durations[durationIndex]} ${t("video.seconds")}`}
              </output>
            </span>
            <input
              type="range"
              min={0}
              max={durations.length - 1}
              step={1}
              value={durationIndex}
              aria-label={t("video.durationAria")}
              onChange={(event) =>
                runtime.update({
                  duration: durations[Number(event.currentTarget.value)],
                })
              }
            />
          </label>
          <div className="parameter-row">
            <label className="field-label">
              {t("video.resolution")}
              <CustomSelect
                label={t("video.resolution")}
                value={String(node.data.resolution)}
                options={capability.resolutions.map((value) => ({
                  value,
                  label: value,
                }))}
                onChange={(resolution) => runtime.update({ resolution })}
              />
            </label>
            <label className="field-label">
              {t("video.format")}
              <CustomSelect
                label={t("video.format")}
                value={String(node.data.aspectRatio)}
                options={capability.aspectRatios.map((value) => ({
                  value,
                  label: formatAspectRatioLabel(value),
                }))}
                onChange={(aspectRatio) => runtime.update({ aspectRatio })}
              />
            </label>
          </div>
          <label className="field-label">
            {t("video.bitrate")}
            <CustomSelect
              label={t("video.bitrate")}
              value={String(node.data.bitrateMode ?? "standard")}
              options={capability.bitrateModes.map((value) => ({
                value,
                label:
                  value === "standard"
                    ? t("video.standardRecommended")
                    : t("video.high"),
              }))}
              onChange={(bitrateMode) =>
                runtime.update({ bitrateMode: bitrateMode as "standard" | "high" })
              }
            />
          </label>
          {capability.audio ? (
            <label className="check-control">
              <input
                type="checkbox"
                checked={Boolean(node.data.generateAudio)}
                onChange={(event) =>
                  runtime.update({ generateAudio: event.currentTarget.checked })
                }
              />
              <span>{t("video.audio")}</span>
            </label>
          ) : null}
          <p className="context-disclosure">
            {t("video.privateUpload")}
          </p>
        </>
      ) : (
        <div className="node-error">{inference.error}</div>
      )}
      {node.data.value ? (
        <InlineOutputPreview
          kind="video"
          value={String(node.data.value)}
          label={t("video.generated")}
        />
      ) : null}
      {configurationErrors.length ? <div className="node-error" role="alert">{t("pricing.conflict")} {configurationErrors.join(" ")}</div> : null}
      <FalRecoveryButton node={node} />
      <FalCostEstimateView estimate={estimate} />
      <FalRunButton
        running={runtime.running}
        run={runtime.execute}
        cancel={runtime.cancel}
        label={t("video.generate")}
      />
    </FalFrame>
  );
}
