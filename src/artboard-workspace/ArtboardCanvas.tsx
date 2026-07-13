import { Lock, MoveDiagonal2 } from "lucide-react";
import { Fragment, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject, type WheelEvent as ReactWheelEvent } from "react";
import { boardBounds, rectanglesOverlap, type ArtboardLayer, type ArtboardWorkspace } from "../nodes/brand/artboard-domain";
import { createArtboardRenderPlan, renderArtboardSvg } from "../nodes/brand/artboard-renderer";
import { clampLayerGeometry } from "./operations";
import { releaseGesturePreview, updateGesturePreview } from "./operations";
import type { ArtboardWorkspaceOperation, SelectedLayer } from "./types";
import { formatNumber, useI18n } from "../i18n";
import { artboardFontFamily, isArtboardFontLoaded } from "./artboard-fonts";
import type { AgentCanvasFeedback, AgentCanvasGhostBoard } from "../artboard-agent-ui/canvas-feedback";
import { isFormEditingTarget, panByWheel, zoomAtCanvasPoint } from "./canvas-navigation";

type Props = {
  workspace: ArtboardWorkspace;
  zoom: number;
  pan: { x: number; y: number };
  selectedLayer?: SelectedLayer;
  agentFeedback?: AgentCanvasFeedback;
  viewportRef?: RefObject<HTMLDivElement | null>;
  viewportTransition?: boolean;
  resolveAsset: (hash: string) => string;
  onSelectBoard: (boardId: string, additive: boolean) => void;
  onSelectLayer: (selection?: SelectedLayer) => void;
  onCommit: (operations: ArtboardWorkspaceOperation[]) => void;
  onPan: (pan: { x: number; y: number }) => void;
  onViewport?: (viewport: { zoom: number; pan: { x: number; y: number } }) => void;
  onDropAsset?: (versionId:string,destination:{boardId?:string;layerId?:string;x?:number;y?:number})=>void;
  onDropImage?: (file:File,destination:{boardId?:string;layerId?:string;x?:number;y?:number})=>void;
};

type DragState =
  | { kind: "pan"; startX: number; startY: number; panX: number; panY: number }
  | { kind: "layer"; boardId: string; layerId: string; mode: "move" | "resize"; startX: number; startY: number; geometry: ArtboardLayer["geometry"] }
  | { kind: "board"; boardId: string; startX: number; startY: number; x: number; y: number };

const imageSource = (layer: Extract<ArtboardLayer, { type: "image" }>, board: ArtboardWorkspace["boards"][string], resolver: (hash: string) => string) => {
  const binding = layer.bindingId ? board.document.bindings[layer.bindingId] : undefined;
  const hash = layer.casHash ?? (binding?.snapshot.kind === "cas" ? binding.snapshot.hash : undefined);
  return hash ? resolver(hash) : undefined;
};
const paintCss=(paint:Extract<ArtboardLayer,{type:"shape"|"container"}>["fill"]):string=>paint.kind==="solid"?paint.color:`linear-gradient(${paint.angle}deg, ${paint.stops[0].color} ${paint.stops[0].offset*100}%, ${paint.stops[1].color} ${paint.stops[1].offset*100}%)`;
const styleCss=(layer:ArtboardLayer):CSSProperties=>({opacity:layer.style?.opacity,border:layer.style?.border?.width?`${layer.style.border.width}px solid ${layer.style.border.color}`:undefined,borderRadius:layer.style?.borderRadius,boxShadow:layer.style?.shadow&&layer.style.shadow.opacity>0?`${layer.style.shadow.x}px ${layer.style.shadow.y}px ${layer.style.shadow.blur}px color-mix(in srgb, ${layer.style.shadow.color} ${layer.style.shadow.opacity*100}%, transparent)`:undefined});

function AgentGhostBoard({ ghost, resolveAsset, applying }: { ghost: AgentCanvasGhostBoard; resolveAsset: (hash: string) => string; applying: boolean }) {
  const { t } = useI18n();
  const label = ghost.name ?? t(ghost.kind === "variant" ? "agent.canvasVariant" : "agent.canvasNewBoard");
  const status = applying ? t("agent.canvasApplying") : ghost.phase === "preview" ? t("agent.canvasPreview") : t("agent.canvasWorking");
  const source = ghost.board ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderArtboardSvg(ghost.board.document, resolveAsset))}` : undefined;
  return <section
    className={`awb-agent-ghost is-${ghost.phase} ${applying ? "is-applying" : ""}`}
    style={{ left: ghost.placement.x, top: ghost.placement.y, width: ghost.format.width, height: ghost.format.height }}
    aria-label={t("agent.canvasGhostLabel", { name: label, status })}
    data-agent-ghost-id={ghost.id}
  >
    <div className="awb-agent-ghost-label"><span>{label}</span><small>{formatNumber(ghost.format.width)} × {formatNumber(ghost.format.height)}</small></div>
    {source ? <img src={source} alt="" /> : <div className="awb-agent-ghost-skeleton" aria-hidden="true"><i /><i /><i /></div>}
    <div className="awb-agent-ghost-overlay" aria-hidden="true" />
    <div className="awb-agent-work-indicator"><span aria-hidden="true" />{status}</div>
  </section>;
}

export function ArtboardCanvas(props: Props) {
  const {t}=useI18n();
  const drag = useRef<DragState | undefined>(undefined);
  const moved = useRef<ArtboardWorkspaceOperation | undefined>(undefined);
  const [preview, setPreview] = useState<ArtboardWorkspaceOperation>();
  const boards = Object.values(props.workspace.boards);
  const dropAsset=(event:ReactDragEvent<HTMLDivElement>)=>{
    if(event.dataTransfer.files.length){const file=event.dataTransfer.files[0];if(!file.type.startsWith("image/"))return;event.preventDefault();const target=(event.target as HTMLElement).closest<HTMLElement>("[data-board-id]");const boardId=target?.dataset.boardId;const layerId=(event.target as HTMLElement).closest<HTMLElement>("[data-layer-id]")?.dataset.layerId;if(!boardId){props.onDropImage?.(file,{});return;}const boardElement=(event.target as HTMLElement).closest<HTMLElement>(".awb-board")!;const rect=boardElement.getBoundingClientRect();props.onDropImage?.(file,{boardId,layerId,x:(event.clientX-rect.left)/props.zoom,y:(event.clientY-rect.top)/props.zoom});return;}
    const versionId=event.dataTransfer.getData("application/x-flowz-artboard-asset"); if(!versionId||versionId.length>128)return;
    event.preventDefault();
    const target=(event.target as HTMLElement).closest<HTMLElement>("[data-board-id]");
    const boardId=target?.dataset.boardId; const layerId=(event.target as HTMLElement).closest<HTMLElement>("[data-layer-id]")?.dataset.layerId;
    if(!boardId){props.onDropAsset?.(versionId,{});return;}
    const boardElement=(event.target as HTMLElement).closest<HTMLElement>(".awb-board")!; const rect=boardElement.getBoundingClientRect();
    props.onDropAsset?.(versionId,{boardId,layerId,x:(event.clientX-rect.left)/props.zoom,y:(event.clientY-rect.top)/props.zoom});
  };

  const worldPoint = (event: ReactPointerEvent) => ({ x: (event.clientX - props.pan.x) / props.zoom, y: (event.clientY - props.pan.y) / props.zoom });
  const beginPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 1 && !(event.button === 0 && (event.target === event.currentTarget || event.altKey || event.metaKey))) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { kind: "pan", startX: event.clientX, startY: event.clientY, panX: props.pan.x, panY: props.pan.y };
  };
  const beginBoardMove = (event: ReactPointerEvent, boardId: string) => {
    if (event.button !== 0 || event.shiftKey || event.metaKey) return;
    const placement = props.workspace.placements[boardId];
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { kind: "board", boardId, startX: event.clientX, startY: event.clientY, x: placement.x, y: placement.y };
  };
  const beginLayer = (event: ReactPointerEvent, boardId: string, layer: ArtboardLayer, mode: "move" | "resize") => {
    if (layer.locked) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = worldPoint(event);
    drag.current = { kind: "layer", boardId, layerId: layer.id, mode, startX: point.x, startY: point.y, geometry: layer.geometry };
    props.onSelectLayer({ boardId, layerId: layer.id });
  };
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    if (state.kind === "pan") {
      props.onPan({ x: state.panX + event.clientX - state.startX, y: state.panY + event.clientY - state.startY });
      return;
    }
    if (state.kind === "board") {
      const grid = props.workspace.pasteboard.grid;
      const x = Math.max(0, Math.round((state.x + (event.clientX - state.startX) / props.zoom) / grid) * grid);
      const y = Math.max(0, Math.round((state.y + (event.clientY - state.startY) / props.zoom) / grid) * grid);
      moved.current = updateGesturePreview(moved.current, { type: "move-board", boardId: state.boardId, x, y });
      setPreview(moved.current);
      return;
    }
    const point = worldPoint(event);
    const board = props.workspace.boards[state.boardId];
    const layer = board.document.layers[state.layerId];
    const dx = point.x - state.startX;
    const dy = point.y - state.startY;
    const geometry = state.mode === "move"
      ? clampLayerGeometry(layer, { x: state.geometry.x + dx, y: state.geometry.y + dy }, board.document.format)
      : clampLayerGeometry(layer, { width: state.geometry.width + dx, height: state.geometry.height + dy }, board.document.format);
    moved.current = updateGesturePreview(moved.current, { type: "update-layer", boardId: state.boardId, layerId: state.layerId, patch: { geometry, version: layer.version + 1 } as Partial<ArtboardLayer> });
    setPreview(moved.current);
  };
  const pointerUp = () => {
    drag.current = undefined;
    const [operation] = releaseGesturePreview(moved.current);
    if (operation?.type === "move-board") {
      const board = props.workspace.boards[operation.boardId];
      const candidate = { x: operation.x, y: operation.y, width: board.document.format.width, height: board.document.format.height };
      const overlaps = Object.keys(props.workspace.boards).some((id) => id !== operation.boardId && rectanglesOverlap(candidate, boardBounds(props.workspace, id)));
      if (!overlaps) props.onCommit([operation]);
    } else if (operation) props.onCommit([operation]);
    moved.current = undefined;
    setPreview(undefined);
  };
  const navigateWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (isFormEditingTarget(event.target)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
    const deltaX = event.deltaX * unit;
    const deltaY = event.deltaY * unit;
    event.preventDefault();
    if (event.metaKey || event.ctrlKey) {
      const next = zoomAtCanvasPoint(
        { zoom: props.zoom, pan: props.pan },
        props.zoom * Math.exp(-deltaY * .002),
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
      );
      props.onViewport?.(next);
      return;
    }
    props.onPan(panByWheel(props.pan, { deltaX, deltaY, shiftKey: event.shiftKey }));
  };

  return <div
    ref={props.viewportRef}
    className="awb-canvas"
    role="application"
    aria-label={t('artboard.canvas')}
    aria-keyshortcuts="Meta+= Control+= Meta+- Control+- Meta+0 Control+0"
    tabIndex={0}
    onWheel={navigateWheel}
    onPointerDown={beginPan}
    onPointerMove={pointerMove}
    onPointerUp={pointerUp}
    onPointerCancel={pointerUp}
    onDragOver={(event)=>{if(event.dataTransfer.types.includes("application/x-flowz-artboard-asset")||event.dataTransfer.types.includes("Files")){event.preventDefault();event.dataTransfer.dropEffect="copy";}}}
    onDrop={dropAsset}
  >
    {props.agentFeedback ? <div className="visually-hidden" role={props.agentFeedback.renderError ? "alert" : "status"} aria-live="polite">{props.agentFeedback.renderError ? t("agent.canvasPreviewFailed", { message: props.agentFeedback.renderError }) : t(props.agentFeedback.phase === "preview" ? "agent.canvasPreviewReady" : props.agentFeedback.phase === "applying" ? "agent.canvasApplying" : "agent.canvasWorking")}</div> : null}
    {props.agentFeedback?.renderError ? <div className="awb-agent-preview-error" role="alert">{t("agent.canvasPreviewFailed", { message: props.agentFeedback.renderError })}</div> : null}
    <div className={`awb-world ${props.viewportTransition ? "is-agent-fitting" : ""}`} style={{ transform: `translate(${props.pan.x}px, ${props.pan.y}px) scale(${props.zoom})` }}>
      {boards.map((board) => {
        const renderPlan=createArtboardRenderPlan(board.document);const planned=new Map(renderPlan.layers.map((layer)=>[layer.id,layer]));
        const placement = preview?.type === "move-board" && preview.boardId === board.id ? { x: preview.x, y: preview.y } : props.workspace.placements[board.id];
        const selected = props.workspace.selectedBoardIds.includes(board.id);
        const active = props.workspace.activeBoardId === board.id;
        const renderLayer = (layerId:string, ancestorLocked=false):ReactNode => {
          const layer=board.document.layers[layerId]; if(!layer||!layer.visible)return null;
          const isSelected=props.selectedLayer?.boardId===board.id&&props.selectedLayer.layerId===layer.id;
          const geometry=preview?.type==="update-layer"&&preview.boardId===board.id&&preview.layerId===layer.id&&preview.patch.geometry?preview.patch.geometry:layer.geometry;
          if(layer.type==="group") {
            const originX=geometry.x+geometry.width/2,originY=geometry.y+geometry.height/2;
            return <div key={layer.id} className={`awb-layer-group ${isSelected?"is-selected":""}`} style={{position:"absolute",inset:0,opacity:layer.style?.opacity,transform:`rotate(${geometry.rotation}deg)`,transformOrigin:`${originX}px ${originY}px`,pointerEvents:"none"}} data-board-id={board.id} data-layer-id={layer.id}>{layer.childIds.map((childId)=>renderLayer(childId,ancestorLocked||layer.locked))}</div>;
          }
          const plannedLayer=planned.get(layer.id);if(!plannedLayer)return null;
          const locked=ancestorLocked||layer.locked;
          const resolvedGeometry=preview?.type==="update-layer"&&preview.boardId===board.id&&preview.layerId===layer.id?geometry:plannedLayer.geometry;
          const common={left:resolvedGeometry.x,top:resolvedGeometry.y,width:resolvedGeometry.width,height:resolvedGeometry.height,transform:`rotate(${resolvedGeometry.rotation}deg)`};
          const src=layer.type==="image"?imageSource(layer,board,props.resolveAsset):undefined;
          const imageStyle=layer.type==="image"&&src?{backgroundImage:`url(${JSON.stringify(src)})`,backgroundSize:layer.fit==="fill"?"100% 100%":layer.fit,backgroundPosition:"center"}:{};
          const customFontReady=layer.type==="text"&&Boolean(layer.fontHash)&&isArtboardFontLoaded(layer.fontHash!,layer.fontStyle,layer.fontWeight);
          const visual=<button key={`${layer.id}-visual`} type="button" className={`awb-layer awb-layer-${layer.type} ${isSelected?"is-selected":""}`} style={{...common,...styleCss(layer),...(layer.type==="shape"||layer.type==="container"?{background:paintCss(layer.fill),borderRadius:layer.type==="shape"&&layer.shape==="ellipse"?"50%":layer.style?.borderRadius}:{}),...(layer.type==="text"?{color:layer.color,fontSize:layer.fontSize,textAlign:layer.align,fontFamily:customFontReady?artboardFontFamily(layer.fontHash!):layer.fontFamily,fontWeight:layer.fontWeight,fontStyle:layer.fontStyle,fontVariationSettings:layer.fontAxes?Object.entries(layer.fontAxes).map(([tag,value])=>`"${tag}" ${value}`).join(", "):undefined}:{}),...imageStyle,pointerEvents:"auto"}} onPointerDown={(event)=>{if(!locked)beginLayer(event,board.id,layer,"move");else{event.stopPropagation();props.onSelectLayer({boardId:board.id,layerId:layer.id});}}} onDoubleClick={(event)=>{event.stopPropagation();props.onSelectLayer({boardId:board.id,layerId:layer.id});}} aria-label={locked?t('artboard.layerLocked',{name:layer.name}):layer.name} data-board-id={board.id} data-layer-id={layer.id}>
            {layer.type==="text"?layer.text:null}{locked?<Lock className="awb-layer-lock" size={14/props.zoom}/>:null}{isSelected&&!locked?<span className="awb-resize" onPointerDown={(event)=>beginLayer(event,board.id,layer,"resize")}><MoveDiagonal2 size={16/props.zoom}/></span>:null}
          </button>;
          return layer.type==="container"?<Fragment key={layer.id}>{visual}<div className="awb-container-children" style={{position:"absolute",inset:0,pointerEvents:"none",opacity:layer.style?.opacity,transform:`rotate(${resolvedGeometry.rotation}deg)`,transformOrigin:`${resolvedGeometry.x+resolvedGeometry.width/2}px ${resolvedGeometry.y+resolvedGeometry.height/2}px`,clipPath:`inset(${resolvedGeometry.y}px ${Math.max(0,board.document.format.width-resolvedGeometry.x-resolvedGeometry.width)}px ${Math.max(0,board.document.format.height-resolvedGeometry.y-resolvedGeometry.height)}px ${resolvedGeometry.x}px round ${layer.style?.borderRadius??0}px)`}}>{layer.childIds.map((childId)=>renderLayer(childId,locked))}</div></Fragment>:visual;
        };
        return <section
          key={board.id}
          className={`awb-board ${selected ? "is-selected" : ""} ${active ? "is-active" : ""} ${props.agentFeedback?.boardIds.includes(board.id) ? "is-agent-working" : ""} ${props.agentFeedback?.removedBoardIds?.includes(board.id) ? "is-agent-removing" : ""}`}
          style={{ left: placement.x, top: placement.y, width: board.document.format.width, height: board.document.format.height, background: board.document.paint.kind==="solid"?board.document.paint.color:`linear-gradient(${board.document.paint.angle}deg, ${board.document.paint.stops[0].color}, ${board.document.paint.stops[1].color})` }}
          aria-label={t('artboard.dimensions',{name:board.name,width:formatNumber(board.document.format.width),height:formatNumber(board.document.format.height)})}
          data-board-id={board.id}
          onPointerDown={(event) => { event.stopPropagation(); props.onSelectBoard(board.id, event.shiftKey || event.metaKey); }}
        >
          <button className="awb-board-label" type="button" onPointerDown={(event) => beginBoardMove(event, board.id)} onClick={() => props.onSelectBoard(board.id, false)}>
            <span>{board.name}</span><small>{formatNumber(board.document.format.width)} × {formatNumber(board.document.format.height)}</small>
          </button>
          {board.document.rootLayerIds.map((id)=>renderLayer(id))}
          {props.agentFeedback?.boardIds.includes(board.id) ? <div className="awb-agent-board-overlay" aria-hidden="true"><span>{props.agentFeedback.removedBoardIds?.includes(board.id) ? t("agent.canvasRemove") : ""}</span></div> : null}
        </section>;
      })}
      {props.agentFeedback?.ghostBoards.map((ghost) => <AgentGhostBoard key={ghost.id} ghost={ghost} resolveAsset={props.resolveAsset} applying={props.agentFeedback?.phase === "applying"} />)}
    </div>
  </div>;
}
