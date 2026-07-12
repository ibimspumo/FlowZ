import {
  ArrowLeft, BoxSelect, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Copy, Download, Eye, EyeOff,
  Frame, Group, Image, Layers3, Lock, Plus, Redo2, RotateCcw, Ungroup,
  Shapes, Sparkles, Trash2, Type, Undo2, Unlock, X, ZoomIn, ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
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
import "./artboard-workspace.css";

export function shouldHandleArtboardCanvasShortcut(key: string, insideCanvas: boolean, interactive: boolean) {
  return key !== "Tab" && insideCanvas && !interactive;
}

const percent = (zoom: number) => `${formatNumber(Math.round(zoom * 100))} %`;
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

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
  useEffect(() => setWorkspaceName(props.workspace.name), [props.workspace.name]);
  useEffect(() => props.agent?.onSelectionChange(agentSelection), [props.agent, agentSelection]);
  const selectBoard = (boardId: string, additive: boolean) => {
    const selection = orderedBoardSelection(props.workspace, boardId, additive);
    props.onSelectionChange(selection.activeBoardId, selection.selectedBoardIds);
    if (!additive) setSelectedLayer(undefined);
  };
  const updateLayer = (patch: Partial<ArtboardLayer>) => {
    if (!selectedLayer || !activeLayer) return;
    commit([{ type: "update-layer", ...selectedLayer, patch: { ...patch, version: activeLayer.version + 1 } as Partial<ArtboardLayer> }], "inspector");
  };
  const addLayer = (type: "text" | "shape") => {
    if (!activeBoard) return;
    const id = nextId(type);
    const base = { id, name: type === "text" ? t('artboard.text') : t('artboard.shape'), locked: false, visible: true, version: 1, geometry: { x: 80, y: 80, width: Math.min(560, activeBoard.document.format.width - 160), height: type === "text" ? 150 : 300, rotation: 0 } };
    const layer: ArtboardLayer = type === "text"
      ? { ...base, type: "text", text: t('artboard.editText'), color: "#111111", fontSize: 72, align: "left" }
      : { ...base, type: "shape", shape: "rectangle", fill: { kind: "solid", color: "#EE3399" } };
    commit([{ type: "create-layer", boardId: activeBoard.id, layer, rootIndex: activeBoard.document.rootLayerIds.length }], "create-layer");
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
  });

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
      <CustomSelect label={t('artboard.format')} value={activeBoard?.document.format.preset ?? "instagram-post"} options={ARTBOARD_PRESET_OPTIONS} onChange={(value) => setPreset(value as ArtboardPreset)} />
      <button type="button" className="awb-icon-button" onClick={() => props.onCreateBoard(activeBoard?.document.format.preset ?? "instagram-post", activeBoard?.id)} aria-label={t('artboard.new')}><Plus size={15} /></button>
      <button type="button" className="awb-icon-button" disabled={!props.canUndo} onClick={props.onUndo} aria-label={t('artboard.undo')}><Undo2 size={15} /></button>
      <button type="button" className="awb-icon-button" disabled={!props.canRedo} onClick={props.onRedo} aria-label={t('artboard.redo')}><Redo2 size={15} /></button>
      <div className="awb-zoom" aria-label={t('artboard.zoom')}>
        <button type="button" onClick={() => setZoom((value) => Math.max(.08, value - .1))} aria-label={t('artboard.zoomOut')}><ZoomOut size={14} /></button>
        <output>{percent(zoom)}</output>
        <button type="button" onClick={() => setZoom((value) => Math.min(2, value + .1))} aria-label={t('artboard.zoomIn')}><ZoomIn size={14} /></button>
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
      {panel === "assets" ? <AssetPanel assets={props.assets ?? []} total={props.assetTotal??0} loading={props.assetsLoading} onMore={props.onLoadMoreAssets} onUse={(asset)=>props.onInsertAsset?.(asset)} /> : null}
      {panel === "inputs" ? <InputPanel board={activeBoard} update={activeBoard ? props.upstreamUpdates?.[activeBoard.id] : undefined} onIgnore={() => activeBoard && props.upstreamUpdates?.[activeBoard.id] && props.onIgnoreUpstreamUpdate(activeBoard.id,props.upstreamUpdates[activeBoard.id])} onUpdate={() => activeBoard && props.upstreamUpdates?.[activeBoard.id] && props.onUpdateBoardInputs(activeBoard.id, props.upstreamUpdates[activeBoard.id])} onVariant={() => activeBoard && props.onCreateVariant(activeBoard.id, props.upstreamUpdates?.[activeBoard.id])} /> : null}
    </aside> : <button type="button" className="awb-panel-reveal awb-panel-reveal-left" onClick={() => setLeftOpen(true)} aria-label={t('artboard.openTools')}><ChevronRight size={15} /></button>}

    <ArtboardCanvas workspace={props.workspace} zoom={zoom} pan={pan} selectedLayer={selectedLayer} resolveAsset={props.resolveAsset ?? ((hash) => `flowz-media:${hash}`)} onSelectBoard={selectBoard} onSelectLayer={(selection) => { setSelectedLayer(selection); if (selection) setRightOpen(true); }} onCommit={commit} onPan={setPan} onDropAsset={(versionId,destination)=>{const asset=props.assets?.find((item)=>item.versionId===versionId);if(asset)props.onInsertAsset?.(asset,destination);}} />

    {rightOpen ? <aside className="awb-inspector" aria-label={t('artboard.properties')}>
      <div className="awb-panel-heading"><strong>{activeLayer ? activeLayer.name : activeBoard?.name ?? t('artboard.properties')}</strong><button type="button" className="awb-icon-button" onClick={() => setRightOpen(false)} aria-label={t('artboard.closeInspector')}><ChevronRight size={14} /></button></div>
      <Inspector board={activeBoard} layer={activeLayer} onBoardName={(name) => activeBoard && commit([{ type: "rename-board", boardId: activeBoard.id, name }], "board-name")} onBoardColor={(color) => activeBoard && commit([{ type: "set-board-paint", boardId: activeBoard.id, color }], "board-color")} onLayer={updateLayer} />
      {activeBoard ? <div className="awb-inspector-actions"><button type="button" className="awb-button" onClick={() => props.onDuplicateBoard(activeBoard.id)}><Copy size={13} />{t('artboard.duplicate')}</button><button type="button" className="awb-button" onClick={() => props.onCreateVariant(activeBoard.id)}><Sparkles size={13} />{t('artboard.newVariant')}</button></div> : null}
    </aside> : <button type="button" className="awb-panel-reveal awb-panel-reveal-right" onClick={() => setRightOpen(true)} aria-label={t('artboard.openInspector')}><ChevronLeft size={15} /></button>}

    {props.agent ? <ArtboardDesignAgent
      workspace={props.workspace} branchId={props.agent.branchId} revision={props.revision} selection={agentSelection}
      adapterFactory={props.agent.adapterFactory} toolExecutor={props.agent.toolExecutor} resolveProposal={props.agent.resolveProposal}
      prepareContext={props.agent.prepareContext} onApplyProposal={props.agent.onApplyProposal}
      onOpenProviderSettings={() => props.agent?.onOpenProviderSettings?.()}
      onOpenFalSettings={props.agent.onOpenFalSettings}
      pendingFollowUps={props.agent.pendingFollowUps} pendingFollowUpProposalId={props.agent.pendingFollowUpProposalId} onConfirmFollowUp={props.agent.onConfirmFollowUp} onDismissFollowUps={props.agent.onDismissFollowUps}
    /> : null}

    {compare && comparison.length ? <CompareStrip workspace={props.workspace} boardIds={comparison} resolveAsset={props.resolveAsset ?? ((hash) => `flowz-media:${hash}`)} onClose={() => setCompare(false)} /> : null}
  </main>;
}

function LayerPanel({ board, selected, onSelect, onCommit, onAdd }: { board: ArtboardWorkspaceProps["workspace"]["boards"][string] | undefined; selected?: SelectedLayer; onSelect: (value?: SelectedLayer) => void; onCommit: (operations: ArtboardWorkspaceOperation[]) => void; onAdd: (type: "text" | "shape") => void }) {
  const {t}=useI18n();
  const [marked,setMarked]=useState<string[]>([]);
  if (!board) return <div className="awb-empty">{t('artboard.chooseBoard')}</div>;
  const layers: Array<{layer:ArtboardLayer;depth:number}> = [];
  const append=(ids:readonly string[],depth:number)=>[...ids].reverse().forEach((id)=>{const layer=board.document.layers[id];if(!layer)return;layers.push({layer,depth});if(layer.type==="group")append(layer.childIds,depth+1);});
  append(board.document.rootLayerIds,0);
  const group=()=>{const ids=board.document.rootLayerIds.filter((id)=>marked.includes(id));if(ids.length<2)return;const chosen=ids.map((id)=>board.document.layers[id]);const id=`group-${crypto.randomUUID()}`;const x=Math.min(...chosen.map((item)=>item.geometry.x)),y=Math.min(...chosen.map((item)=>item.geometry.y)),right=Math.max(...chosen.map((item)=>item.geometry.x+item.geometry.width)),bottom=Math.max(...chosen.map((item)=>item.geometry.y+item.geometry.height));const rootLayerIds=board.document.rootLayerIds.filter((item)=>!ids.includes(item));rootLayerIds.splice(Math.min(...ids.map((item)=>board.document.rootLayerIds.indexOf(item))),0,id);onCommit([{type:"set-layer-tree",boardId:board.id,rootLayerIds,layers:{...board.document.layers,[id]:{id,type:"group",name:t('artboard.group'),locked:false,visible:true,version:1,geometry:{x,y,width:right-x,height:bottom-y,rotation:0},childIds:ids}}}]);setMarked([]);onSelect({boardId:board.id,layerId:id});};
  const ungroup=()=>{if(!selected)return;const item=board.document.layers[selected.layerId];if(item?.type!=="group")return;const tree=ungroupLayerTree({schemaVersion:1,id:"ui",name:"UI",boards:{[board.id]:board},placements:{[board.id]:{x:0,y:0}},selectedBoardIds:[board.id],activeBoardId:board.id,pasteboard:{margin:0,gap:0,grid:1}},board.id,item.id);onCommit([{type:"set-layer-tree",boardId:board.id,...tree}]);onSelect(undefined);};
  return <><div className="awb-add-row"><button type="button" onClick={()=>onAdd("text")}><Type size={13}/>{t('artboard.text')}</button><button type="button" onClick={()=>onAdd("shape")}><Shapes size={13}/>{t('artboard.shape')}</button><button type="button" disabled={marked.length<2} onClick={group}><Group size={13}/>{t('artboard.group')}</button><button type="button" disabled={board.document.layers[selected?.layerId??""]?.type!=="group"} onClick={ungroup}><Ungroup size={13}/>{t('artboard.ungroup')}</button></div><div className="awb-layer-list">{layers.map(({layer,depth})=><div key={layer.id} className={selected?.layerId===layer.id?"is-active":""} style={{paddingLeft:depth*12}}><input type="checkbox" checked={marked.includes(layer.id)} onChange={()=>setMarked((current)=>current.includes(layer.id)?current.filter((id)=>id!==layer.id):[...current,layer.id])} aria-label={t('artboard.markLayer',{name:layer.name})}/><button type="button" className="awb-layer-name" onClick={()=>onSelect({boardId:board.id,layerId:layer.id})}>{layer.type==="text"?<Type size={13}/>:layer.type==="image"?<Image size={13}/>:layer.type==="group"?<Group size={13}/>:<Shapes size={13}/>}<span>{layer.name}</span></button><button type="button" aria-label={t('artboard.forward',{name:layer.name})} onClick={()=>onCommit([{type:"reorder-layer",boardId:board.id,layerId:layer.id,direction:"forward"}])}><ChevronUp size={12}/></button><button type="button" aria-label={t('artboard.backward',{name:layer.name})} onClick={()=>onCommit([{type:"reorder-layer",boardId:board.id,layerId:layer.id,direction:"backward"}])}><ChevronDown size={12}/></button><button type="button" aria-label={t(layer.visible?'artboard.hide':'artboard.show',{name:layer.name})} onClick={()=>onCommit([{type:"update-layer",boardId:board.id,layerId:layer.id,patch:{visible:!layer.visible,version:layer.version+1} as Partial<ArtboardLayer>}])}>{layer.visible?<Eye size={13}/>:<EyeOff size={13}/>}</button><button type="button" aria-label={t(layer.locked?'artboard.unlock':'artboard.lock',{name:layer.name})} onClick={()=>onCommit([{type:"update-layer",boardId:board.id,layerId:layer.id,patch:{locked:!layer.locked,version:layer.version+1} as Partial<ArtboardLayer>}])}>{layer.locked?<Lock size={13}/>:<Unlock size={13}/>}</button><button type="button" aria-label={t('artboard.deleteLayer',{name:layer.name})} onClick={()=>{onCommit([{type:"delete-layers",boardId:board.id,layerIds:[layer.id]}]);if(selected?.layerId===layer.id)onSelect(undefined);}}><Trash2 size={12}/></button></div>)}</div></>;
}

function AssetPanel({ assets,total,loading,onMore,onUse }: { assets: NonNullable<ArtboardWorkspaceProps["assets"]>;total:number;loading?:boolean;onMore?:()=>void;onUse:(asset:NonNullable<ArtboardWorkspaceProps["assets"]>[number])=>void }) {
  const {t}=useI18n();
  if (!assets.length) return <div className="awb-empty"><Image size={20} /><strong>{t('artboard.noAssets')}</strong><span>{t('artboard.assetsHint')}</span></div>;
  return <div className="awb-asset-grid">{assets.map((asset) => <button type="button" key={asset.versionId} draggable onDragStart={(event)=>{event.dataTransfer.effectAllowed="copy";event.dataTransfer.setData("application/x-flowz-artboard-asset",asset.versionId);}} onClick={()=>onUse(asset)} aria-label={t('artboard.useAsset',{name:asset.name})}>{asset.previewUrl ? <img src={asset.previewUrl} alt="" loading="lazy" /> : asset.kind === "font" ? <Type size={21} /> : <Frame size={21} />}<span>{asset.name}</span></button>)}{assets.length<total?<button type="button" disabled={loading} onClick={onMore}>{loading?t('common.loading'):t('assets.loadMore',{current:assets.length,total})}</button>:null}</div>;
}

function InputPanel({ board, update, onIgnore, onUpdate, onVariant }: { board?: ArtboardWorkspaceProps["workspace"]["boards"][string]; update?: NonNullable<ArtboardWorkspaceProps["upstreamUpdates"]>[string]; onIgnore: () => void; onUpdate: () => void; onVariant: () => void }) {
  const {t}=useI18n();
  if (!board) return <div className="awb-empty">{t('artboard.chooseBoard')}</div>;
  const bindings = Object.values(board.inputSnapshot.bindings);
  return <div className="awb-inputs">{update ? <section className="awb-update-notice"><strong>{t('artboard.newInputs')}</strong><p>{t('artboard.inputDecision')}</p><div><button type="button" onClick={onIgnore}>{t('artboard.ignore')}</button><button type="button" onClick={onUpdate}>{t('artboard.update')}</button><button type="button" className="is-primary" onClick={onVariant}>{t('artboard.asVariant')}</button></div></section> : null}{bindings.map((binding) => <div key={binding.id}><RotateCcw size={13} /><span><strong>{binding.source.portId}</strong><small>{binding.mode === "pinned" ? t('artboard.pinned') : t('artboard.liveBinding')}</small></span></div>)}{!bindings.length ? <div className="awb-empty">{t('artboard.noInputs')}</div> : null}</div>;
}

function Inspector({ board, layer, onBoardName, onBoardColor, onLayer }: { board?: ArtboardWorkspaceProps["workspace"]["boards"][string]; layer?: ArtboardLayer; onBoardName: (name: string) => void; onBoardColor: (color: string) => void; onLayer: (patch: Partial<ArtboardLayer>) => void }) {
  const {t}=useI18n();
  if (!board) return <div className="awb-empty">{t('artboard.chooseBoard')}</div>;
  if (!layer) return <div className="awb-fields"><label>{t('home.sort.name')}<input value={board.name} onChange={(event) => onBoardName(event.currentTarget.value)} /></label><div className="awb-field-row"><label>{t('artboard.width')}<input value={board.document.format.width} readOnly /></label><label>{t('artboard.height')}<input value={board.document.format.height} readOnly /></label></div><label>{t('artboard.background')}<input type="color" value={board.document.paint.color} onChange={(event) => onBoardColor(event.currentTarget.value.toUpperCase())} /></label></div>;
  const geometry = layer.geometry;
  const geometryPatch = (patch: Partial<typeof geometry>) => onLayer({ geometry: clampLayerGeometry(layer, patch, board.document.format) } as Partial<ArtboardLayer>);
  return <div className="awb-fields">
    <label>{t('home.sort.name')}<input value={layer.name} onChange={(event)=>onLayer({name:event.currentTarget.value} as Partial<ArtboardLayer>)}/></label>
    <div className="awb-field-row"><label>X<input type="number" value={Math.round(geometry.x)} onChange={(event)=>geometryPatch({x:Number(event.currentTarget.value)})}/></label><label>Y<input type="number" value={Math.round(geometry.y)} onChange={(event)=>geometryPatch({y:Number(event.currentTarget.value)})}/></label></div>
    <div className="awb-field-row"><label>{t('artboard.width')}<input type="number" value={Math.round(geometry.width)} onChange={(event)=>geometryPatch({width:Number(event.currentTarget.value)})}/></label><label>{t('artboard.height')}<input type="number" value={Math.round(geometry.height)} onChange={(event)=>geometryPatch({height:Number(event.currentTarget.value)})}/></label></div>
    <label>{t('artboard.rotation')}<input type="number" min={-360} max={360} value={Math.round(geometry.rotation)} onChange={(event)=>geometryPatch({rotation:Number(event.currentTarget.value)})}/></label>
    {layer.type==="text"?<><DeferredFontPicker label={t('font.family')} value={layer.fontFamily??"Inter"} axes={layer.fontAxes} onChange={(font)=>{const hash=font.prepared?.blobHash;if(!hash)return;void loadArtboardFont(hash,font.style,font.weight).then(()=>onLayer({fontRef:`font-${hash.slice(0,24)}`,fontFamily:font.family,fontHash:hash,fontWeight:font.weight,fontStyle:font.style==="italic"?"italic":"normal",fontAxes:font.axes} as Partial<ArtboardLayer>));}}/><label>{t('artboard.text')}<textarea value={layer.text} rows={5} onChange={(event)=>onLayer({text:event.currentTarget.value} as Partial<ArtboardLayer>)}/></label><div className="awb-field-row"><label>{t('artboard.fontSize')}<input type="number" value={layer.fontSize} onChange={(event)=>onLayer({fontSize:Number(event.currentTarget.value)} as Partial<ArtboardLayer>)}/></label><label>{t('artboard.color')}<input type="color" value={layer.color} onChange={(event)=>onLayer({color:event.currentTarget.value.toUpperCase()} as Partial<ArtboardLayer>)}/></label></div></>:null}
    {layer.type==="shape"?<label>{t('artboard.color')}<input type="color" value={layer.fill.color} onChange={(event)=>onLayer({fill:{kind:"solid",color:event.currentTarget.value.toUpperCase()}} as Partial<ArtboardLayer>)}/></label>:null}
    {layer.type==="image"?<label>{t('artboard.fit')}<CustomSelect label={t('artboard.imageFit')} value={layer.fit} options={[{value:"cover",label:t('artboard.fitCover')},{value:"contain",label:t('artboard.fitContain')},{value:"fill",label:t('artboard.fitFill')}]} onChange={(fit)=>onLayer({fit} as Partial<ArtboardLayer>)}/></label>:null}
  </div>;
}

function CompareStrip({ workspace, boardIds, resolveAsset, onClose }: { workspace: ArtboardWorkspaceProps["workspace"]; boardIds: string[]; resolveAsset: (hash: string) => string; onClose: () => void }) {
  const {t}=useI18n();
  return <section className="awb-compare" aria-label={t('artboard.compareLabel')}><header><strong>{t('artboard.compareCount',{count:boardIds.length})}</strong><button type="button" className="awb-icon-button" onClick={onClose} aria-label={t('artboard.closeCompare')}><X size={15} /></button></header><div>{boardIds.map((id) => { const board = workspace.boards[id]; const svg = renderArtboardSvg(board.document, resolveAsset); const source = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`; return <article key={id}><div style={{ aspectRatio: `${board.document.format.width}/${board.document.format.height}` }}><img src={source} alt={t('artboard.preview',{name:board.name})} /></div><strong>{board.name}</strong><small>{formatNumber(board.document.format.width)} × {formatNumber(board.document.format.height)}</small></article>; })}</div></section>;
}
