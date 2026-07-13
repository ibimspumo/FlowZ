import {
  ArrowLeft, BoxSelect, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Copy, Download, Eye, EyeOff,
  Frame, Group, Image, Layers3, Lock, Plus, Redo2, RotateCcw, Ungroup,
  Shapes, Sparkles, Trash2, Type, Undo2, Unlock, X, ZoomIn, ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type WheelEvent as ReactWheelEvent } from "react";
import { CustomSelect } from "../components/CustomSelect";
import { DeferredFontPicker } from "../components/DeferredFontPicker";
import { ARTBOARD_FORMATS, type ArtboardLayer, type ArtboardPreset } from "../nodes/brand/artboard-domain";
import { renderArtboardSvg } from "../nodes/brand/artboard-renderer";
import { ArtboardCanvas } from "./ArtboardCanvas";
import { loadArtboardFont } from "./artboard-fonts";
import { clampLayerGeometry, compareBoardIds, operationBatch, orderedBoardSelection, ungroupLayerTree } from "./operations";
import type { ArtboardWorkspaceOperation, ArtboardWorkspaceProps, SelectedLayer, WorkspacePanel } from "./types";
import { ARTBOARD_PRESET_OPTIONS } from "./types";
import { formatNumber, useI18n } from "../i18n";
import { ArtboardDesignAgent } from "../artboard-agent-ui";
import { fitAgentCanvasFeedback, type AgentCanvasFeedback } from "../artboard-agent-ui/canvas-feedback";
import { artboardZoomShortcut, clampArtboardZoom, fitCanvasRectangles, isFormEditingTarget, panByWheel, zoomAtCanvasPoint } from "./canvas-navigation";
import "./artboard-workspace.css";

export function shouldHandleArtboardCanvasShortcut(key: string, insideCanvas: boolean, interactive: boolean) {
  return key !== "Tab" && insideCanvas && !interactive;
}

const percent = (zoom: number) => `${formatNumber(Math.round(zoom * 100))} %`;
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const boundedNumber=(value:string,min:number,max:number)=>Math.min(max,Math.max(min,Number(value)||0));

export function ArtboardWorkspace(props: ArtboardWorkspaceProps) {
  const {t}=useI18n();
  const [zoom, setZoom] = useState(.35);
  const [pan, setPan] = useState({ x: 96, y: 76 });
  const [panel, setPanel] = useState<WorkspacePanel>("layers");
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [selectedLayer, setSelectedLayer] = useState<SelectedLayer>();
  const [compare, setCompare] = useState(false);
  const [workspaceName, setWorkspaceName] = useState(props.workspace.name);
  const [agentCanvasFeedback, setAgentCanvasFeedback] = useState<AgentCanvasFeedback>();
  const [agentViewportTransition, setAgentViewportTransition] = useState(false);
  const [confirmDeleteBoardId, setConfirmDeleteBoardId] = useState<string>();
  const canvasViewportRef = useRef<HTMLDivElement>(null);
  const lastAgentFitRef = useRef("");
  const viewportTransitionTimerRef = useRef<number | undefined>(undefined);
  const imageInputRef=useRef<HTMLInputElement>(null);
  const activeBoard = props.workspace.boards[props.workspace.activeBoardId];
  const selectedBoardIds = props.workspace.selectedBoardIds;
  const comparison = useMemo(() => compareBoardIds(props.workspace), [props.workspace]);
  const activeLayer = selectedLayer && props.workspace.boards[selectedLayer.boardId]?.document.layers[selectedLayer.layerId];
  const agentSelection = useMemo(() => ({
    activeBoardId: props.workspace.activeBoardId,
    boardIds: selectedBoardIds.length ? selectedBoardIds : [props.workspace.activeBoardId],
    layerIds: selectedLayer ? [selectedLayer.layerId] : [],
  }), [props.workspace.activeBoardId, selectedBoardIds, selectedLayer]);

  const commit = useCallback((operations: ArtboardWorkspaceOperation[], prefix?: string) => {
    if (operations.length) void props.onApplyOperations(operationBatch(props.revision, operations, prefix));
  }, [props]);
  const setCanvasViewport = useCallback((viewport: { zoom: number; pan: { x: number; y: number } }, animate = false) => {
    if (viewportTransitionTimerRef.current !== undefined) window.clearTimeout(viewportTransitionTimerRef.current);
    const reducedMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setAgentViewportTransition(animate && !reducedMotion);
    setZoom(clampArtboardZoom(viewport.zoom));
    setPan(viewport.pan);
    if (animate && !reducedMotion) viewportTransitionTimerRef.current = window.setTimeout(() => {
      viewportTransitionTimerRef.current = undefined;
      setAgentViewportTransition(false);
    }, 240);
  }, []);
  const zoomAroundCanvasCenter = useCallback((nextZoom: number) => {
    const rect = canvasViewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    setCanvasViewport(zoomAtCanvasPoint({ zoom, pan }, nextZoom, { x: rect.width / 2, y: rect.height / 2 }));
  }, [pan, setCanvasViewport, zoom]);
  const fitAllBoards = useCallback(() => {
    const rect = canvasViewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const rectangles = Object.values(props.workspace.boards).flatMap((board) => {
      const placement = props.workspace.placements[board.id];
      return placement ? [{ ...placement, width: board.document.format.width, height: board.document.format.height }] : [];
    });
    for (const ghost of agentCanvasFeedback?.ghostBoards ?? []) rectangles.push({ ...ghost.placement, width: ghost.format.width, height: ghost.format.height });
    const fitted = fitCanvasRectangles(rectangles, rect, { margin: 48, rightInset: agentCanvasFeedback && rect.width >= 1000 ? 452 : 48, maxZoom: 1 });
    if (fitted) setCanvasViewport(fitted, true);
  }, [agentCanvasFeedback, props.workspace.boards, props.workspace.placements, setCanvasViewport]);
  useEffect(() => setWorkspaceName(props.workspace.name), [props.workspace.name]);
  useEffect(() => setConfirmDeleteBoardId(undefined), [props.workspace.activeBoardId]);
  useEffect(() => props.agent?.onSelectionChange(agentSelection), [props.agent, agentSelection]);
  useEffect(() => {
    if (!agentCanvasFeedback || agentCanvasFeedback.phase !== "preview" || agentCanvasFeedback.renderError) return;
    const fitKey = agentCanvasFeedback.ghostBoards.map((ghost) => `${ghost.id}:${ghost.format.width}x${ghost.format.height}:${ghost.placement.x},${ghost.placement.y}`).join("|");
    if (!fitKey || fitKey === lastAgentFitRef.current) return;
    const viewport = canvasViewportRef.current?.getBoundingClientRect();
    if (!viewport) return;
    const fit = fitAgentCanvasFeedback(agentCanvasFeedback, props.workspace, viewport);
    if (!fit) return;
    lastAgentFitRef.current = fitKey;
    setCanvasViewport(fit, true);
  }, [agentCanvasFeedback, props.workspace, setCanvasViewport]);
  useEffect(() => () => { if (viewportTransitionTimerRef.current !== undefined) window.clearTimeout(viewportTransitionTimerRef.current); }, []);
  const selectBoard = (boardId: string, additive: boolean) => {
    const selection = orderedBoardSelection(props.workspace, boardId, additive);
    props.onSelectionChange(selection.activeBoardId, selection.selectedBoardIds);
    if (!additive) setSelectedLayer(undefined);
  };
  const updateLayer = (patch: Partial<ArtboardLayer>) => {
    if (!selectedLayer || !activeLayer) return;
    commit([{ type: "update-layer", ...selectedLayer, patch: { ...patch, version: activeLayer.version + 1 } as Partial<ArtboardLayer> }], "inspector");
  };
  const addLayer = (type: "text" | "shape" | "container") => {
    if (!activeBoard) return;
    const id = nextId(type);
    const base = { id, name: type === "text" ? t('artboard.text') : type==="container"?t('artboard.container'):t('artboard.shape'), locked: false, visible: true, version: 1, geometry: { x: 80, y: 80, width: Math.min(560, activeBoard.document.format.width - 160), height: type === "text" ? 150 : 300, rotation: 0 } };
    const layer: ArtboardLayer = type === "text"
      ? { ...base, type: "text", text: t('artboard.editText'), color: "#111111", fontSize: 72, align: "left" }
      : type==="container"?{...base,type:"container",childIds:[],layout:{mode:"flex",direction:"column",gap:16,padding:24,justify:"start",align:"stretch"},fill:{kind:"solid",color:"#242126"},style:{borderRadius:16}}
      : { ...base, type: "shape", shape: "rectangle", fill: { kind: "solid", color: "#EE3399" } };
    if(activeLayer?.type==="container"){
      const nested={...layer,geometry:{...layer.geometry,x:0,y:0,width:Math.min(layer.geometry.width,activeLayer.geometry.width-activeLayer.layout.padding*2),height:Math.min(layer.geometry.height,activeLayer.geometry.height-activeLayer.layout.padding*2)}} as ArtboardLayer;
      commit([{type:"set-layer-tree",boardId:activeBoard.id,rootLayerIds:[...activeBoard.document.rootLayerIds],layers:{...activeBoard.document.layers,[activeLayer.id]:{...activeLayer,childIds:[...activeLayer.childIds,id],version:activeLayer.version+1},[id]:nested}}],"create-nested-layer");
    }else commit([{ type: "create-layer", boardId: activeBoard.id, layer, rootIndex: activeBoard.document.rootLayerIds.length }], "create-layer");
    setSelectedLayer({ boardId: activeBoard.id, layerId: id });
  };
  const nudge = (key: string, shift: boolean) => {
    if (!activeLayer || !selectedLayer || activeLayer.locked) return;
    const step = shift ? 10 : 1;
    const geometry = clampLayerGeometry(activeLayer, { x: activeLayer.geometry.x + (key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0), y: activeLayer.geometry.y + (key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0) }, props.workspace.boards[selectedLayer.boardId].document.format);
    updateLayer({ geometry } as Partial<ArtboardLayer>);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const inCanvas = Boolean(target.closest?.(".awb-canvas"));
      const zoomShortcut = artboardZoomShortcut(event);
      if (zoomShortcut && inCanvas && !isFormEditingTarget(target)) {
        event.preventDefault();
        if (zoomShortcut === "fit") fitAllBoards();
        else zoomAroundCanvasCenter(zoom * (zoomShortcut === "in" ? 1.25 : .8));
        return;
      }
      const interactive = Boolean(target.closest?.("input,textarea,select,button,a,[contenteditable=true],[role=dialog],[role=listbox]"));
      // Native Tab order must always remain available across toolbar, layers,
      // inspector and agent. Canvas shortcuts are deliberately scoped to the
      // focused canvas surface instead of being global window shortcuts.
      if (!shouldHandleArtboardCanvasShortcut(event.key, inCanvas, interactive)) return;
      if (event.key === "Escape") { setSelectedLayer(undefined); setCompare(false); }
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) && selectedLayer) { event.preventDefault(); nudge(event.key, event.shiftKey); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? props.onRedo() : props.onUndo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fitAllBoards, props, selectedLayer, zoom, zoomAroundCanvasCenter]);

  const setPreset = (preset: ArtboardPreset) => {
    if (!activeBoard || preset === activeBoard.document.format.preset) return;
    const dimensions = ARTBOARD_FORMATS[preset];
    const format = { preset, width: dimensions.width, height: dimensions.height };
    commit([{ type: "set-board-format", boardId: activeBoard.id, format }], "format");
  };
  const exportIds = selectedBoardIds.length ? selectedBoardIds : [props.workspace.activeBoardId];

  return <main className={`awb-shell ${leftOpen ? "has-left" : ""} ${rightOpen ? "has-right" : ""}`} aria-busy={props.isBusy || undefined}>
    <header className="awb-topbar">
      <button type="button" className="awb-icon-button" onClick={props.onBack} aria-label={t('artboard.back')}><ArrowLeft size={16} /></button>
      <input
        className="awb-document-name"
        aria-label={t('artboard.documentName')}
        value={workspaceName}
        onChange={(event) => setWorkspaceName(event.currentTarget.value)}
        onBlur={(event) => { const name = event.currentTarget.value.trim(); if (!name) setWorkspaceName(props.workspace.name); else if (name !== props.workspace.name) commit([{ type: "rename-workspace", name }], "rename"); }}
      />
      <span className="awb-divider" />
      <button type="button" className="awb-icon-button" onClick={() => props.onCreateBoard(activeBoard?.document.format.preset ?? "instagram-post", activeBoard?.id)} aria-label={t('artboard.new')}><Plus size={15} /></button>
      <button type="button" className="awb-icon-button" disabled={!props.canUndo} onClick={props.onUndo} aria-label={t('artboard.undo')}><Undo2 size={15} /></button>
      <button type="button" className="awb-icon-button" disabled={!props.canRedo} onClick={props.onRedo} aria-label={t('artboard.redo')}><Redo2 size={15} /></button>
      <div className="awb-zoom" aria-label={t('artboard.zoom')}>
        <button type="button" onClick={() => zoomAroundCanvasCenter(zoom * .8)} aria-label={t('artboard.zoomOut')}><ZoomOut size={14} /></button>
        <output>{percent(zoom)}</output>
        <button type="button" onClick={() => zoomAroundCanvasCenter(zoom * 1.25)} aria-label={t('artboard.zoomIn')}><ZoomIn size={14} /></button>
      </div>
      <span className="awb-topbar-spacer" />
      <button type="button" className={`awb-button ${compare ? "is-active" : ""}`} disabled={!comparison.length} onClick={() => setCompare((value) => !value)}><BoxSelect size={14} />{t('artboard.compare')}</button>
      <button type="button" className="awb-button awb-button-primary" onClick={() => props.onExport(exportIds)}><Download size={14} />{t('artboard.export')}</button>
    </header>

    {leftOpen ? <aside className="awb-left-panel" aria-label={t('artboard.tools')}>
      <nav className="awb-panel-tabs" aria-label={t('artboard.toolAreas')}>
        {([ ["layers", <Layers3 size={14} />, t('artboard.layers')], ["assets", <Image size={14} />, t('artboard.assets')], ["inputs", <RotateCcw size={14} />, t('artboard.inputs')] ] as const).map(([id, icon, label]) => <button key={id} type="button" className={panel === id ? "is-active" : ""} aria-pressed={panel === id} onClick={() => setPanel(id)}>{icon}<span>{label}</span></button>)}
      </nav>
      <div className="awb-panel-heading"><strong>{panel === "layers" ? t('artboard.layers') : panel === "assets" ? t('artboard.assets') : t('artboard.linkedInputs')}</strong><button type="button" className="awb-icon-button" onClick={() => setLeftOpen(false)} aria-label={t('artboard.closeLeftPanel')}><ChevronLeft size={14} /></button></div>
      {panel === "layers" ? <LayerPanel board={activeBoard} selected={selectedLayer} onSelect={setSelectedLayer} onCommit={commit} onAdd={addLayer} /> : null}
      {panel === "assets" ? <AssetPanel assets={props.assets ?? []} total={props.assetTotal??0} loading={props.assetsLoading} onMore={props.onLoadMoreAssets} onUse={(asset)=>props.onInsertAsset?.(asset)} onImport={()=>imageInputRef.current?.click()} /> : null}
      {panel === "inputs" ? <InputPanel board={activeBoard} update={activeBoard ? props.upstreamUpdates?.[activeBoard.id] : undefined} onIgnore={() => activeBoard && props.upstreamUpdates?.[activeBoard.id] && props.onIgnoreUpstreamUpdate(activeBoard.id,props.upstreamUpdates[activeBoard.id])} onUpdate={() => activeBoard && props.upstreamUpdates?.[activeBoard.id] && props.onUpdateBoardInputs(activeBoard.id, props.upstreamUpdates[activeBoard.id])} onVariant={() => activeBoard && props.onCreateVariant(activeBoard.id, props.upstreamUpdates?.[activeBoard.id])} onLink={props.onBack} /> : null}
    </aside> : <button type="button" className="awb-panel-reveal awb-panel-reveal-left" onClick={() => setLeftOpen(true)} aria-label={t('artboard.openTools')}><ChevronRight size={15} /></button>}

    <input ref={imageInputRef} className="visually-hidden" type="file" accept="image/*" onChange={(event)=>{const file=event.currentTarget.files?.[0];if(file)void props.onImportImage?.(file);event.currentTarget.value="";}} />
    <ArtboardCanvas workspace={props.workspace} zoom={zoom} pan={pan} selectedLayer={selectedLayer} resolveAsset={props.resolveAsset ?? ((hash) => `flowz-media:${hash}`)} agentFeedback={agentCanvasFeedback} viewportRef={canvasViewportRef} viewportTransition={agentViewportTransition} onSelectBoard={selectBoard} onSelectLayer={(selection) => { setSelectedLayer(selection); if (selection) setRightOpen(true); }} onCommit={commit} onPan={setPan} onViewport={(viewport)=>setCanvasViewport(viewport)} onDropAsset={(versionId,destination)=>{const asset=props.assets?.find((item)=>item.versionId===versionId);if(asset)props.onInsertAsset?.(asset,destination);}} onDropImage={(file,destination)=>void props.onImportImage?.(file,destination)} />

    {rightOpen ? <aside className="awb-inspector" aria-label={t('artboard.properties')}>
      <div className="awb-panel-heading"><strong>{activeLayer ? activeLayer.name : activeBoard?.name ?? t('artboard.properties')}</strong><button type="button" className="awb-icon-button" onClick={() => setRightOpen(false)} aria-label={t('artboard.closeInspector')}><ChevronRight size={14} /></button></div>
      <Inspector board={activeBoard} layer={activeLayer} onBoardName={(name) => activeBoard && commit([{ type: "rename-board", boardId: activeBoard.id, name }], "board-name")} onBoardPreset={setPreset} onBoardColor={(color) => activeBoard && commit([{ type: "set-board-paint", boardId: activeBoard.id, color }], "board-color")} onLayer={updateLayer} />
      {activeBoard ? <div className="awb-inspector-actions">
        <button type="button" className="awb-button" onClick={() => props.onDuplicateBoard(activeBoard.id)}><Copy size={13} />{t('artboard.duplicate')}</button>
        <button type="button" className="awb-button" onClick={() => props.onCreateVariant(activeBoard.id)}><Sparkles size={13} />{t('artboard.newVariant')}</button>
        {confirmDeleteBoardId === activeBoard.id ? <div className="awb-board-delete-confirm" role="alertdialog" aria-label={t('artboard.deleteBoardConfirm',{name:activeBoard.name})}>
          <p>{t('artboard.deleteBoardConfirm',{name:activeBoard.name})}</p>
          <button type="button" className="awb-button" onClick={() => setConfirmDeleteBoardId(undefined)}>{t('common.cancel')}</button>
          <button type="button" className="awb-button is-danger" onClick={() => { commit([{type:"delete-board",boardId:activeBoard.id}],"delete-board"); setSelectedLayer(undefined); setConfirmDeleteBoardId(undefined); }}>{t('artboard.deleteBoard')}</button>
        </div> : <button type="button" className="awb-button is-danger awb-board-delete" disabled={Object.keys(props.workspace.boards).length <= 1} title={Object.keys(props.workspace.boards).length <= 1 ? t('artboard.deleteLastBoard') : undefined} onClick={() => setConfirmDeleteBoardId(activeBoard.id)}><Trash2 size={13}/>{t('artboard.deleteBoard')}</button>}
      </div> : null}
    </aside> : <button type="button" className="awb-panel-reveal awb-panel-reveal-right" onClick={() => setRightOpen(true)} aria-label={t('artboard.openInspector')}><ChevronLeft size={15} /></button>}

    {props.agent ? <ArtboardDesignAgent
      workspace={props.workspace} branchId={props.agent.branchId} revision={props.revision} selection={agentSelection}
      adapterFactory={props.agent.adapterFactory} toolExecutor={props.agent.toolExecutor} resolveProposal={props.agent.resolveProposal}
      prepareContext={props.agent.prepareContext} onApplyProposal={props.agent.onApplyProposal}
      onOpenProviderSettings={() => props.agent?.onOpenProviderSettings?.()}
      onOpenFalSettings={props.agent.onOpenFalSettings}
      pendingFollowUps={props.agent.pendingFollowUps} pendingFollowUpProposalId={props.agent.pendingFollowUpProposalId} onConfirmFollowUp={props.agent.onConfirmFollowUp} onDismissFollowUps={props.agent.onDismissFollowUps}
      onCanvasFeedback={setAgentCanvasFeedback}
    /> : null}

    {compare && comparison.length ? <CompareStrip workspace={props.workspace} boardIds={comparison} resolveAsset={props.resolveAsset ?? ((hash) => `flowz-media:${hash}`)} onClose={() => setCompare(false)} /> : null}
  </main>;
}

function LayerPanel({ board, selected, onSelect, onCommit, onAdd }: { board: ArtboardWorkspaceProps["workspace"]["boards"][string] | undefined; selected?: SelectedLayer; onSelect: (value?: SelectedLayer) => void; onCommit: (operations: ArtboardWorkspaceOperation[]) => void; onAdd: (type: "text" | "shape" | "container") => void }) {
  const {t}=useI18n();
  const [marked,setMarked]=useState<string[]>([]);
  if (!board) return <div className="awb-empty">{t('artboard.chooseBoard')}</div>;
  const layers: Array<{layer:ArtboardLayer;depth:number}> = [];
  const append=(ids:readonly string[],depth:number)=>[...ids].reverse().forEach((id)=>{const layer=board.document.layers[id];if(!layer)return;layers.push({layer,depth});if(layer.type==="group"||layer.type==="container")append(layer.childIds,depth+1);});
  append(board.document.rootLayerIds,0);
  const group=()=>{const ids=board.document.rootLayerIds.filter((id)=>marked.includes(id));if(ids.length<2)return;const chosen=ids.map((id)=>board.document.layers[id]);const id=`group-${crypto.randomUUID()}`;const x=Math.min(...chosen.map((item)=>item.geometry.x)),y=Math.min(...chosen.map((item)=>item.geometry.y)),right=Math.max(...chosen.map((item)=>item.geometry.x+item.geometry.width)),bottom=Math.max(...chosen.map((item)=>item.geometry.y+item.geometry.height));const rootLayerIds=board.document.rootLayerIds.filter((item)=>!ids.includes(item));rootLayerIds.splice(Math.min(...ids.map((item)=>board.document.rootLayerIds.indexOf(item))),0,id);onCommit([{type:"set-layer-tree",boardId:board.id,rootLayerIds,layers:{...board.document.layers,[id]:{id,type:"group",name:t('artboard.group'),locked:false,visible:true,version:1,geometry:{x,y,width:right-x,height:bottom-y,rotation:0},childIds:ids}}}]);setMarked([]);onSelect({boardId:board.id,layerId:id});};
  const ungroup=()=>{if(!selected)return;const item=board.document.layers[selected.layerId];if(item?.type!=="group")return;const tree=ungroupLayerTree({schemaVersion:1,id:"ui",name:"UI",boards:{[board.id]:board},placements:{[board.id]:{x:0,y:0}},selectedBoardIds:[board.id],activeBoardId:board.id,pasteboard:{margin:0,gap:0,grid:1}},board.id,item.id);onCommit([{type:"set-layer-tree",boardId:board.id,...tree}]);onSelect(undefined);};
  return <><div className="awb-add-row"><button type="button" onClick={()=>onAdd("text")}><Type size={13}/>{t('artboard.text')}</button><button type="button" onClick={()=>onAdd("shape")}><Shapes size={13}/>{t('artboard.shape')}</button><button type="button" onClick={()=>onAdd("container")}><Frame size={13}/>{t('artboard.container')}</button><button type="button" disabled={marked.length<2} onClick={group}><Group size={13}/>{t('artboard.group')}</button><button type="button" disabled={board.document.layers[selected?.layerId??""]?.type!=="group"} onClick={ungroup}><Ungroup size={13}/>{t('artboard.ungroup')}</button></div><div className="awb-layer-list">{layers.map(({layer,depth})=><div key={layer.id} className={selected?.layerId===layer.id?"is-active":""} style={{paddingLeft:depth*12}}><input type="checkbox" checked={marked.includes(layer.id)} onChange={()=>setMarked((current)=>current.includes(layer.id)?current.filter((id)=>id!==layer.id):[...current,layer.id])} aria-label={t('artboard.markLayer',{name:layer.name})}/><button type="button" className="awb-layer-name" onClick={()=>onSelect({boardId:board.id,layerId:layer.id})}>{layer.type==="text"?<Type size={13}/>:layer.type==="image"?<Image size={13}/>:layer.type==="group"?<Group size={13}/>:layer.type==="container"?<Frame size={13}/>:<Shapes size={13}/>}<span>{layer.name}</span></button><button type="button" aria-label={t('artboard.forward',{name:layer.name})} onClick={()=>onCommit([{type:"reorder-layer",boardId:board.id,layerId:layer.id,direction:"forward"}])}><ChevronUp size={12}/></button><button type="button" aria-label={t('artboard.backward',{name:layer.name})} onClick={()=>onCommit([{type:"reorder-layer",boardId:board.id,layerId:layer.id,direction:"backward"}])}><ChevronDown size={12}/></button><button type="button" aria-label={t(layer.visible?'artboard.hide':'artboard.show',{name:layer.name})} onClick={()=>onCommit([{type:"update-layer",boardId:board.id,layerId:layer.id,patch:{visible:!layer.visible,version:layer.version+1} as Partial<ArtboardLayer>}])}>{layer.visible?<Eye size={13}/>:<EyeOff size={13}/>}</button><button type="button" aria-label={t(layer.locked?'artboard.unlock':'artboard.lock',{name:layer.name})} onClick={()=>onCommit([{type:"update-layer",boardId:board.id,layerId:layer.id,patch:{locked:!layer.locked,version:layer.version+1} as Partial<ArtboardLayer>}])}>{layer.locked?<Lock size={13}/>:<Unlock size={13}/>}</button><button type="button" aria-label={t('artboard.deleteLayer',{name:layer.name})} onClick={()=>{onCommit([{type:"delete-layers",boardId:board.id,layerIds:[layer.id]}]);if(selected?.layerId===layer.id)onSelect(undefined);}}><Trash2 size={12}/></button></div>)}</div></>;
}

function AssetPanel({ assets,total,loading,onMore,onUse,onImport }: { assets: NonNullable<ArtboardWorkspaceProps["assets"]>;total:number;loading?:boolean;onMore?:()=>void;onUse:(asset:NonNullable<ArtboardWorkspaceProps["assets"]>[number])=>void;onImport:()=>void }) {
  const {t}=useI18n();
  if (!assets.length) return <div className="awb-empty"><Image size={20} /><strong>{t('artboard.noAssets')}</strong><span>{t('artboard.assetsHint')}</span><button type="button" className="awb-button" onClick={onImport}>{t('artboard.importImage')}</button></div>;
  return <><div className="awb-asset-toolbar"><button type="button" className="awb-button" onClick={onImport}>{t('artboard.importImage')}</button></div><div className="awb-asset-grid">{assets.map((asset) => <button type="button" key={asset.versionId} draggable onDragStart={(event)=>{event.dataTransfer.effectAllowed="copy";event.dataTransfer.setData("application/x-flowz-artboard-asset",asset.versionId);}} onClick={()=>onUse(asset)} aria-label={t('artboard.useAsset',{name:asset.name})}>{asset.previewUrl ? <img src={asset.previewUrl} alt="" loading="lazy" /> : asset.kind === "font" ? <Type size={21} /> : <Frame size={21} />}<span>{asset.name}</span></button>)}{assets.length<total?<button type="button" disabled={loading} onClick={onMore}>{loading?t('common.loading'):t('assets.loadMore',{current:assets.length,total})}</button>:null}</div></>;
}

function InputPanel({ board, update, onIgnore, onUpdate, onVariant,onLink }: { board?: ArtboardWorkspaceProps["workspace"]["boards"][string]; update?: NonNullable<ArtboardWorkspaceProps["upstreamUpdates"]>[string]; onIgnore: () => void; onUpdate: () => void; onVariant: () => void;onLink:()=>void }) {
  const {t}=useI18n();
  if (!board) return <div className="awb-empty">{t('artboard.chooseBoard')}</div>;
  const bindings = Object.values(board.inputSnapshot.bindings);
  return <div className="awb-inputs">{update ? <section className="awb-update-notice"><strong>{t('artboard.newInputs')}</strong><p>{t('artboard.inputDecision')}</p><div><button type="button" onClick={onIgnore}>{t('artboard.ignore')}</button><button type="button" onClick={onUpdate}>{t('artboard.update')}</button><button type="button" className="is-primary" onClick={onVariant}>{t('artboard.asVariant')}</button></div></section> : null}{bindings.map((binding) => <div key={binding.id}><RotateCcw size={13} /><span><strong>{binding.source.portId}</strong><small>{binding.mode === "pinned" ? t('artboard.pinned') : t('artboard.liveBinding')}</small></span></div>)}{!bindings.length ? <div className="awb-empty"><strong>{t('artboard.noInputs')}</strong><span>{t('artboard.linkFlowHint')}</span><button type="button" className="awb-button" onClick={onLink}>{t('artboard.linkFromFlow')}</button></div> : null}</div>;
}

function PaintEditor({paint,onChange}:{paint:Extract<ArtboardLayer,{type:"shape"|"container"}>["fill"];onChange:(paint:Extract<ArtboardLayer,{type:"shape"|"container"}>["fill"])=>void}){
  const {t}=useI18n();const first=paint.kind==="solid"?paint.color:paint.stops[0].color;const second=paint.kind==="solid"?"#EE3399":paint.stops[1].color;
  return <details className="awb-inspector-section" open><summary>{t('artboard.fill')}</summary><div><CustomSelect label={t('artboard.fillType')} value={paint.kind} options={[{value:"solid",label:t('artboard.solid')},{value:"linear-gradient",label:t('artboard.gradient')}]} onChange={(kind)=>onChange(kind==="solid"?{kind:"solid",color:first}:{kind:"linear-gradient",angle:135,stops:[{color:first,offset:0},{color:second,offset:1}]})}/><div className="awb-field-row"><label>{t('artboard.colorStart')}<input type="color" value={first} onChange={(event)=>onChange(paint.kind==="solid"?{kind:"solid",color:event.currentTarget.value.toUpperCase()}:{...paint,stops:[{...paint.stops[0],color:event.currentTarget.value.toUpperCase()},paint.stops[1]]})}/></label>{paint.kind==="linear-gradient"?<label>{t('artboard.colorEnd')}<input type="color" value={second} onChange={(event)=>onChange({...paint,stops:[paint.stops[0],{...paint.stops[1],color:event.currentTarget.value.toUpperCase()}]})}/></label>:null}</div>{paint.kind==="linear-gradient"?<label>{t('artboard.angle')}<input type="number" min={-360} max={360} value={paint.angle} onChange={(event)=>onChange({...paint,angle:boundedNumber(event.currentTarget.value,-360,360)})}/></label>:null}</div></details>;
}

function StyleEditor({layer,onLayer}:{layer:ArtboardLayer;onLayer:(patch:Partial<ArtboardLayer>)=>void}){
  const {t}=useI18n();const style=layer.style??{};const patch=(value:Partial<NonNullable<ArtboardLayer["style"]>>)=>onLayer({style:{...style,...value}} as Partial<ArtboardLayer>);
  return <details className="awb-inspector-section"><summary>{t('artboard.appearance')}</summary><div><div className="awb-field-row"><label>{t('artboard.opacity')}<input type="number" min={0} max={100} value={Math.round((style.opacity??1)*100)} onChange={(event)=>patch({opacity:boundedNumber(event.currentTarget.value,0,100)/100})}/></label><label>{t('artboard.radius')}<input type="number" min={0} value={style.borderRadius??0} onChange={(event)=>patch({borderRadius:boundedNumber(event.currentTarget.value,0,32768)})}/></label></div><div className="awb-field-row"><label>{t('artboard.border')}<input type="number" min={0} max={256} value={style.border?.width??0} onChange={(event)=>patch({border:{width:boundedNumber(event.currentTarget.value,0,256),color:style.border?.color??"#FFFFFF"}})}/></label><label>{t('artboard.borderColor')}<input type="color" value={style.border?.color??"#FFFFFF"} onChange={(event)=>patch({border:{width:style.border?.width??1,color:event.currentTarget.value.toUpperCase()}})}/></label></div><label>{t('artboard.shadowBlur')}<input type="number" min={0} max={512} value={style.shadow?.blur??0} onChange={(event)=>patch({shadow:{x:style.shadow?.x??0,y:style.shadow?.y??8,blur:boundedNumber(event.currentTarget.value,0,512),color:style.shadow?.color??"#000000",opacity:style.shadow?.opacity??.35}})}/></label></div></details>;
}

function Inspector({ board, layer, onBoardName, onBoardPreset, onBoardColor, onLayer }: { board?: ArtboardWorkspaceProps["workspace"]["boards"][string]; layer?: ArtboardLayer; onBoardName: (name: string) => void; onBoardPreset:(preset:ArtboardPreset)=>void; onBoardColor: (color: string) => void; onLayer: (patch: Partial<ArtboardLayer>) => void }) {
  const {t}=useI18n();
  if (!board) return <div className="awb-empty">{t('artboard.chooseBoard')}</div>;
  if (!layer) return <div className="awb-fields"><label>{t('home.sort.name')}<input value={board.name} onChange={(event) => onBoardName(event.currentTarget.value)} /></label><label>{t('artboard.format')}<CustomSelect label={t('artboard.format')} value={board.document.format.preset} options={ARTBOARD_PRESET_OPTIONS} onChange={(value)=>onBoardPreset(value as ArtboardPreset)}/></label><div className="awb-field-row"><label>{t('artboard.width')}<input value={board.document.format.width} readOnly /></label><label>{t('artboard.height')}<input value={board.document.format.height} readOnly /></label></div><label>{t('artboard.background')}<input type="color" value={board.document.paint.kind==="solid"?board.document.paint.color:board.document.paint.stops[0].color} onChange={(event) => onBoardColor(event.currentTarget.value.toUpperCase())} /></label></div>;
  const geometry = layer.geometry;
  const geometryPatch = (patch: Partial<typeof geometry>) => onLayer({ geometry: clampLayerGeometry(layer, patch, board.document.format) } as Partial<ArtboardLayer>);
  return <div className="awb-fields">
    <label>{t('home.sort.name')}<input value={layer.name} onChange={(event)=>onLayer({name:event.currentTarget.value} as Partial<ArtboardLayer>)}/></label>
    <div className="awb-field-row"><label>X<input type="number" value={Math.round(geometry.x)} onChange={(event)=>geometryPatch({x:Number(event.currentTarget.value)})}/></label><label>Y<input type="number" value={Math.round(geometry.y)} onChange={(event)=>geometryPatch({y:Number(event.currentTarget.value)})}/></label></div>
    <div className="awb-field-row"><label>{t('artboard.width')}<input type="number" value={Math.round(geometry.width)} onChange={(event)=>geometryPatch({width:Number(event.currentTarget.value)})}/></label><label>{t('artboard.height')}<input type="number" value={Math.round(geometry.height)} onChange={(event)=>geometryPatch({height:Number(event.currentTarget.value)})}/></label></div>
    <label>{t('artboard.rotation')}<input type="number" min={-360} max={360} value={Math.round(geometry.rotation)} onChange={(event)=>geometryPatch({rotation:Number(event.currentTarget.value)})}/></label>
    {layer.type==="text"?<><DeferredFontPicker label={t('font.family')} value={layer.fontFamily??"Inter"} axes={layer.fontAxes} onChange={(font)=>{const hash=font.prepared?.blobHash;if(!hash)return;void loadArtboardFont(hash,font.style,font.weight).then(()=>onLayer({fontRef:`font-${hash.slice(0,24)}`,fontFamily:font.family,fontHash:hash,fontWeight:font.weight,fontStyle:font.style==="italic"?"italic":"normal",fontAxes:font.axes} as Partial<ArtboardLayer>));}}/><label>{t('artboard.text')}<textarea value={layer.text} rows={5} onChange={(event)=>onLayer({text:event.currentTarget.value} as Partial<ArtboardLayer>)}/></label><div className="awb-field-row"><label>{t('artboard.fontSize')}<input type="number" value={layer.fontSize} onChange={(event)=>onLayer({fontSize:Number(event.currentTarget.value)} as Partial<ArtboardLayer>)}/></label><label>{t('artboard.color')}<input type="color" value={layer.color} onChange={(event)=>onLayer({color:event.currentTarget.value.toUpperCase()} as Partial<ArtboardLayer>)}/></label></div></>:null}
    {layer.type==="shape"||layer.type==="container"?<PaintEditor paint={layer.fill} onChange={(fill)=>onLayer({fill} as Partial<ArtboardLayer>)}/>:null}
    {layer.type==="container"?<details className="awb-inspector-section" open><summary>{t('artboard.layout')}</summary><div><CustomSelect label={t('artboard.layoutMode')} value={layer.layout.mode} options={[{value:"free",label:t('artboard.free')},{value:"flex",label:"Flex"},{value:"grid",label:"Grid"}]} onChange={(mode)=>onLayer({layout:mode==="free"?{mode:"free",padding:layer.layout.padding}:mode==="grid"?{mode:"grid",columns:2,gap:"gap" in layer.layout?layer.layout.gap:16,padding:layer.layout.padding,align:"stretch"}:{mode:"flex",direction:"column",gap:"gap" in layer.layout?layer.layout.gap:16,padding:layer.layout.padding,justify:"start",align:"stretch"}} as Partial<ArtboardLayer>)}/>{layer.layout.mode==="flex"?<CustomSelect label={t('artboard.direction')} value={layer.layout.direction} options={[{value:"row",label:t('artboard.row')},{value:"column",label:t('artboard.column')}]} onChange={(direction)=>onLayer({layout:{...layer.layout,direction}} as Partial<ArtboardLayer>)}/>:null}{layer.layout.mode==="grid"?<label>{t('artboard.columns')}<input type="number" min={1} max={12} value={layer.layout.columns} onChange={(event)=>onLayer({layout:{...layer.layout,columns:boundedNumber(event.currentTarget.value,1,12)}} as Partial<ArtboardLayer>)}/></label>:null}<div className="awb-field-row"><label>{t('artboard.padding')}<input type="number" min={0} value={layer.layout.padding} onChange={(event)=>onLayer({layout:{...layer.layout,padding:boundedNumber(event.currentTarget.value,0,Math.max(0,Math.floor((Math.min(layer.geometry.width,layer.geometry.height)-1)/2)))}} as Partial<ArtboardLayer>)}/></label>{layer.layout.mode!=="free"?<label>{t('artboard.gap')}<input type="number" min={0} value={layer.layout.gap} onChange={(event)=>onLayer({layout:{...layer.layout,gap:boundedNumber(event.currentTarget.value,0,32768)}} as Partial<ArtboardLayer>)}/></label>:null}</div></div></details>:null}
    {layer.type==="image"?<label>{t('artboard.fit')}<CustomSelect label={t('artboard.imageFit')} value={layer.fit} options={[{value:"cover",label:t('artboard.fitCover')},{value:"contain",label:t('artboard.fitContain')},{value:"fill",label:t('artboard.fitFill')}]} onChange={(fit)=>onLayer({fit} as Partial<ArtboardLayer>)}/></label>:null}
    <StyleEditor layer={layer} onLayer={onLayer}/>
  </div>;
}

function CompareStrip({ workspace, boardIds, resolveAsset, onClose }: { workspace: ArtboardWorkspaceProps["workspace"]; boardIds: string[]; resolveAsset: (hash: string) => string; onClose: () => void }) {
  const {t}=useI18n();
  const viewportRef=useRef<HTMLDivElement>(null);
  const [zoom,setZoom]=useState(.25);
  const [pan,setPan]=useState({x:48,y:48});
  const items=useMemo(()=>{let x=0;return boardIds.flatMap((id)=>{const board=workspace.boards[id];if(!board)return[];const item={id,board,x,y:0,width:board.document.format.width,height:board.document.format.height};x+=item.width+160;return[item];});},[boardIds,workspace.boards]);
  const setAround=useCallback((next:number,point?:{x:number;y:number})=>{const rect=viewportRef.current?.getBoundingClientRect();if(!rect)return;const anchor=point??{x:rect.width/2,y:rect.height/2};const value=zoomAtCanvasPoint({zoom,pan},next,anchor);setZoom(value.zoom);setPan(value.pan);},[pan,zoom]);
  const fit=useCallback(()=>{const rect=viewportRef.current?.getBoundingClientRect();if(!rect)return;const value=fitCanvasRectangles(items.map(({x,y,width,height})=>({x,y,width,height})),rect,{margin:48,maxZoom:1});if(value){setZoom(value.zoom);setPan(value.pan);}},[items]);
  useEffect(()=>{const frame=requestAnimationFrame(fit);return()=>cancelAnimationFrame(frame);},[fit]);
  useEffect(()=>{const key=(event:KeyboardEvent)=>{const target=event.target as HTMLElement;if(!target.closest?.(".awb-compare")||isFormEditingTarget(target))return;const shortcut=artboardZoomShortcut(event);if(!shortcut)return;event.preventDefault();if(shortcut==="fit")fit();else setAround(zoom*(shortcut==="in"?1.25:.8));};window.addEventListener("keydown",key);return()=>window.removeEventListener("keydown",key);},[fit,setAround,zoom]);
  const wheel=(event:ReactWheelEvent<HTMLDivElement>)=>{if(isFormEditingTarget(event.target))return;event.preventDefault();const rect=event.currentTarget.getBoundingClientRect();const unit=event.deltaMode===1?16:event.deltaMode===2?rect.height:1;const dx=event.deltaX*unit,dy=event.deltaY*unit;if(event.metaKey||event.ctrlKey){const value=zoomAtCanvasPoint({zoom,pan},zoom*Math.exp(-dy*.002),{x:event.clientX-rect.left,y:event.clientY-rect.top});setZoom(value.zoom);setPan(value.pan);}else setPan((current)=>panByWheel(current,{deltaX:dx,deltaY:dy,shiftKey:event.shiftKey}));};
  return <section className="awb-compare" aria-label={t('artboard.compareLabel')}><header><strong>{t('artboard.compareCount',{count:boardIds.length})}</strong><div className="awb-compare-zoom" aria-label={t('artboard.zoom')}><button type="button" className="awb-icon-button" onClick={()=>setAround(zoom*.8)} aria-label={t('artboard.zoomOut')}><ZoomOut size={14}/></button><output>{percent(zoom)}</output><button type="button" className="awb-icon-button" onClick={()=>setAround(zoom*1.25)} aria-label={t('artboard.zoomIn')}><ZoomIn size={14}/></button><button type="button" className="awb-icon-button" onClick={fit} aria-label={t('artboard.fitAll')}><RotateCcw size={13}/></button></div><button type="button" className="awb-icon-button" onClick={onClose} aria-label={t('artboard.closeCompare')}><X size={15} /></button></header><div ref={viewportRef} className="awb-compare-viewport" role="application" tabIndex={0} aria-keyshortcuts="Meta+= Control+= Meta+- Control+- Meta+0 Control+0" onWheel={wheel}><div className="awb-compare-world" style={{transform:`translate(${pan.x}px, ${pan.y}px) scale(${zoom})`}}>{items.map(({id,board,x,y,width,height})=>{const svg=renderArtboardSvg(board.document,resolveAsset);const source=`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;return <article key={id} style={{left:x,top:y,width,height}}><div><img src={source} alt={t('artboard.preview',{name:board.name})}/></div><strong>{board.name}</strong><small>{formatNumber(width)} × {formatNumber(height)}</small></article>;})}</div></div></section>;
}
