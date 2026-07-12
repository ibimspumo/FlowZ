import type { JsonValue } from "../../domain/project";
import type { NodeViewProps } from "../../engine/node-module";
import { CustomSelect } from "../../components/CustomSelect";
import { DirectImageSource } from "../../components/DirectImageSource";
import {
  falImageConfigFromValues,
  falImageEndpoint,
  formatAspectRatioLabel,
  formatImageSizeLabel,
  FAL_IMAGE_MODELS,
  falImageModel,
} from "./capabilities";
import { useFlowStore } from "../../store";
import { estimateFalImageCost, falImageCostContext } from "../fal-pricing";
import { useFalCostDisplay } from "../use-fal-cost-display";
import { directMediaBindingFromConfig, resolveDirectMediaInputs } from "../direct-media";
import {
  BACKGROUND_REMOVAL_TOOL,
  UPSCALE_TOOLS,
  falImageTool,
} from "./tool-capabilities";
import {
  FalFrame,
  FalCostEstimateView,
  FalRecoveryButton,
  FalRunButton,
  falRuntimeNode,
  useFalExecution,
} from "../fal-view";
import { useI18n } from "../../i18n";

export function FalLogoDesignBody(
  props: NodeViewProps<Record<string, JsonValue>>,
) {
  const node = falRuntimeNode(props, "logoDesign"),
    runtime = useFalExecution(node),
    model = falImageModel(String(node.data.model ?? "")),
    edges = useFlowStore((state) => state.edges),
    inputs = useFlowStore((state) => state.inputsForPort),
    { t } = useI18n();
  void edges;
  const connectedReferences = [...inputs(node.id, "references"), ...inputs(node.id, "referenceLists")],
    referenceCount = resolveDirectMediaInputs(connectedReferences, directMediaBindingFromConfig(node.data as unknown as Record<string, JsonValue>)).values.length,
    prompt = String(node.data.prompt ?? ""),
    config = falImageConfigFromValues(node.data as Record<string, unknown>),
    endpoint = model ? falImageEndpoint(model, referenceCount) : undefined,
    officialEstimate = model
      ? estimateFalImageCost({
          model,
          endpoint,
          config,
          referenceCount,
          prompt,
        })
      : ({ state: "unavailable", reason: "configuration-conflict" } as const);
  const costContext = model && endpoint ? falImageCostContext({ model, endpoint, config, referenceCount }) : undefined,
    estimate = useFalCostDisplay(officialEstimate, endpoint, model?.schemaHash, costContext);
  const connectedBrief = inputs(node.id, "brief").length > 0,
    inlineBrief = String(node.data.inlineBrief ?? ""),
    briefOverride = connectedBrief && node.data.briefOverride === true,
    briefSource = briefOverride
      ? t("direct.override")
      : connectedBrief
        ? t("direct.connected")
        : inlineBrief.trim()
          ? t("image.localBrief")
          : t("image.briefMissing");
  return (
    <FalFrame node={node} selected={props.selected}>
      <div className="structured-note">
        {t("image.logoCapability")}
      </div>
      <div className={`direct-source ${briefOverride ? "is-override" : connectedBrief ? "is-connected" : "is-local"}`} role="status" aria-live="polite">
        <span>{t("image.briefSource")}</span>
        <strong>{briefSource}</strong>
      </div>
      <label className="field-label">
        {t("image.shortBrief")}
        <textarea
          rows={3}
          value={inlineBrief}
          placeholder={t("image.briefPlaceholder")}
          onChange={(event) => runtime.update({ inlineBrief: event.currentTarget.value })}
        />
      </label>
      {connectedBrief ? (
        <button
          type="button"
          className="secondary direct-override-toggle"
          aria-pressed={briefOverride}
          onClick={() => runtime.update({ briefOverride: !briefOverride })}
          disabled={!briefOverride && !inlineBrief.trim()}
        >
          {briefOverride
            ? t("image.useConnectionAgain")
            : t("image.useLocalBrief")}
        </button>
      ) : null}
      <DirectImageSource nodeId={node.id} data={node.data as unknown as Record<string, JsonValue>} ports={["references", "referenceLists"]} optional />
      <label className="field-label">
        {t("image.direction")}
        <textarea
          value={String(node.data.prompt ?? "")}
          onChange={(event) =>
            runtime.update({ prompt: event.currentTarget.value })
          }
        />
      </label>
      {model ? (
        <>
          <div className="parameter-row">
            <label className="field-label">
              {t("image.size")}
              <CustomSelect
                label={t("image.size")}
                value={String(node.data.resolution)}
                options={model.sizes.map((value) => ({
                  value,
                  label: formatImageSizeLabel(value),
                }))}
                onChange={(resolution) => runtime.update({ resolution })}
              />
            </label>
            <label className="field-label">
              {t("image.quality")}
              <CustomSelect
                label={t("image.quality")}
                value={String(node.data.quality ?? "high")}
                options={model.quality.map((value) => ({
                  value,
                  label: value,
                }))}
                onChange={(quality) => runtime.update({ quality })}
              />
            </label>
          </div>
          <label className="field-label">
            {t("image.variants")}
            <CustomSelect
              label={t("image.variants")}
              value={String(node.data.variants ?? 2)}
              options={Array.from({ length: model.variantMax }, (_, index) => ({
                value: String(index + 1),
                label: String(index + 1),
              }))}
              onChange={(variants) =>
                runtime.update({ variants: Number(variants) })
              }
            />
          </label>
        </>
      ) : null}
      {node.data.value ? (
        <img
          className="result-image"
          src={String(node.data.value)}
          alt={t("image.logoResult")}
        />
      ) : null}
      <FalRecoveryButton node={node} />
      <FalCostEstimateView estimate={estimate} />
      <FalRunButton
        running={runtime.running}
        run={runtime.execute}
        cancel={runtime.cancel}
        label={t("image.generateLogos")}
      />
    </FalFrame>
  );
}

export function FalImageGenerationBody(
  props: NodeViewProps<Record<string, JsonValue>>,
) {
  const node = falRuntimeNode(props, "imageGeneration"),
    runtime = useFalExecution(node),
    model = falImageModel(String(node.data.model ?? "")),
    edges = useFlowStore((state) => state.edges),
    inputs = useFlowStore((state) => state.inputsForPort),
    { t } = useI18n();
  void edges;
  const connectedReferences = [...inputs(node.id, "reference"), ...inputs(node.id, "referenceLists")],
    referenceCount = resolveDirectMediaInputs(connectedReferences, directMediaBindingFromConfig(node.data as unknown as Record<string, JsonValue>)).values.length,
    maskCount = inputs(node.id, "mask").length,
    prompt = [
      ...inputs(node.id, "prompt"),
      String(node.data.prompt ?? ""),
    ]
      .filter(Boolean)
      .join("\n\n"),
    config = falImageConfigFromValues(node.data as Record<string, unknown>),
    endpoint = model ? falImageEndpoint(model, referenceCount, maskCount) : undefined,
    officialEstimate = model
      ? estimateFalImageCost({
          model,
          endpoint,
          config,
          referenceCount,
          maskCount,
          prompt,
        })
      : ({ state: "unavailable", reason: "configuration-conflict" } as const);
  const costContext = model && endpoint ? falImageCostContext({ model, endpoint, config, referenceCount, maskCount }) : undefined,
    estimate = useFalCostDisplay(officialEstimate, endpoint, model?.schemaHash, costContext);
  return (
    <FalFrame node={node} selected={props.selected}>
      <label className="field-label">
        {t("image.model")}
        <CustomSelect
          label={t("image.model")}
          searchable
          value={String(node.data.model ?? "")}
          options={FAL_IMAGE_MODELS.map((item) => ({
            value: item.id,
            label: item.label,
          }))}
          onChange={(value) => {
            const next = falImageModel(value);
            if (next)
              runtime.update({
                model: value,
                resolution: next.sizes[0],
                aspectRatio: (next.aspectRatios as readonly string[]).includes(
                  "1:1",
                )
                  ? "1:1"
                  : (next.aspectRatios[0] ?? "auto"),
                outputFormat: next.formats.includes("png")
                  ? "png"
                  : next.formats[0],
                variants: 1,
              });
          }}
        />
      </label>
      <label className="field-label">
        {t("image.instruction")}
        <textarea
          value={String(node.data.prompt ?? "")}
          onChange={(event) =>
            runtime.update({ prompt: event.currentTarget.value })
          }
        />
      </label>
      <DirectImageSource nodeId={node.id} data={node.data as unknown as Record<string, JsonValue>} ports={["reference", "referenceLists"]} optional />
      {model ? (
        <>
          <div className="parameter-row">
            <label className="field-label">
              {t("image.size")}
              <CustomSelect
                label={t("image.size")}
                value={String(node.data.resolution)}
                options={model.sizes.map((value) => ({
                  value,
                  label: formatImageSizeLabel(value),
                }))}
                onChange={(resolution) => runtime.update({ resolution })}
              />
            </label>
            {model.aspectRatios.length ? (
              <label className="field-label">
                {t("image.aspectRatio")}
                <CustomSelect
                  label={t("image.aspectRatio")}
                  value={String(node.data.aspectRatio)}
                  options={model.aspectRatios.map((value) => ({
                    value,
                    label: formatAspectRatioLabel(value),
                  }))}
                  onChange={(aspectRatio) => runtime.update({ aspectRatio })}
                />
              </label>
            ) : null}
          </div>
          <div className="parameter-row">
            <label className="field-label">
              {t("image.fileFormat")}
              <CustomSelect
                label={t("image.fileFormat")}
                value={String(node.data.outputFormat)}
                options={model.formats.map((value) => ({
                  value,
                  label: value.toUpperCase(),
                }))}
                onChange={(outputFormat) => runtime.update({ outputFormat })}
              />
            </label>
            <label className="field-label">
              {t("image.variants")}
              <CustomSelect
                label={t("image.variants")}
                value={String(node.data.variants ?? 1)}
                options={Array.from(
                  { length: model.variantMax },
                  (_, index) => ({
                    value: String(index + 1),
                    label: String(index + 1),
                  }),
                )}
                onChange={(variants) =>
                  runtime.update({ variants: Number(variants) })
                }
              />
            </label>
          </div>
          {model.streaming ? (
            <label className="check-control">
              <input
                type="checkbox"
                checked={node.data.streamingEnabled !== false}
                onChange={(event) =>
                  runtime.update({
                    streamingEnabled: event.currentTarget.checked,
                  })
                }
              />
              <span>
                {t("image.liveStatus")}
              </span>
            </label>
          ) : null}
        </>
      ) : null}
      {node.data.value ? (
        <img
          className="result-image"
          src={String(node.data.value)}
          alt={t("image.result")}
        />
      ) : null}
      <FalRecoveryButton node={node} />
      <FalCostEstimateView estimate={estimate} />
      <FalRunButton
        running={runtime.running}
        run={runtime.execute}
        cancel={runtime.cancel}
        label={t("image.generate")}
      />
    </FalFrame>
  );
}

export function FalImageToolBody(
  props: NodeViewProps<Record<string, JsonValue>>,
) {
  const kind = (props.runtimeProps as { data?: { kind?: string } })?.data?.kind;
  if (kind !== "imageUpscale" && kind !== "backgroundRemoval")
    throw new Error("Fal image tool view mismatch.");
  const node = falRuntimeNode(props, kind),
    runtime = useFalExecution(node),
    upscale = kind === "imageUpscale",
    tool = falImageTool(
      upscale ? String(node.data.model) : BACKGROUND_REMOVAL_TOOL,
    ),
    premium = String(node.data.model).includes("/topaz/"),
    { t } = useI18n();
  return (
    <FalFrame node={node} selected={props.selected}>
      <DirectImageSource nodeId={node.id} data={node.data as unknown as Record<string, JsonValue>} ports={["image"]} />
      {upscale ? (
        <>
          <label className="field-label">
            {t("image.model")}
            <CustomSelect
              label={t("image.model")}
              value={String(node.data.model)}
              options={UPSCALE_TOOLS.map((item) => ({
                value: item.id,
                label: item.label,
              }))}
              onChange={(model) =>
                runtime.update({
                  model,
                  premiumConfirmed: false,
                  factor: model.includes("/topaz/") ? 1 : 2,
                })
              }
            />
          </label>
          <div className="parameter-row">
            <label className="field-label">
              {t("image.scale")}
              <CustomSelect
                label={t("image.scale")}
                value={String(node.data.factor ?? 2)}
                options={(tool &&
                "factors" in tool &&
                Array.isArray(tool.factors)
                  ? tool.factors
                  : [1, 2, 3, 4]
                ).map((value) => ({
                  value: String(value),
                  label: `${value}×`,
                }))}
                onChange={(factor) =>
                  runtime.update({
                    upscaleMode: "factor",
                    factor: Number(factor),
                  })
                }
              />
            </label>
            <label className="field-label">
              {t("image.fileFormat")}
              <CustomSelect
                label={t("image.fileFormat")}
                value={String(node.data.outputFormat ?? "png")}
                options={(tool?.formats ?? ["png"]).map((value) => ({
                  value,
                  label: value.toUpperCase(),
                }))}
                onChange={(outputFormat) => runtime.update({ outputFormat })}
              />
            </label>
          </div>
          {premium ? (
            <label className="check-control">
              <input
                type="checkbox"
                checked={Boolean(node.data.premiumConfirmed)}
                onChange={(event) =>
                  runtime.update({
                    premiumConfirmed: event.currentTarget.checked,
                  })
                }
              />
              <span>
                {t("image.confirmPremium")}
              </span>
            </label>
          ) : null}
        </>
      ) : (
        <div className="structured-note">
          {t("image.backgroundCapability")}
        </div>
      )}
      {node.data.value ? (
        <img
          className="result-image"
          src={String(node.data.value)}
          alt={t("image.result")}
        />
      ) : null}
      <FalRecoveryButton node={node} />
      <FalRunButton
        running={runtime.running}
        run={runtime.execute}
        cancel={runtime.cancel}
        label={
          upscale
            ? t("image.upscale")
            : t("image.removeBackground")
        }
      />
    </FalFrame>
  );
}

export function FalImageUpscaleBody(
  props: NodeViewProps<Record<string, JsonValue>>,
) {
  return <FalImageToolBody {...props} />;
}
export function FalBackgroundRemovalBody(
  props: NodeViewProps<Record<string, JsonValue>>,
) {
  return <FalImageToolBody {...props} />;
}
