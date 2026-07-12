import { Lock, MoveDiagonal2 } from "lucide-react";
import { useRef, useState, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { boardBounds, rectanglesOverlap, type ArtboardLayer, type ArtboardWorkspace } from "../nodes/brand/artboard-domain";
import { clampLayerGeometry } from "./operations";
import { releaseGesturePreview, updateGesturePreview } from "./operations";
import type { ArtboardWorkspaceOperation, SelectedLayer } from "./types";
import { formatNumber, useI18n } from "../i18n";
import { artboardFontFamily, isArtboardFontLoaded } from "./artboard-fonts";

type Props = {
  workspace: ArtboardWorkspace;
  zoom: number;
  pan: { x: number; y: number };
  selectedLayer?: SelectedLayer;
  resolveAsset: (hash: string) => string;
  onSelectBoard: (boardId: string, additive: boolean) => void;
  onSelectLayer: (selection?: SelectedLayer) => void;
  onCommit: (operations: ArtboardWorkspaceOperation[]) => void;
  onPan: (pan: { x: number; y: number }) => void;
  onDropAsset?: (versionId:string,destination:{boardId?:string;layerId?:string;x?:number;y?:number})=>void;
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

export function ArtboardCanvas(props: Props) {
  const {t}=useI18n();
  const drag = useRef<DragState | undefined>(undefined);
  const moved = useRef<ArtboardWorkspaceOperation | undefined>(undefined);
  const [preview, setPreview] = useState<ArtboardWorkspaceOperation>();
  const boards = Object.values(props.workspace.boards);
  const dropAsset=(event:ReactDragEvent<HTMLDivElement>)=>{
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

  return <div
    className="awb-canvas"
    role="application"
    aria-label={t('artboard.canvas')}
    tabIndex={0}
    onPointerDown={beginPan}
    onPointerMove={pointerMove}
    onPointerUp={pointerUp}
    onPointerCancel={pointerUp}
    onDragOver={(event)=>{if(event.dataTransfer.types.includes("application/x-flowz-artboard-asset")){event.preventDefault();event.dataTransfer.dropEffect="copy";}}}
    onDrop={dropAsset}
  >
    <div className="awb-world" style={{ transform: `translate(${props.pan.x}px, ${props.pan.y}px) scale(${props.zoom})` }}>
      {boards.map((board) => {
        const placement = preview?.type === "move-board" && preview.boardId === board.id ? { x: preview.x, y: preview.y } : props.workspace.placements[board.id];
        const selected = props.workspace.selectedBoardIds.includes(board.id);
        const active = props.workspace.activeBoardId === board.id;
        const renderLayer = (layerId:string, ancestorLocked=false):ReactNode => {
          const layer=board.document.layers[layerId]; if(!layer||!layer.visible)return null;
          const isSelected=props.selectedLayer?.boardId===board.id&&props.selectedLayer.layerId===layer.id;
          const geometry=preview?.type==="update-layer"&&preview.boardId===board.id&&preview.layerId===layer.id&&preview.patch.geometry?preview.patch.geometry:layer.geometry;
          if(layer.type==="group") {
            const originX=geometry.x+geometry.width/2,originY=geometry.y+geometry.height/2;
            return <div key={layer.id} className={`awb-layer-group ${isSelected?"is-selected":""}`} style={{position:"absolute",inset:0,transform:`rotate(${geometry.rotation}deg)`,transformOrigin:`${originX}px ${originY}px`,pointerEvents:"none"}} data-board-id={board.id} data-layer-id={layer.id}>{layer.childIds.map((childId)=>renderLayer(childId,ancestorLocked||layer.locked))}</div>;
          }
          const locked=ancestorLocked||layer.locked;
          const common={left:geometry.x,top:geometry.y,width:geometry.width,height:geometry.height,transform:`rotate(${geometry.rotation}deg)`};
          const src=layer.type==="image"?imageSource(layer,board,props.resolveAsset):undefined;
          const imageStyle=layer.type==="image"&&src?{backgroundImage:`url(${JSON.stringify(src)})`,backgroundSize:layer.fit==="fill"?"100% 100%":layer.fit,backgroundPosition:"center"}:{};
          const fontReady=layer.type!=="text"||!layer.fontHash||isArtboardFontLoaded(layer.fontHash,layer.fontStyle,layer.fontWeight);
          return <button key={layer.id} type="button" className={`awb-layer awb-layer-${layer.type} ${isSelected?"is-selected":""}`} style={{...common,...(layer.type==="shape"?{background:layer.fill.color,borderRadius:layer.shape==="ellipse"?"50%":0}:{}),...(layer.type==="text"&&fontReady?{color:layer.color,fontSize:layer.fontSize,textAlign:layer.align,fontFamily:layer.fontHash?artboardFontFamily(layer.fontHash):undefined,fontWeight:layer.fontWeight,fontStyle:layer.fontStyle,fontVariationSettings:layer.fontAxes?Object.entries(layer.fontAxes).map(([tag,value])=>`"${tag}" ${value}`).join(", "):undefined}:{}),...imageStyle,pointerEvents:"auto"}} onPointerDown={(event)=>{if(!locked)beginLayer(event,board.id,layer,"move");else{event.stopPropagation();props.onSelectLayer({boardId:board.id,layerId:layer.id});}}} onDoubleClick={(event)=>{event.stopPropagation();props.onSelectLayer({boardId:board.id,layerId:layer.id});}} aria-label={locked?t('artboard.layerLocked',{name:layer.name}):layer.name} data-board-id={board.id} data-layer-id={layer.id}>
            {layer.type==="text"?(fontReady?layer.text:t('common.loading')):null}{locked?<Lock className="awb-layer-lock" size={14/props.zoom}/>:null}{isSelected&&!locked?<span className="awb-resize" onPointerDown={(event)=>beginLayer(event,board.id,layer,"resize")}><MoveDiagonal2 size={16/props.zoom}/></span>:null}
          </button>;
        };
        return <section
          key={board.id}
          className={`awb-board ${selected ? "is-selected" : ""} ${active ? "is-active" : ""}`}
          style={{ left: placement.x, top: placement.y, width: board.document.format.width, height: board.document.format.height, background: board.document.paint.color }}
          aria-label={t('artboard.dimensions',{name:board.name,width:formatNumber(board.document.format.width),height:formatNumber(board.document.format.height)})}
          data-board-id={board.id}
          onPointerDown={(event) => { event.stopPropagation(); props.onSelectBoard(board.id, event.shiftKey || event.metaKey); }}
        >
          <button className="awb-board-label" type="button" onPointerDown={(event) => beginBoardMove(event, board.id)} onClick={() => props.onSelectBoard(board.id, false)}>
            <span>{board.name}</span><small>{formatNumber(board.document.format.width)} × {formatNumber(board.document.format.height)}</small>
          </button>
          {board.document.rootLayerIds.map((id)=>renderLayer(id))}
        </section>;
      })}
    </div>
  </div>;
}
