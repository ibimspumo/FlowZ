import type { UpdatePolicy } from "../domain/project";
import type { NodeKind } from "../types";
import { useFlowStore } from "../store";
import { useI18n } from "../i18n";
import { CustomSelect } from "./CustomSelect";

const PASSIVE = new Set<NodeKind>(["textInput", "imageInput", "videoInput", "audioInput", "assetText", "assetImage", "imageCollection", "videoCollection", "brandBrief", "artboard"]);
const EXPENSIVE_AUTO = new Set<NodeKind>(["imageGeneration", "videoGeneration", "logoDesign", "imageUpscale", "backgroundRemoval"]);

export function policyOptions(kind: NodeKind, labels: { manual: string; automatic: string; frozen: string }) {
  return [
    { value: "manual", label: labels.manual },
    ...(!EXPENSIVE_AUTO.has(kind) ? [{ value: "auto", label: labels.automatic }] : []),
    { value: "frozen", label: labels.frozen },
  ];
}

export function NodePolicyControl({ nodeId, kind, value }: { nodeId: string; kind: NodeKind; value: UpdatePolicy }) {
  const { t } = useI18n(); const setPolicy = useFlowStore((state) => state.updateNodePolicy);
  if (PASSIVE.has(kind)) return null;
  return <div className="node-policy nodrag nowheel" title={t('node.policy.hint')}>
    <CustomSelect label={t('node.policy.label')} value={value} options={policyOptions(kind, { manual: t('node.policy.manual'), automatic: t('node.policy.auto'), frozen: t('node.policy.frozen') })} onChange={(next) => setPolicy(nodeId, next as UpdatePolicy)} />
  </div>;
}
