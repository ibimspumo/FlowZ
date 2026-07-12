import {
  AlertCircle, Check, ChevronDown, CircleDollarSign, GripHorizontal, LoaderCircle,
  MessageSquare, RotateCcw, Search, Send, Settings2, Sparkles, Square, X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import type { ArtboardAgentModel, ArtboardAgentProvider, ArtboardAgentToolExecutor } from "../artboard-agent";
import type { FalImageConfig } from "../nodes/image/capabilities";
import { defaultFalImageConfig,FAL_IMAGE_MODELS,falImageEndpoint,falImageModel,formatImageSizeLabel,validateFalImageConfig } from "../nodes/image/capabilities";
import { estimateFalImageCost,falImageCostContext } from "../nodes/fal-pricing";
import { useFalCostDisplay } from "../nodes/use-fal-cost-display";
import { FalCostEstimateView } from "../nodes/fal-view";
import { CustomSelect } from "../components/CustomSelect";
import type { ArtboardWorkspace } from "../nodes/brand/artboard-domain";
import { ArtboardAgentController, isAgentBusy } from "./controller";
import type {
  AgentAdapterFactory, ArtboardAgentContext, ArtboardAgentSelection, ProposalResolver, ResolvedArtboardProposal,
} from "./types";
import { proposalRevisionError } from "./validation";
import { formatCurrency, formatNumber, localizeErrorMessage, useI18n, type TranslationKey } from "../i18n";
import "./artboard-agent-ui.css";

export type ArtboardDesignAgentProps = {
  workspace: ArtboardWorkspace;
  branchId: string;
  revision: { id: string; number: number };
  selection: ArtboardAgentSelection;
  adapterFactory: AgentAdapterFactory;
  toolExecutor: ArtboardAgentToolExecutor;
  resolveProposal: ProposalResolver;
  onApplyProposal: ConstructorParameters<typeof ArtboardAgentController>[0]["onApplyProposal"];
  prepareContext?: () => Promise<ArtboardAgentContext>;
  pendingFollowUps?: ResolvedArtboardProposal["followUpIntents"];
  pendingFollowUpProposalId?: string;
  onDismissFollowUps?: () => void;
  onConfirmFollowUp?: (intent:NonNullable<ResolvedArtboardProposal["followUpIntents"]>[number],proposalId:string,modelId:string,config:FalImageConfig,signal:AbortSignal)=>Promise<ResolvedArtboardProposal>;
  onOpenProviderSettings?: (provider: ArtboardAgentProvider) => void;
  onOpenFalSettings?:()=>void;
  initiallyOpen?: boolean;
};

const providerLabel: Record<ArtboardAgentProvider, string> = { openrouter: "OpenRouter", "codex-local": "Codex" };
const toolLabel: Record<string, TranslationKey> = {
  get_workspace_info: "agent.tool.get_workspace_info", get_selection: "agent.tool.get_selection", get_board: "agent.tool.get_board",
  get_layer_tree: "agent.tool.get_layer_tree", get_layers: "agent.tool.get_layers", get_bound_inputs: "agent.tool.get_bound_inputs",
  render_preview: "agent.tool.render_preview", create_layers: "agent.tool.create_layers", update_layers: "agent.tool.update_layers",
  delete_layers: "agent.tool.delete_layers", duplicate_layers: "agent.tool.duplicate_layers", reorder_layers: "agent.tool.reorder_layers",
  set_board_properties: "agent.tool.set_board_properties", bind_layer_resource: "agent.tool.bind_layer_resource",
  propose_image_generation: "agent.tool.propose_image_generation", finish_working: "agent.tool.finish_working",
};

const statusKey = (state: string) => `agent.status.${state}` as TranslationKey;

export function ArtboardDesignAgent(props: ArtboardDesignAgentProps) {
  const {locale,t}=useI18n();
  const controllerRef = useRef<ArtboardAgentController | undefined>(undefined);
  if (!controllerRef.current) controllerRef.current = new ArtboardAgentController({
    context: { workspace: props.workspace, branchId: props.branchId, revision: props.revision, selection: props.selection },
    adapterFactory: props.adapterFactory, toolExecutor: props.toolExecutor, resolveProposal: props.resolveProposal,
    onApplyProposal: props.onApplyProposal,
  });
  const controller = controllerRef.current;
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [open, setOpen] = useState(props.initiallyOpen ?? false);
  const [settings, setSettings] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const [confirmAbandon, setConfirmAbandon] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState<string>();
  const [paidProposal,setPaidProposal]=useState<ResolvedArtboardProposal>();
  const [position, setPosition] = useState<{ x: number; y: number }>();
  const drag = useRef<{ pointerId: number; dx: number; dy: number } | undefined>(undefined);
  const preparingRef = useRef(false);

  useEffect(() => { void controller.initialize(); return () => { void controller.dispose(); }; }, [controller]);
  useEffect(() => controller.updateViewContext({ workspace: props.workspace, branchId: props.branchId, revision: props.revision, selection: props.selection }), [controller, props.workspace, props.branchId, props.revision.id, props.revision.number, props.selection]);
  useEffect(() => { if (state.runState !== "idle") setOpen(true); }, [state.runState]);

  const currentProvider = state.providers[state.provider];
  const model = currentProvider.models.find((item) => item.id === state.modelId);
  const stale = state.proposal ? proposalRevisionError(state.proposal, { workspace: props.workspace, branchId: props.branchId, revision: props.revision, selection: props.selection }) : undefined;
  const busy = isAgentBusy(state) || preparing;

  const submit = async () => {
    if (preparingRef.current || isAgentBusy(controller.getSnapshot())) return;
    preparingRef.current = true; setPreparing(true); setPrepareError(undefined); setOpen(true);
    try {
      if (props.prepareContext) controller.updateContext(await props.prepareContext());
      await controller.submit();
    } catch (reason) {
      setPrepareError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      preparingRef.current = false; setPreparing(false);
    }
  };

  const beginDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("button,input,textarea")) return;
    const panel = event.currentTarget.closest<HTMLElement>(".aau-panel");
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    drag.current = { pointerId: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    setPosition({ x: rect.left, y: rect.top });
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    const width = Math.min(420, window.innerWidth - 24); const height = Math.min(620, window.innerHeight - 92);
    setPosition({ x: Math.max(8, Math.min(window.innerWidth - width - 8, event.clientX - drag.current.dx)), y: Math.max(8, Math.min(window.innerHeight - height - 8, event.clientY - drag.current.dy)) });
  };
  const endDrag = (event: ReactPointerEvent<HTMLElement>) => { if (drag.current?.pointerId === event.pointerId) drag.current = undefined; };

  return <div className="aau-root">
    {open ? <section
      className="aau-panel" role="region" aria-label={t('agent.title')}
      style={position ? { left: position.x, top: position.y, right: "auto", bottom: "auto" } : undefined}
    >
      <header className="aau-panel-header" onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
        <GripHorizontal size={15} aria-hidden="true" /><strong>{t('agent.title')}</strong>
        <span className={`aau-run-state is-${state.runState}`}><i />{t(statusKey(state.runState))}</span>
        <button type="button" className="aau-icon" onClick={() => setSettings((value) => !value)} aria-label={t('agent.settings')} aria-expanded={settings}><Settings2 size={15} /></button>
        <button type="button" className="aau-icon" onClick={() => setOpen(false)} aria-label={t('agent.collapse')}><X size={15} /></button>
      </header>

      {settings ? <AgentSettings
        provider={state.provider} providers={state.providers} model={model} modelId={state.modelId} reasoningEffort={state.reasoningEffort}
        query={modelQuery} disabled={busy} onQuery={setModelQuery} onProvider={(provider) => controller.selectProvider(provider)}
        onModel={(id) => { controller.selectModel(id); setModelQuery(""); }} onEffort={(value) => controller.setReasoningEffort(value)}
        onRetry={(provider) => void controller.probe(provider)} onOpenSettings={props.onOpenProviderSettings}
      /> : null}

      <div className="aau-conversation" aria-live="polite" aria-relevant="additions text">
        {!state.messages.length ? <div className="aau-empty">
          <Sparkles size={18} /><strong>{t('agent.emptyTitle')}</strong>
          <p>{t('agent.emptyBody')}</p>
        </div> : state.messages.map((item) => <article key={item.id} className={`aau-message is-${item.role} ${item.state === "error" ? "is-error" : ""}`}>
          <span>{item.role === "user" ? t('agent.you') : item.role === "assistant" ? "Agent" : t('agent.system')}</span>
          <p>{item.translationKey ? t(item.translationKey) : item.text || <><span className="aau-skeleton" /><span className="aau-skeleton is-short" /></>}</p>
        </article>)}
      </div>

      {state.tools.length ? <section className="aau-tools" aria-label={t('agent.tools')}>
        {state.tools.slice(-5).map((tool) => <div key={tool.id} className={`is-${tool.state}`}>
          {tool.state === "running" ? <LoaderCircle size={13} className="aau-spin" /> : tool.state === "complete" ? <Check size={13} /> : <AlertCircle size={13} />}
          <span>{toolLabel[tool.tool] ? t(toolLabel[tool.tool]) : tool.tool}</span><small>{tool.state === "running" ? t('agent.running') : tool.state === "complete" ? t('agent.complete') : t('agent.failed')}</small>
        </div>)}
      </section> : null}

      {state.proposal ? <ProposalReview proposal={state.proposal} stale={stale} applying={state.applying} onApply={() => void controller.applyProposal()} onReject={() => controller.rejectProposal()} /> : null}
      {paidProposal ? <ProposalReview proposal={paidProposal} stale={proposalRevisionError(paidProposal,{workspace:props.workspace,branchId:props.branchId,revision:props.revision,selection:props.selection})} applying={state.applying} onApply={()=>void Promise.resolve(props.onApplyProposal(paidProposal.batch,paidProposal)).then(()=>setPaidProposal(undefined))} onReject={()=>setPaidProposal(undefined)} />:null}

      {state.proposal?.followUpIntents?.length
        ? <PaidFollowUpNotice intents={state.proposal.followUpIntents} proposalId={state.proposal.proposalId} onConfirm={props.onConfirmFollowUp} onProposal={setPaidProposal} onOpenSettings={props.onOpenFalSettings} />
        : props.pendingFollowUps?.length ? <PaidFollowUpNotice intents={props.pendingFollowUps} proposalId={props.pendingFollowUpProposalId??"unknown"} onDismiss={props.onDismissFollowUps} onConfirm={props.onConfirmFollowUp} onProposal={setPaidProposal} onOpenSettings={props.onOpenFalSettings} /> : null}

      {state.error || prepareError ? <div className="aau-error" role="alert"><AlertCircle size={14} /><span>{localizeErrorMessage(prepareError ?? state.error ?? "")}</span></div> : null}
      {state.runState === "process-lost" || state.runState === "failed" ? <div className="aau-recovery"><p>{t('agent.noResend')}</p><button type="button" onClick={() => void controller.recover()}><RotateCcw size={13} />{t('agent.recover')}</button></div> : null}
      {state.runState === "unknown" ? <div className="aau-recovery is-warning"><p>{t('agent.unknown')}</p>{confirmAbandon ? <div><button type="button" onClick={() => setConfirmAbandon(false)}>{t('agent.back')}</button><button type="button" className="is-danger" onClick={() => { controller.abandonUnknown(); setConfirmAbandon(false); }}>{t('agent.abandonUnknown')}</button></div> : <button type="button" onClick={() => setConfirmAbandon(true)}>{t('agent.abandon')}</button>}</div> : null}

      <footer className="aau-usage"><span><CircleDollarSign size={12} />{state.usage.costMicrounits===undefined?t('agent.costUnavailable'):formatCurrency(state.usage.costMicrounits/1_000_000)}</span><span>{state.usage.inputTokens===undefined&&state.usage.outputTokens===undefined?t('agent.noUsage'):t('agent.usage',{input:formatNumber(state.usage.inputTokens??0),output:formatNumber(state.usage.outputTokens??0)})}</span></footer>
    </section> : null}

    <form className="aau-bar" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <MessageSquare size={16} aria-hidden="true" />
      <input value={state.prompt} onFocus={() => setOpen(true)} onChange={(event) => controller.setPrompt(event.currentTarget.value)} placeholder={t('agent.prompt')} aria-label={t('agent.instruction')} disabled={busy} />
      <button type="button" className="aau-model-button" onClick={() => { setOpen(true); setSettings(true); }} aria-label={t('agent.chooseProvider')}>
        <span>{model?.name ?? (state.provider==='codex-local'?t('agent.codexLocal'):providerLabel[state.provider])}</span><ChevronDown size={13} />
      </button>
      {busy ? <button type="button" className="aau-stop" onClick={() => void controller.cancel()} disabled={preparing || state.runState === "cancel-requested"}>{preparing ? <LoaderCircle size={13} className="aau-spin" /> : <Square size={12} fill="currentColor" />}{preparing ? t('agent.preparingContext') : state.runState === "cancel-requested" ? t('agent.stopping') : t('agent.stop')}</button>
        : <button type="submit" className="aau-submit" disabled={!state.prompt.trim() || currentProvider.status.state !== "ready" || !state.modelId}><Send size={13} />{t('artboard.proposal')}</button>}
    </form>
  </div>;
}

function AgentSettings({ provider, providers, model, modelId, reasoningEffort, query, disabled, onQuery, onProvider, onModel, onEffort, onRetry, onOpenSettings }: {
  provider: ArtboardAgentProvider; providers: ReturnType<ArtboardAgentController["getSnapshot"]>["providers"]; model?: ArtboardAgentModel; modelId: string; reasoningEffort?: string;
  query: string; disabled: boolean; onQuery: (value: string) => void; onProvider: (value: ArtboardAgentProvider) => void; onModel: (value: string) => void; onEffort: (value?: string) => void;
  onRetry: (value: ArtboardAgentProvider) => void; onOpenSettings?: (value: ArtboardAgentProvider) => void;
}) {
  const {locale,t}=useI18n();
  const current = providers[provider];
  const filtered = useMemo(() => current.models.filter((item) => `${item.name} ${item.id}`.toLocaleLowerCase(locale).includes(query.trim().toLocaleLowerCase(locale))), [current.models, locale, query]);
  return <section className="aau-settings" aria-label={t('agent.configuration')}>
    <div className="aau-provider-tabs" role="radiogroup" aria-label={t('agent.providerGroup')}>
      {(["openrouter", "codex-local"] as const).map((value) => <button key={value} type="button" role="radio" aria-checked={provider === value} className={provider === value ? "is-active" : ""} disabled={disabled} onClick={() => onProvider(value)}>{value==='codex-local'?t('agent.codexLocal'):providerLabel[value]}<ProviderDot state={providers[value].status.state} /></button>)}
    </div>
    {current.status.state === "probing" ? <div className="aau-provider-note"><LoaderCircle size={14} className="aau-spin" />{t('agent.probing')}</div> : null}
    {current.status.state === "ready" ? <>
      <label className="aau-model-search"><Search size={13} /><input value={query} onChange={(event) => onQuery(event.currentTarget.value)} placeholder={t('agent.searchModel')} aria-label={t('agent.modelSearch')} /></label>
      <div className="aau-model-list" role="listbox" aria-label={t('agent.model')}>
        {filtered.map((item) => <button type="button" role="option" aria-selected={item.id === modelId} key={item.id} onClick={() => onModel(item.id)}><span><strong>{item.name}</strong><small>{item.id}</small></span>{item.id === modelId ? <Check size={14} /> : null}</button>)}
        {!filtered.length ? <p>{t('agent.noModel')}</p> : null}
      </div>
      {model?.reasoningEfforts?.length ? <fieldset className="aau-effort"><legend>{t('agent.reasoning')}</legend><div>{model.reasoningEfforts.map((effort) => <button type="button" key={effort} aria-pressed={reasoningEffort === effort} className={reasoningEffort === effort ? "is-active" : ""} onClick={() => onEffort(effort)}>{effort}</button>)}</div></fieldset> : null}
    </> : null}
    {current.status.state === "auth-required" ? <div className="aau-provider-action"><AlertCircle size={15} /><span><strong>{t('agent.authRequired')}</strong><small>{provider === "openrouter" ? t('agent.openrouterAuth') : t('agent.codexAuth')}</small></span>{onOpenSettings ? <button type="button" onClick={() => onOpenSettings(provider)}>{t('agent.openSettings')}</button> : null}</div> : null}
    {current.status.state === "unavailable" || current.status.state === "incompatible" ? <div className="aau-provider-action"><AlertCircle size={15} /><span><strong>{t('agent.unavailable')}</strong><small>{localizeErrorMessage(current.status.reason)}</small></span><button type="button" onClick={() => onRetry(provider)}>{t('agent.retry')}</button></div> : null}
  </section>;
}

function ProviderDot({ state }: { state: string }) { const {t}=useI18n(); return <i className={`aau-provider-dot is-${state}`} aria-label={state === "ready" ? t('agent.ready') : state === "probing" ? t('agent.probingShort') : t('agent.notReady')} />; }

function localizedProposalText(value: string, locale: "de" | "en") {
  if (locale === "de") return value;
  const summary = value.match(/^(\d+) Änderungen?: (\d+) neu, (\d+) angepasst, (\d+) entfernt\.$/);
  if (summary) return `${summary[1]} change${summary[1] === "1" ? "" : "s"}: ${summary[2]} new, ${summary[3]} updated, ${summary[4]} removed.`;
  const quoted = value.match(/^(Board|Ebene) „(.+)“ (hinzufügen|entfernen|ändern)$/);
  if (quoted) return `${{ hinzufügen: "Add", entfernen: "Remove", ändern: "Update" }[quoted[3] as "hinzufügen" | "entfernen" | "ändern"]} ${quoted[1] === "Board" ? "artboard" : "layer"} “${quoted[2]}”`;
  if (value === "Board umbenennen") return "Rename artboard";
  if (value === "Hintergrund ändern") return "Change background";
  if (value.startsWith("Kostenpflichtige Bildgenerierung ")) return value.replace("Kostenpflichtige Bildgenerierung", "Prepare paid image generation").replace(" vorbereiten", "");
  if (value === "Bildgenerierungen werden nicht automatisch gestartet und benötigen eine separate Kostenbestätigung.") return "Image generations are not started automatically and require separate cost confirmation.";
  if (value === "Keine Artboard-Änderungen vorgeschlagen.") return "No artboard changes proposed.";
  return value;
}

function ProposalReview({ proposal, stale, applying, onApply, onReject }: { proposal: NonNullable<ReturnType<ArtboardAgentController["getSnapshot"]>["proposal"]>; stale?: string; applying: boolean; onApply: () => void; onReject: () => void }) {
  const {locale,t}=useI18n();
  const hasDirectChanges = proposal.batch.operations.length > 0;
  return <section className="aau-proposal" aria-label={t('agent.reviewProposal')}>
    <header><span><Sparkles size={14} /><strong>{t('agent.review')}</strong></span><small>{t('agent.changes',{count:proposal.changes.length})}</small></header>
    <p>{localizedProposalText(proposal.summary, locale)}</p>
    <div className="aau-diff">
      {proposal.changes.map((change) => <article key={change.id} className={`is-${change.kind}`}><i>{change.kind === "add" ? "+" : change.kind === "remove" ? "−" : "~"}</i><span><strong>{localizedProposalText(change.label, locale)}</strong>{change.boardName ? <small>{change.boardName}</small> : null}{change.before || change.after ? <em>{change.before ? <del>{change.before}</del> : null}{change.after ? <ins>{change.after}</ins> : null}</em> : null}</span></article>)}
    </div>
    {proposal.warnings?.map((warning) => <div className="aau-proposal-warning" key={warning}><AlertCircle size={12} />{localizedProposalText(warning, locale)}</div>)}
    {stale ? <div className="aau-proposal-warning"><AlertCircle size={12} />{stale}</div> : null}
    <footer><button type="button" onClick={onReject} disabled={applying}>{t('agent.reject')}</button><button type="button" className="is-primary" onClick={onApply} disabled={applying || Boolean(stale) || !hasDirectChanges}>{applying ? <LoaderCircle size={13} className="aau-spin" /> : <Check size={13} />}{applying ? t('agent.applying') : hasDirectChanges ? t('agent.apply') : t('agent.noDirectChanges')}</button></footer>
  </section>;
}

function PaidFollowUpNotice({ intents,proposalId,onDismiss,onConfirm,onProposal,onOpenSettings }: { intents: NonNullable<ResolvedArtboardProposal["followUpIntents"]>;proposalId:string; onDismiss?: () => void;onConfirm?:ArtboardDesignAgentProps["onConfirmFollowUp"];onProposal?:(proposal:ResolvedArtboardProposal)=>void;onOpenSettings?:()=>void }) {
  const {t}=useI18n();
  const [selected,setSelected]=useState<NonNullable<ResolvedArtboardProposal["followUpIntents"]>[number]>();
  return <section className="aau-paid-follow-up" aria-label={t('agent.paidFollowUpTitle')}>
    <header><CircleDollarSign size={14} /><strong>{t('agent.paidFollowUpTitle')}</strong>{onDismiss ? <button type="button" className="aau-icon" onClick={onDismiss} aria-label={t('agent.dismissPaidFollowUp')}><X size={13} /></button> : null}</header>
    <p>{t('agent.paidFollowUpUnavailable')}</p>
    {intents.map((intent) => <article key={intent.id}>
      <strong>{intent.role}</strong>
      <span>{t('agent.paidFollowUpInput',{ratio:intent.aspectRatio,references:intent.referenceBindingIds.length})}</span>
      <small>{intent.prompt}</small>
      {onConfirm?<button type="button" onClick={()=>setSelected(intent)}>{t('agent.paidFollowUpConfigure')}</button>:<em>{t('agent.paidFollowUpMissingEndpoint')}</em>}
    </article>)}
    {selected&&onConfirm?<PaidImageDialog intent={selected} proposalId={proposalId} confirm={onConfirm} onProposal={(proposal)=>{onProposal?.(proposal);setSelected(undefined);onDismiss?.();}} onClose={()=>setSelected(undefined)} onOpenSettings={onOpenSettings}/>:null}
  </section>;
}

function PaidImageDialog({intent,proposalId,confirm,onProposal,onClose,onOpenSettings}:{intent:NonNullable<ResolvedArtboardProposal["followUpIntents"]>[number];proposalId:string;confirm:NonNullable<ArtboardDesignAgentProps["onConfirmFollowUp"]>;onProposal:(proposal:ResolvedArtboardProposal)=>void;onClose:()=>void;onOpenSettings?:()=>void}){
  const {t}=useI18n(),models=FAL_IMAGE_MODELS.filter((model)=>intent.referenceBindingIds.length===0||Boolean(model.editEndpoint));
  const [modelId,setModelId]=useState(models[0]?.id??""),model=falImageModel(modelId);
  const [config,setConfig]=useState<FalImageConfig>(()=>model?{...defaultFalImageConfig(model),aspectRatio:intent.aspectRatio}:({size:"",aspectRatio:intent.aspectRatio,outputFormat:"png",variants:1}));
  const [running,setRunning]=useState(false),[error,setError]=useState<string>();const controller=useRef<AbortController|undefined>(undefined);
  const endpoint=model?falImageEndpoint(model,intent.referenceBindingIds.length):undefined;
  const errors=model?validateFalImageConfig(model,config,intent.referenceBindingIds.length,intent.prompt):["missing"];
  const official=model?estimateFalImageCost({model,endpoint,config,referenceCount:intent.referenceBindingIds.length,prompt:intent.prompt}):({state:"unavailable",reason:"configuration-conflict"} as const);
  const context=model&&endpoint?falImageCostContext({model,endpoint,config,referenceCount:intent.referenceBindingIds.length}):undefined;
  const estimate=useFalCostDisplay(official,endpoint,model?.schemaHash,context);
  const run=async()=>{if(!model||errors.length||estimate.state==="unavailable"||running)return;setRunning(true);setError(undefined);const active=new AbortController();controller.current=active;try{onProposal(await confirm(intent,proposalId,model.id,config,active.signal));}catch(reason){if(!active.signal.aborted)setError(reason instanceof Error?reason.message:String(reason));}finally{setRunning(false);controller.current=undefined;}};
  return <div className="aau-paid-backdrop" role="presentation"><section className="aau-paid-dialog" role="dialog" aria-modal="true" aria-labelledby={`paid-${intent.id}`}>
    <header><strong id={`paid-${intent.id}`}>{t('agent.paidFollowUpConfigure')}</strong><button type="button" className="aau-icon" aria-label={t('common.close')} onClick={onClose} disabled={running}><X size={14}/></button></header>
    <p>{intent.prompt}</p>
    <label>{t('agent.paidModel')}<CustomSelect label={t('agent.paidModel')} searchable value={modelId} options={models.map((item)=>({value:item.id,label:item.label}))} onChange={(value)=>{const next=falImageModel(value);if(next){setModelId(value);setConfig({...defaultFalImageConfig(next),aspectRatio:intent.aspectRatio});}}}/></label>
    {model?<><label>{t('agent.paidSize')}<CustomSelect label={t('agent.paidSize')} value={config.size} options={model.sizes.map((value)=>({value,label:formatImageSizeLabel(value)}))} onChange={(size)=>setConfig((value)=>({...value,size}))}/></label><label>{t('agent.paidFormat')}<CustomSelect label={t('agent.paidFormat')} value={config.outputFormat} options={model.formats.map((value)=>({value,label:value.toUpperCase()}))} onChange={(outputFormat)=>setConfig((value)=>({...value,outputFormat}))}/></label>{(model.background as readonly string[]).includes("transparent")?<label className="check-control"><input type="checkbox" checked={config.background==="transparent"} onChange={(event)=>setConfig((value)=>({...value,background:event.currentTarget.checked?"transparent":"auto",outputFormat:event.currentTarget.checked?"png":value.outputFormat}))}/><span>{t('agent.paidTransparency')}</span></label>:null}</>:null}
    {endpoint?<div className="aau-provider-note"><span>{endpoint}</span><small>{model?.schemaHash}</small></div>:null}<FalCostEstimateView estimate={estimate}/>{running?<div className="aau-paid-progress" role="progressbar" aria-label={t('agent.paidRunning')} aria-valuetext={t('agent.paidRunning')}><i/></div>:null}{errors.length?<div role="alert" className="aau-error">{errors.join(" ")}</div>:null}{error?<div role="alert" className="aau-error">{localizeErrorMessage(error)}</div>:null}
    <footer>{error&&onOpenSettings?<button type="button" onClick={onOpenSettings}>{t('agent.openSettings')}</button>:null}<button type="button" onClick={onClose} disabled={running}>{t('agent.back')}</button><button type="button" className="is-primary" disabled={running||errors.length>0||estimate.state==="unavailable"} onClick={()=>void run()}>{running?<LoaderCircle className="aau-spin" size={13}/>:<CircleDollarSign size={13}/>} {running?t('agent.paidRunning'):t('agent.paidConfirm')}</button>{running?<button type="button" onClick={()=>controller.current?.abort()}>{t('agent.stop')}</button>:null}</footer>
  </section></div>;
}
