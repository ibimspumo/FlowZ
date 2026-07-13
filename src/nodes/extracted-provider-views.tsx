import { LoaderCircle, Play, Square } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { JsonValue } from "../domain/project";
import type { RuntimeValue } from "../domain/values";
import type { NodeViewProps } from "../engine/node-module";
import { registerNodeExecution } from "../engine/node-execution-bridge";
import { getModels, storePaidBrandResult } from "../api";
import { storeLibraryResult } from "../persistence/library";
import { isDesktopRuntime } from "../persistence/projects";
import { currentExecutionFingerprint, useFlowStore } from "../store";
import type { FlowNodeData, ModelOption, NodeKind } from "../types";
import { CustomSelect } from "../components/CustomSelect";
import { DeferredMarkdown } from "../components/DeferredMarkdown";
import { DeferredBrandArtifact } from "../components/DeferredBrandArtifact";
import { nodeRunLabel } from "../components/node-run-labels";
import { getLocale } from "../i18n";
import { ArtboardNodeReference } from "../components/ArtboardNodeReference";
import { DirectImageSource } from "../components/DirectImageSource";
import { artboardNodeRequestFromFlow } from "../artboard-workspace/node-linking";
import { canonicalNodeRegistry } from ".";
import { dispatchAppNodeExecution } from "./dispatch";
import {
  ModuleNodeFrame,
  moduleRuntimeProps,
  useModuleNodeUpdate,
} from "./extracted-node-views";
import { nodeSpecifications } from "./module-specifications";

const CAS = /^flowz-cas:([a-f0-9]{64})$/;
const tr = (de: string, en: string) => (getLocale() === "en" ? en : de);
function runtimeInputs(
  nodeId: string,
  kind: NodeKind,
): Record<string, RuntimeValue[]> {
  const state = useFlowStore.getState();
  const definition = nodeSpecifications[kind];
  const result: Record<string, RuntimeValue[]> = {};
  for (const port of definition.inputs) {
    const raw = state.inputsForPort(nodeId, port.id);
    if (!raw.length) continue;
    result[port.id] = raw.map((value) => {
      const hash = CAS.exec(value)?.[1];
      if (
        port.type === "image" ||
        port.type === "video" ||
        port.type === "audio"
      )
        return {
          kind: "scalar",
          value: { type: port.type, assetId: hash ?? value },
        } as RuntimeValue;
      if (port.type === "json") {
        let parsed: JsonValue = value;
        try {
          parsed = JSON.parse(value) as JsonValue;
        } catch {}
        return {
          kind: "scalar",
          value: { type: "json", value: parsed },
        } as RuntimeValue;
      }
      return { kind: "scalar", value: { type: "text", value } } as RuntimeValue;
    });
  }
  return result;
}
function outputText(value: RuntimeValue | undefined) {
  if (!value) return;
  if (value.kind === "list") return JSON.stringify(value.items);
  if (value.value.type === "text") return value.value.value;
  if (value.value.type === "json") return JSON.stringify(value.value.value);
  if (value.value.type === "webpage") return value.value.url;
  return `flowz-cas:${value.value.assetId}`;
}

function ModelField({
  kind,
  value,
  onChange,
}: {
  kind: "text" | "vision" | "transcription";
  value: string;
  onChange: (value: string) => void;
}) {
  const [models, setModels] = useState<ModelOption[]>([]);
  useEffect(() => {
    let live = true;
    void getModels(kind)
      .then((items) => {
        if (live) setModels(items);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [kind]);
  const options = (
    models.length ? models : [{ id: value, name: value } as ModelOption]
  ).map((item) => ({ value: item.id, label: item.name }));
  return (
    <CustomSelect
      label={tr("Modell", "Model")}
      searchable
      value={value}
      options={options}
      onChange={onChange}
    />
  );
}

function textField(
  data: FlowNodeData,
  update: (patch: Partial<FlowNodeData>) => void,
  key: keyof FlowNodeData,
  label: string,
  rows = 3,
) {
  return (
    <label className="field-label">
      {label}
      <textarea
        rows={rows}
        value={String(data[key] ?? "")}
        onChange={(event) =>
          update({ [key]: event.currentTarget.value, status: "stale" })
        }
      />
    </label>
  );
}

type ProviderViewOptions = {
  kind: NodeKind;
  paidResult: boolean;
  paidExecution: boolean;
  passive?: boolean;
  ready?: (data: FlowNodeData, nodeId: string) => boolean;
  renderFields: (
    data: FlowNodeData,
    update: (patch: Partial<FlowNodeData>) => void,
    nodeId: string,
  ) => ReactNode;
  renderResult?: (value: string) => ReactNode;
};

const renderBrandResult = (value: string) => (
  <DeferredBrandArtifact value={value} />
);

function ProviderBody(
  props: NodeViewProps<Record<string, JsonValue>>,
  options: ProviderViewOptions,
) {
  const { kind } = options;
  const node = moduleRuntimeProps(props, kind),
    update = useModuleNodeUpdate(node),
    projectId = useFlowStore((state) => state.document?.id),
    controller = useRef<AbortController | undefined>(undefined),
    running = useRef(false);
  const execute = async () => {
    if (running.current) return;
    const state = useFlowStore.getState(),
      graph = state.document?.graph.nodes.find((item) => item.id === node.id);
    if (!graph || !projectId) return;
    const edge = state.edges.find((item) => item.target === node.id);
    const source = edge
      ? state.nodes.find((item) => item.id === edge.source)
      : undefined;
    const sourceResult =
      source?.data.history?.find((item) => item.active) ??
      source?.data.history?.[0];
    running.current = true;
    controller.current = new AbortController();
    update({ status: "running", error: undefined });
    try {
      await state.flushPendingSave();
      const result = await dispatchAppNodeExecution(
        canonicalNodeRegistry.forKind(kind),
        graph,
        {
          signal: controller.current.signal,
          inputs: runtimeInputs(node.id, kind),
          services: {
            execution: {
              projectId,
              fingerprint: currentExecutionFingerprint(node.id) ?? "",
              sourceNodeId: source?.id,
              sourceResultId: sourceResult?.id,
            },
          },
        },
      );
      const primary =
        result.outputs[nodeSpecifications[kind].outputs[0]?.id ?? ""] ??
        Object.values(result.outputs)[0];
      const value = outputText(primary) ?? "";
      const cost =
        typeof result.metadata?.costMicrounits === "number"
          ? Number(result.metadata.costMicrounits) / 1_000_000
          : 0;
      const providerPersisted =
        result.metadata?.persisted === true &&
        typeof result.metadata.resultId === "string";
      let stored: Awaited<ReturnType<typeof storeLibraryResult>> | undefined;
      let paidResult:
        | Awaited<ReturnType<typeof storePaidBrandResult>>
        | undefined;
      const persistedModel = String(result.metadata?.model ?? node.data.model ?? "local");
      const persistedPrompt = String(result.metadata?.prompt ?? node.data.prompt ?? "");
      const persistedParameters = {
        provider: String(result.metadata?.provider ?? (options.paidExecution ? "provider" : "local")),
        outputMode: String(result.metadata?.outputMode ?? node.data.outputMode ?? "single"),
        variants: Number(result.metadata?.variants ?? node.data.variantCount ?? 1),
      };
      if (value && isDesktopRuntime() && !providerPersisted && !options.paidResult)
        stored = await storeLibraryResult({
          projectId,
          nodeId: node.id,
          model: persistedModel,
          kind: "text",
          text: value,
          costMicrounits: typeof result.metadata?.costMicrounits === "number" ? Number(result.metadata.costMicrounits) : undefined,
          prompt: persistedPrompt || undefined,
          parameters: persistedParameters,
        });
      if (options.paidResult && isDesktopRuntime())
        paidResult = await storePaidBrandResult({
          runId: crypto.randomUUID(),
          projectId,
          nodeId: node.id,
          model: String(node.data.model ?? "local"),
          kind: `module-${kind}`,
          text: value,
          costMicrounits: Number(result.metadata?.costMicrounits),
          parameters: (result.metadata ?? {}) as Record<string, unknown>,
        });
      const outputValues = Object.fromEntries(
        Object.entries(result.outputs).map(([key, item]) => [
          key,
          outputText(item),
        ]),
      );
      update({
        status: "fresh",
        value,
        outputValues,
        assetId: stored?.assetId,
        persisted:
          providerPersisted ||
          Boolean(stored) ||
          Boolean(paidResult?.persisted) ||
          options.passive === true,
        cost,
        error: undefined,
        history: [
          {
            id:
              (typeof result.metadata?.resultId === "string"
                ? result.metadata.resultId
                : undefined) ??
              paidResult?.resultId ??
              stored?.resultId ??
              crypto.randomUUID(),
            createdAt: stored?.createdAt ?? new Date().toISOString(),
            value,
            cost,
            model: persistedModel,
            prompt: persistedPrompt || undefined,
            parameters: persistedParameters,
            persisted:
              providerPersisted ||
              Boolean(stored) ||
              Boolean(paidResult?.persisted),
            active: true,
          },
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
      running.current = false;
      controller.current = undefined;
    }
  };
  useEffect(
    () =>
      projectId && !options.passive
        ? registerNodeExecution(projectId, node.id, {
            execute,
            cancel: () => controller.current?.abort(),
            cost: { paid: options.paidExecution },
          })
        : undefined,
    [
      projectId,
      node.id,
      kind,
      node.data.model,
      node.data.prompt,
      node.data.privacyConsent,
    ],
  );
  useEffect(() => {
    if (options.passive && options.ready?.(node.data, node.id)) void execute();
  }, [
    kind,
    node.data.brandName,
    node.data.offer,
    node.data.audience,
    node.data.problem,
    node.data.promise,
    node.data.personality,
    node.data.handle,
  ]);
  return (
    <ModuleNodeFrame node={node} selected={props.selected}>
      {options.renderFields(node.data, (patch) => update(patch), node.id)}
      {!options.passive ? (
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
              <Square size={14} />
              {tr("Abbrechen", "Cancel")}
            </>
          ) : (
            <>
              <Play size={14} />
              {nodeRunLabel(kind, false)}
            </>
          )}
        </button>
      ) : null}
      {node.data.status === "running" ? (
        <LoaderCircle className="spin" size={14} />
      ) : null}
      {node.data.value
        ? options.renderResult?.(String(node.data.value)) ?? (
            <DeferredMarkdown value={String(node.data.value)} />
          )
        : null}
    </ModuleNodeFrame>
  );
}

export const TextGenerationBody = (
  props: NodeViewProps<Record<string, JsonValue>>,
) =>
  ProviderBody(props, {
    kind: "textGeneration",
    paidResult: false,
    paidExecution: true,
    renderFields: (data, update) => (
      <>
        <ModelField kind="text" value={String(data.model ?? "")} onChange={(model) => update({ model, status: "stale" })} />
        {textField(data, update, "prompt", tr("Anweisung", "Instruction"), 5)}
      </>
    ),
  });
export const ImageAnalysisBody = (
  props: NodeViewProps<Record<string, JsonValue>>,
) =>
  ProviderBody(props, {
    kind: "imageAnalysis",
    paidResult: false,
    paidExecution: true,
    renderFields: (data, update, nodeId) => (
      <>
        <DirectImageSource nodeId={nodeId} data={data as unknown as Record<string, JsonValue>} ports={["image", "imageLists"]} />
        <ModelField kind="vision" value={String(data.model ?? "")} onChange={(model) => update({ model, status: "stale" })} />
        {textField(data, update, "prompt", tr("Anweisung", "Instruction"), 5)}
      </>
    ),
  });
export const TranscriptionBody = (
  props: NodeViewProps<Record<string, JsonValue>>,
) =>
  ProviderBody(props, {
    kind: "transcription",
    paidResult: false,
    paidExecution: true,
    renderFields: (data, update) => (
      <>
        <ModelField kind="transcription" value={String(data.model ?? "")} onChange={(model) => update({ model, status: "stale" })} />
        <label className="field-label">
          {tr("Sprache", "Language")}
          <input value={String(data.language ?? "auto")} onChange={(event) => update({ language: event.currentTarget.value, status: "stale" })} />
        </label>
        <label className="check-control">
          <input type="checkbox" checked={Boolean(data.timestamps)} onChange={(event) => update({ timestamps: event.currentTarget.checked, status: "stale" })} />
          <span>{tr("Zeitmarken", "Timestamps")}</span>
        </label>
      </>
    ),
  });
export const BrandBriefBody = (
  props: NodeViewProps<Record<string, JsonValue>>,
) =>
  ProviderBody(props, {
    kind: "brandBrief",
    paidResult: false,
    paidExecution: false,
    passive: true,
    renderResult: renderBrandResult,
    ready: (data) => Boolean(String(data.offer ?? "").trim() && String(data.audience ?? "").trim()),
    renderFields: (data, update) => (
      <>
        {textField(data, update, "brandName", tr("Markenname", "Brand name"), 1)}
        {textField(data, update, "offer", tr("Angebot", "Offer"))}
        {textField(data, update, "audience", tr("Zielgruppe", "Audience"))}
        {textField(data, update, "problem", "Problem", 2)}
        {textField(data, update, "promise", tr("Versprechen", "Promise"), 2)}
        {textField(data, update, "personality", tr("Persönlichkeit", "Personality"), 2)}
      </>
    ),
  });
export const AudienceAnalysisBody = (
  props: NodeViewProps<Record<string, JsonValue>>,
) =>
  ProviderBody(props, {
    kind: "audienceAnalysis",
    paidResult: true,
    paidExecution: true,
    renderResult: renderBrandResult,
    renderFields: (data, update) => (
      <>
        <ModelField kind="text" value={String(data.model ?? "")} onChange={(model) => update({ model, status: "stale" })} />
        {textField(data, update, "prompt", tr("Zusatz", "Additional guidance"))}
      </>
    ),
  });
export const BrandNamesBody = (
  props: NodeViewProps<Record<string, JsonValue>>,
) =>
  ProviderBody(props, {
    kind: "brandNames",
    paidResult: true,
    paidExecution: true,
    renderResult: renderBrandResult,
    renderFields: (data, update) => (
      <>
        <ModelField kind="text" value={String(data.model ?? "")} onChange={(model) => update({ model, status: "stale" })} />
        {textField(data, update, "prompt", tr("Zusatz", "Additional guidance"))}
        <label className="field-label">
          {tr("Anzahl", "Count")}
          <input type="number" min={1} max={20} value={Number(data.candidateCount ?? 8)} onChange={(event) => update({ candidateCount: Number(event.currentTarget.value), status: "stale" })} />
        </label>
      </>
    ),
  });
export const DomainCheckBody = (
  props: NodeViewProps<Record<string, JsonValue>>,
) =>
  ProviderBody(props, {
    kind: "domainCheck",
    paidResult: false,
    paidExecution: false,
    renderResult: renderBrandResult,
    renderFields: (data, update) => (
      <>
        {textField(data, update, "domainName", tr("Domainname", "Domain name"), 1)}
        <label className="check-control">
          <input type="checkbox" checked={Boolean(data.privacyConsent)} onChange={(event) => update({ privacyConsent: event.currentTarget.checked, status: "stale" })} />
          <span>{tr("Öffentliche RDAP-Prüfung erlauben", "Allow public RDAP lookup")}</span>
        </label>
      </>
    ),
  });
export const HandlePlanBody = (
  props: NodeViewProps<Record<string, JsonValue>>,
) =>
  ProviderBody(props, {
    kind: "handlePlan",
    paidResult: false,
    paidExecution: false,
    passive: true,
    renderResult: renderBrandResult,
    ready: (data, nodeId) => Boolean(String(data.handle ?? "").trim() || runtimeInputs(nodeId, "handlePlan").names?.length),
    renderFields: (data, update) => textField(data, update, "handle", "Handle", 1),
  });
export const FontPairingBody = (
  props: NodeViewProps<Record<string, JsonValue>>,
) =>
  ProviderBody(props, {
    kind: "fontPairing",
    paidResult: true,
    paidExecution: true,
    renderResult: renderBrandResult,
    renderFields: (data, update) => (
      <>
        <ModelField kind="text" value={String(data.model ?? "")} onChange={(model) => update({ model, status: "stale" })} />
        {textField(data, update, "fontSpecimenText", tr("Vorschautext", "Preview text"), 2)}
      </>
    ),
  });
export const ColorPaletteBody = (
  props: NodeViewProps<Record<string, JsonValue>>,
) =>
  ProviderBody(props, {
    kind: "colorPalette",
    paidResult: true,
    paidExecution: true,
    renderResult: renderBrandResult,
    renderFields: (data, update) => (
      <>
        <ModelField kind="text" value={String(data.model ?? "")} onChange={(model) => update({ model, status: "stale" })} />
        {textField(data, update, "paletteDirection", tr("Richtung", "Direction"))}
      </>
    ),
  });

export function ArtboardReferenceBody(
  props: NodeViewProps<Record<string, JsonValue>>,
) {
  const node = moduleRuntimeProps(props, "artboard"),
    flowId = useFlowStore((state) => state.document?.id) ?? "flow",
    nodes = useFlowStore((state) => state.nodes),
    edges = useFlowStore((state) => state.edges);
  const request = artboardNodeRequestFromFlow(flowId, node.id, nodes, edges);
  return (
    <ModuleNodeFrame node={node} selected={props.selected}>
      <ArtboardNodeReference
        flowId={flowId}
        nodeId={node.id}
        data={node.data}
        upstream={request.upstream}
      />
    </ModuleNodeFrame>
  );
}
