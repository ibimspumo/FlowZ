import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow, ViewportPortal, type Connection, type FinalConnectionState, type OnConnectStartParams } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { AlertTriangle, Database, Group, History, LayoutTemplate, Library, LoaderCircle, MousePointer2, Pencil, Play, Redo2, RotateCcw, Sparkles, Square, Trash2, Ungroup, Undo2, X } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { connectionCreatesCycle, flowEdgeToGraph, nextInputOrder, portValueType } from './app/adapters';
import { ModuleNodeComponent } from './components/ModuleNodeComponent';
import { RecoveryBoundary } from './components/RecoveryBoundary';
import { NodeMenu, type NodeMenuState, type PendingConnection } from './components/NodeMenu';
import { AssetPalette } from './components/AssetPalette';
import { OrphanRunsPalette } from './components/OrphanRunsPalette';
import { assetCanvasNodePosition, assetNodeConfig, assetNodeKind, assetValue, decodeAssetDrag, FLOWZ_ASSET_MIME, isCompatibleAssetTarget, isCurrentAssetProject, loadAssetForCurrentProject } from './components/asset-drag';
import { getLibraryAssetContent, getLibraryAssetReference, type LibraryAssetPayload, type LibraryAssetSummary } from './persistence/assets';
import { assetVersionDirectMediaBinding, directMediaBindingFromConfig, DIRECT_MEDIA_TARGETS } from './nodes/direct-media';
import { registry, typeColors } from './registry';
import { currentExecutionFingerprint, displayParameters, FLOW_COVER_INVALIDATED_EVENT, persistedTranscriptionTimestamps, useFlowStore } from './store';
import type { DataType, FlowEdge, FlowNodeData, NodeKind } from './types';
import { cancelMediaStage, clearMediaImportCancellation, finalizeMediaStage, isMediaImportCancellationRequested, mediaDisplay, mediaHistoryParameters, stageDroppedMedia } from './persistence/media';
import { isDesktopRuntime } from './persistence/projects';
import { loadLibraryResultData, reassignResult, type LibraryResult } from './persistence/library';
import type { WorkflowGroup } from './domain/project';
import type { FlowNode } from './types';
import { hasNodeExecution, leaseNodeExecution, summarizeExecutionCosts } from './engine/node-execution-bridge';
import { eligibleAutomaticTargets, executeWorkflow, type FailureDecision, type WorkflowFailure } from './engine/workflow-execution';
import { createExecutionPlan } from './engine/planner';
import { createWorkflowRunSession, type WorkflowRunSession } from './engine/workflow-session';
import { areProductPortsCompatible, areValueTypesCompatible } from './engine/compatibility';
import { ModalDialog } from './components/ModalDialog';
import { formatCurrency, formatDate, localizeErrorMessage, t as translate, useI18n } from './i18n';
import { DocumentTabs, type DocumentTabTarget } from './home/DocumentTabs';
import { appShortcut, boundedSession, cycledTarget, loadStoredSession, persistStoredSession, saveStateForFlowStore, tabForActive } from './home/app-shell';
import { emptySession, reduceSession } from './home/session';
import { selectCatalog, type CatalogQuery } from './home/catalog';
import type { AppSession, DocumentRecord, DocumentViewState } from './home/types';
import type { HomeContextMenuState } from './home/HomeScreen';
import './home/shell.css';
import type { ArtboardDocumentRepository, OpenArtboardDocument } from './artboard-workspace/repository';
import { ARTBOARD_NODE_LINK_EVENT, ARTBOARD_NODE_OPEN_EVENT, type ArtboardNodeBinding, type ArtboardNodeRequest } from './artboard-workspace/node-bridge';
import { artboardNodeOutputs } from './artboard-workspace/node-reference';
import { operationBatch } from './artboard-workspace/operations';
import type { DeleteDocumentResult, DocumentCatalogRecord } from './home/catalog-api';
import type { ArtboardInputSnapshot } from './nodes/brand/artboard-domain';
import { catalogRecordToDocument, newOperationId, operationIdForDuplicateAttempt, reconcileSessionWithCatalog, removeDocumentEverywhere, replaceDocumentEverywhere, validateDocumentName, type DocumentAction } from './home/document-actions';
import type { DocumentCoverCoordinator } from './home/document-covers';
import { mediaUrl } from './persistence/media';

const LazyHomeScreen = lazy(() => import('./home/HomeScreen').then((module) => ({ default: module.HomeScreen })));
const LazyDocumentActionDialog = lazy(() => import('./home/DocumentActionDialog').then((module) => ({ default: module.DocumentActionDialog })));
const LazyArtboardDocumentSurface = lazy(() => import('./artboard-workspace/ArtboardDocumentSurface').then((module) => ({ default: module.ArtboardDocumentSurface })));
const LazySettings = lazy(() => import('./components/Settings').then((module) => ({ default: module.Settings })));
const LazyDataManagerPalette = lazy(() => import('./components/DataManagerPalette').then((module) => ({ default: module.DataManagerPalette })));
const lazyDesktopArtboardRepository: ArtboardDocumentRepository = {
  list: () => import('./artboard-workspace/repository').then((module) => module.desktopArtboardRepository.list()),
  create: (name) => import('./artboard-workspace/repository').then((module) => module.desktopArtboardRepository.create(name)),
  open: (id) => import('./artboard-workspace/repository').then((module) => module.desktopArtboardRepository.open(id)),
  apply: (opened, batch) => import('./artboard-workspace/repository').then((module) => module.desktopArtboardRepository.apply(opened, batch)),
  undo: (opened) => import('./artboard-workspace/repository').then((module) => module.desktopArtboardRepository.undo(opened)),
  redo: (opened) => import('./artboard-workspace/repository').then((module) => module.desktopArtboardRepository.redo(opened)),
};

const NODE_WIDTH = 310;
const PORT_TOP = 54;
const PORT_GAP = 26;

function baseHandleId(handleId: string | null | undefined) {
  return handleId?.split('::')[0] ?? '';
}

function pointerPosition(event: MouseEvent | TouchEvent) {
  if ('touches' in event) {
    const touch = event.changedTouches[0] ?? event.touches[0];
    return { x: touch.clientX, y: touch.clientY };
  }
  return { x: event.clientX, y: event.clientY };
}

const NON_EXECUTABLE_KINDS = new Set<NodeKind>(['textInput','imageInput','videoInput','audioInput','imageCollection','videoCollection','assetText','assetImage','unsupported']);

function WorkflowGroups({ groups, nodes, onRun, onDelete }: { groups: readonly WorkflowGroup[]; nodes: readonly FlowNode[]; onRun: (group: WorkflowGroup) => void; onDelete: (group: WorkflowGroup) => void }) {
  const {t}=useI18n();
  const renameGroup = useFlowStore((state) => state.renameGroup); const ungroup = useFlowStore((state) => state.ungroup);
  const [editing, setEditing] = useState<string>(); const [draft, setDraft] = useState('');
  return <ViewportPortal>{groups.map((group) => {
    const members = nodes.filter((node) => group.nodeIds.includes(node.id)); if (!members.length) return null;
    const left = Math.min(...members.map((node) => node.position.x)) - 28; const top = Math.min(...members.map((node) => node.position.y)) - 54;
    const right = Math.max(...members.map((node) => node.position.x + (node.measured?.width ?? NODE_WIDTH))) + 28;
    const bottom = Math.max(...members.map((node) => node.position.y + (node.measured?.height ?? 220))) + 28;
    const finishRename = () => { if (draft.trim()) renameGroup(group.id, draft); setEditing(undefined); };
    return <section key={group.id} className="workflow-group" style={{ left, top, width: right - left, height: bottom - top, '--group-color': group.color ?? '#ec4899' } as CSSProperties}>
      <header onPointerDown={(event) => event.stopPropagation()}>
        {editing === group.id ? <input autoFocus value={draft} aria-label={t('canvas.groupName')} onChange={(event) => setDraft(event.target.value)} onBlur={finishRename} onKeyDown={(event) => { if (event.key === 'Enter') finishRename(); if (event.key === 'Escape') setEditing(undefined); }} /> : <strong>{group.name}</strong>}
        <span>{t('common.nodes',{count:group.nodeIds.length})}</span>
        <button type="button" onClick={() => onRun(group)} aria-label={t('canvas.groupRun',{name:group.name})} title={t('canvas.groupRun',{name:group.name})}><Play size={12} fill="currentColor" /></button>
        <button type="button" onClick={() => { setDraft(group.name); setEditing(group.id); }} aria-label={t('canvas.groupRename',{name:group.name})} title={t('canvas.groupRename',{name:group.name})}><Pencil size={12} /></button>
        <button type="button" onClick={() => ungroup(group.id)} aria-label={t('canvas.groupUngroup',{name:group.name})} title={t('canvas.groupUngroup',{name:group.name})}><Ungroup size={12} /></button>
        <button type="button" onClick={() => onDelete(group)} aria-label={t('canvas.groupDelete',{name:group.name})} title={t('canvas.groupDelete',{name:group.name})}><Trash2 size={12} /></button>
      </header>
    </section>;
  })}</ViewportPortal>;
}

export function Workspace({ projectId, initialViewState, onViewStateChange }: { projectId?: string; initialViewState?: Extract<DocumentViewState, { kind: 'flow' }>; onViewStateChange?: (documentId: string, viewState: DocumentViewState) => void }) {
  const {t}=useI18n();
  const store = useFlowStore();
  const { nodes, edges, onNodesChange, onEdgesChange, connect, reconnect, deleteEdge, addNode, reset, document, phase } = store;
  const { screenToFlowPosition } = useReactFlow();
  const [assetPaletteOpen, setAssetPaletteOpen] = useState(false);
  const [orphanRunsOpen, setOrphanRunsOpen] = useState(false);
  const [dataManagerOpen, setDataManagerOpen] = useState(false);
  const [draggedAsset, setDraggedAsset] = useState<LibraryAssetSummary>();
  const [assetDropTarget, setAssetDropTarget] = useState<string>();
  const [assetNotice, setAssetNotice] = useState('');
  const [menu, setMenu] = useState<NodeMenuState | null>(null);
  const [showEmptyHelp, setShowEmptyHelp] = useState(true);
  const [workflowRun, setWorkflowRun] = useState<{ label: string; completed: number; total: number }>();
  const [workflowFailure, setWorkflowFailure] = useState<WorkflowFailure>();
  const [costPreflight, setCostPreflight] = useState<{ paid: number; estimateMicrounits: number; unknown: number }>();
  const [confirmation, setConfirmation] = useState<{ title: string; message: string; confirmLabel: string; action: () => void }>();
  const assetTriggerRef = useRef<HTMLButtonElement>(null);
  const workflowAbortRef = useRef<AbortController | undefined>(undefined);
  const failureResolverRef = useRef<((decision: FailureDecision) => void) | undefined>(undefined);
  const workflowBusyRef = useRef(false);
  const workflowSessionRef = useRef<WorkflowRunSession | undefined>(undefined);
  const costResolverRef = useRef<((accepted: boolean) => void) | undefined>(undefined);
  const reconnecting = useRef(false);
  const reconnectingEdgeId = useRef<string | undefined>(undefined);
  const reconnectSuccessful = useRef(true);
  const nodeTypes = useMemo(() => ({ flowNode: ModuleNodeComponent }), []);
  const dropNodes = useMemo(() => nodes.map((node) => {
    if (!draggedAsset) return node;
    const compatible = isCompatibleAssetTarget(draggedAsset.kind, node.data.kind);
    return { ...node, className: `${node.className ?? ''} asset-drop-candidate ${compatible ? 'asset-drop-compatible' : 'asset-drop-incompatible'} ${assetDropTarget === node.id ? 'asset-drop-current' : ''}` };
  }), [nodes, draggedAsset, assetDropTarget]);

  useEffect(() => { void store.initialize(projectId); }, [projectId]);
  useEffect(() => {
    if (!projectId || document?.id !== projectId || initialViewState?.kind !== 'flow') return;
    const selectedNodes = new Set(initialViewState.selectedNodeIds);
    const selectedEdges = new Set(initialViewState.selectedEdgeIds);
    store.onNodesChange(nodes.map((node) => ({ id: node.id, type: 'select' as const, selected: selectedNodes.has(node.id) })));
    store.onEdgesChange(edges.map((edge) => ({ id: edge.id, type: 'select' as const, selected: selectedEdges.has(edge.id) })));
  }, [projectId, document?.id]);
  useEffect(() => () => {
    const current = useFlowStore.getState();
    if (!projectId || current.document?.id !== projectId) return;
    onViewStateChange?.(projectId, {
      kind: 'flow',
      viewport: current.document.canvas.viewport,
      selectedNodeIds: current.nodes.filter((node) => node.selected).map((node) => node.id),
      selectedEdgeIds: current.edges.filter((edge) => edge.selected).map((edge) => edge.id),
    });
    if (isDesktopRuntime()) void current.flushPendingSave().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Flow konnte beim Schließen der Arbeitsfläche nicht gespeichert werden.', error);
      window.dispatchEvent(new CustomEvent('flowz-persistence-error', { detail: { message } }));
    });
  }, [projectId, onViewStateChange]);
  useEffect(() => {
    if (!document?.id) return;
    setShowEmptyHelp(localStorage.getItem(`flowz-empty-help-dismissed:${document.id}`) !== '1');
  }, [document?.id]);
  useEffect(() => {
    if (!assetNotice) return;
    const timeout = window.setTimeout(() => setAssetNotice(''), 3600);
    return () => window.clearTimeout(timeout);
  }, [assetNotice]);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return;
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, [contenteditable="true"]')) return;
      event.preventDefault();
      if (event.shiftKey) store.redo(); else store.undo();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [store.undo, store.redo]);

  const runWorkflow = useCallback(async (targetNodeIds: readonly string[] | undefined, label: string, requireCostPreflight = true) => {
    if (workflowBusyRef.current) return;
    const current = useFlowStore.getState(); const projectId = current.document?.id; const graph = current.document?.graph; if (!graph || !projectId) return;
    const snapshots = current.nodes.map((node) => ({ id: node.id, updatePolicy: node.data.updatePolicy, status: node.data.status, executable: !NON_EXECUTABLE_KINDS.has(node.data.kind) && hasNodeExecution(projectId, node.id) }));
    const plan = createExecutionPlan({ nodes: graph.nodes, edges: graph.edges }, { targetNodeIds });
    const candidates = plan.orderedNodeIds.filter((id) => { const node = snapshots.find((item) => item.id === id); return node?.executable && node.updatePolicy !== 'frozen' && node.status !== 'fresh' && node.status !== 'running'; });
    const leases = new Map(candidates.flatMap((id) => { const lease = leaseNodeExecution(projectId, id); return lease ? [[id, lease] as const] : []; }));
    const session = createWorkflowRunSession(projectId, plan, leases); workflowSessionRef.current = session; workflowAbortRef.current = session.controller; workflowBusyRef.current = true;
    setWorkflowRun({ label, completed: 0, total: candidates.length });
    try {
      const costs = summarizeExecutionCosts(leases.values());
      if (requireCostPreflight && costs.paid) {
        const accepted = await new Promise<boolean>((resolve) => { costResolverRef.current = resolve; setCostPreflight(costs); });
        if (!accepted) { session.controller.abort(); return; }
      }
      const revalidate = async (nodeId: string): Promise<'run'|'fresh'|'blocked'> => {
        while (!session.controller.signal.aborted) {
          const state = useFlowStore.getState(); if (state.document?.id !== session.projectId || !state.document.graph.nodes.some((node) => node.id === nodeId)) return 'blocked';
          const predecessors = state.document.graph.edges.filter((edge) => edge.targetNodeId === nodeId).map((edge) => state.nodes.find((node) => node.id === edge.sourceNodeId)).filter(Boolean) as FlowNode[];
          if (predecessors.some((node) => node.data.status === 'running')) { await new Promise((resolve) => setTimeout(resolve, 50)); continue; }
          if (predecessors.some((node) => !NON_EXECUTABLE_KINDS.has(node.data.kind) && node.data.updatePolicy !== 'frozen' && node.data.status !== 'fresh')) return 'blocked';
          const currentNode = state.nodes.find((node) => node.id === nodeId); if (!currentNode || !session.leases.has(nodeId) || !currentExecutionFingerprint(nodeId)) return 'blocked';
          return currentNode.data.status === 'fresh' ? 'fresh' : 'run';
        }
        return 'blocked';
      };
      const result = await executeWorkflow({ nodes: snapshots, graphNodes: graph.nodes, edges: graph.edges, plan: session.plan, signal: session.controller.signal,
        execute: async (nodeId) => { const lease = session.leases.get(nodeId); if (!lease || lease.projectId !== session.projectId) throw new Error('Ausführungs-Handler gehört nicht zu diesem Projekt.'); await lease.execute(); },
        cancel: async (nodeId) => { await session.leases.get(nodeId)?.cancel(); }, revalidate,
        onProgress: (completed, total) => setWorkflowRun({ label, completed, total }),
        onFailure: (failure) => new Promise<FailureDecision>((resolve) => { failureResolverRef.current = resolve; setWorkflowFailure(failure); }),
      });
      setAssetNotice(result.state === 'completed' ? translate('canvas.workflowDone',{label,executed:result.executed.length,skipped:result.skipped.length?translate('canvas.workflowSkipped',{count:result.skipped.length}):''}) : result.state === 'cancelled' ? translate('canvas.workflowCancelled',{label}) : translate('canvas.workflowErrored',{label}));
    } catch { setAssetNotice(translate('canvas.workflowPlanFailed',{label})); }
    finally { workflowBusyRef.current = false; workflowAbortRef.current = undefined; workflowSessionRef.current = undefined; failureResolverRef.current = undefined; costResolverRef.current = undefined; setCostPreflight(undefined); setWorkflowFailure(undefined); setWorkflowRun(undefined); }
  }, []);

  const cancelWorkflow = useCallback(() => {
    workflowAbortRef.current?.abort(); failureResolverRef.current?.('abort'); failureResolverRef.current = undefined; costResolverRef.current?.(false); costResolverRef.current = undefined; setCostPreflight(undefined); setWorkflowFailure(undefined);
  }, []);

  useEffect(() => {
    if (workflowBusyRef.current) return;
    if (!document) return;
    const snapshots = nodes.map((node) => ({ id: node.id, updatePolicy: node.data.updatePolicy, status: node.data.status, executable: !NON_EXECUTABLE_KINDS.has(node.data.kind) }));
    const automatic = eligibleAutomaticTargets(snapshots, document.graph.edges);
    if (!automatic.length) return;
    const timer = window.setTimeout(() => void runWorkflow(automatic, translate('canvas.autoUpdate'), false), 700);
    return () => window.clearTimeout(timer);
  }, [nodes, document, runWorkflow]);

  useEffect(() => {
    const session = workflowSessionRef.current; if (!session) return;
    const ids = new Set(document?.graph.nodes.map((node) => node.id) ?? []);
    if (document?.id !== session.projectId || session.plan.orderedNodeIds.some((id) => !ids.has(id))) cancelWorkflow();
  }, [document?.id, document?.graph.nodes, cancelWorkflow]);

  const closeAssetPalette = useCallback(() => {
    setAssetPaletteOpen(false);
    window.requestAnimationFrame(() => assetTriggerRef.current?.focus());
  }, []);
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let disposed = false; let unlisten: (() => void) | undefined;
    void import('@tauri-apps/api/event').then(async ({ listen }) => {
      unlisten = await listen<{ token?: string; pathCount: number; x: number; y: number }>('flowz-media-drop', async ({ payload }) => {
        if (disposed) return;
        if (payload.pathCount !== 1 || !payload.token) { setAssetNotice(translate('canvas.importOneMedia')); return; }
        const scale = window.devicePixelRatio || 1;
        const element = window.document.elementFromPoint(payload.x / scale, payload.y / scale);
        const nodeId = (element?.closest('.react-flow__node') as HTMLElement | null)?.dataset.id;
        const target = nodeId ? useFlowStore.getState().nodes.find((node) => node.id === nodeId) : undefined;
        if (!target || (target.data.kind !== 'videoInput' && target.data.kind !== 'audioInput')) { setAssetNotice(translate('canvas.dropMediaTarget')); return; }
        const expectedProjectId = useFlowStore.getState().document?.id;
        let stageId: string | undefined;
        const operationId = crypto.randomUUID();
        window.dispatchEvent(new CustomEvent('flowz-media-import-state', { detail: { nodeId: target.id, operationId } }));
        try {
          if (!expectedProjectId) return;
          const kind = target.data.kind === 'videoInput' ? 'video' : 'audio';
          const projectRevision = await useFlowStore.getState().flushPendingSave();
          if (isMediaImportCancellationRequested(operationId)) throw new Error('Medienimport abgebrochen.');
          const staged = await stageDroppedMedia(payload.token, kind, expectedProjectId, target.id, projectRevision, operationId); stageId = staged.stageId;
          let current = useFlowStore.getState(); const currentTarget = current.nodes.find((node) => node.id === target.id);
          if (!stageId) throw new Error('Der Medienimport hat keine Staging-ID geliefert.');
          if (current.document?.id !== expectedProjectId || currentTarget?.data.kind !== target.data.kind) { await cancelMediaStage(stageId); return; }
          await useFlowStore.getState().flushPendingSave();
          if (isMediaImportCancellationRequested(operationId)) throw new Error('Medienimport abgebrochen.');
          const imported = await finalizeMediaStage(stageId, kind, expectedProjectId, target.id); stageId = undefined;
          current = useFlowStore.getState();
          if (current.document?.id !== expectedProjectId) return;
          const latest = current.nodes.find((node) => node.id === target.id)?.data;
          const history = imported.resultId ? [{ id: imported.resultId, createdAt: imported.createdAt, value: imported.hash, model: 'Lokaler Import', parameters: mediaHistoryParameters(imported), assetId: imported.assetId, blobHash: imported.hash, mediaType: imported.mediaType, persisted: true, active: true }, ...(latest?.history ?? []).map((item) => ({ ...item, active: false }))] : latest?.history;
          current.updateNode(target.id, { ...mediaDisplay(imported), value: imported.hash, history, assetId: imported.assetId, persisted: true, status: 'fresh', error: undefined }, true);
          current.endGesture();
          setAssetNotice(translate('canvas.mediaImported',{name:imported.originalName??'Medium'}));
        } catch (error) {
          if (stageId) await cancelMediaStage(stageId).catch(() => undefined);
          if (!/abgebrochen/i.test(String(error)) && useFlowStore.getState().document?.id === expectedProjectId) useFlowStore.getState().updateNode(target.id, { status: 'error', error: error instanceof Error ? error.message : String(error) });
        } finally {
          clearMediaImportCancellation(operationId);
          window.dispatchEvent(new CustomEvent('flowz-media-import-state', { detail: { nodeId: target.id } }));
        }
      });
    }).catch(() => undefined);
    return () => { disposed = true; unlisten?.(); };
  }, []);

  const openMenu = useCallback((client: { x: number; y: number }, pending?: PendingConnection, initialView?: NodeMenuState['initialView']) => {
    const width = 264; const height = 330; const margin = 10;
    setMenu({
      screen: { x: Math.min(client.x, window.innerWidth - width - margin), y: Math.min(client.y, window.innerHeight - height - margin) },
      flow: screenToFlowPosition(client),
      pending,
      initialView,
    });
  }, [screenToFlowPosition]);

  function validConnection(connection: { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }) {
    const source = nodes.find((node) => node.id === connection.source); const target = nodes.find((node) => node.id === connection.target);
    if (!source || !target || source.id === target.id) return false;
    const outputType = portValueType(source.data.kind, 'output', connection.sourceHandle ?? '');
    const inputType = portValueType(target.data.kind, 'input', connection.targetHandle ?? '');
    const input = registry[target.data.kind].inputs.find((item) => item.id === baseHandleId(connection.targetHandle));
    if (!outputType || !inputType || !input || !areValueTypesCompatible(outputType,inputType) || (!input.multiple && edges.some((edge) => edge.id !== reconnectingEdgeId.current && edge.target === target.id && baseHandleId(edge.targetHandle) === baseHandleId(connection.targetHandle)))) return false;
    if (!document || !connection.sourceHandle || !connection.targetHandle) return true;
    const targetPort = baseHandleId(connection.targetHandle);
    const candidate = flowEdgeToGraph({ id: 'candidate', source: source.id, sourceHandle: connection.sourceHandle, target: target.id, targetHandle: targetPort }, nextInputOrder(document, target.id, targetPort));
    return !connectionCreatesCycle(document, candidate, reconnectingEdgeId.current);
  }

  function handlePaneContextMenu(event: MouseEvent | ReactMouseEvent) {
    event.preventDefault();
    openMenu({ x: event.clientX, y: event.clientY });
  }

  function handleConnectEnd(event: MouseEvent | TouchEvent, state: FinalConnectionState) {
    if (reconnecting.current) return;
    store.endGesture();
    if (state.isValid || !state.fromNode || !state.fromHandle?.id || !state.fromHandle.type) return;
    const fromNode = nodes.find((node) => node.id === state.fromNode?.id);
    if (!fromNode) return;
    const definition = registry[fromNode.data.kind];
    const port = state.fromHandle.type === 'source'
      ? definition.outputs.find((output) => output.id === state.fromHandle?.id)
      : definition.inputs.find((input) => input.id === baseHandleId(state.fromHandle?.id));
    if (!port) return;
    openMenu(pointerPosition(event), { nodeId: fromNode.id, handleId: state.fromHandle.id, handleType: state.fromHandle.type, dataType: port.type, ...(port.artifact?{artifact:port.artifact}:{}) });
  }

  function handleConnectStart(_: MouseEvent | TouchEvent, params: OnConnectStartParams) {
    store.beginGesture();
    if (params.handleType !== 'target' || !params.nodeId || !params.handleId) return;
    const occupied = edges.find(
      (edge) =>
        edge.target === params.nodeId &&
        edge.targetHandle === params.handleId,
    );
    if (occupied) deleteEdge(occupied.id);
  }

  function handleReconnectStart(_: ReactMouseEvent, edge: FlowEdge) {
    store.beginGesture();
    reconnecting.current = true;
    reconnectingEdgeId.current = edge.id;
    reconnectSuccessful.current = false;
    setMenu(null);
  }

  function handleReconnect(edge: FlowEdge, connection: Connection) {
    reconnectSuccessful.current = true;
    reconnect(edge, connection);
  }

  function handleReconnectEnd(_: MouseEvent | TouchEvent, edge: FlowEdge) {
    if (!reconnectSuccessful.current) deleteEdge(edge.id);
    reconnecting.current = false;
    reconnectingEdgeId.current = undefined;
    reconnectSuccessful.current = true;
    store.endGesture();
  }

  function selectNode(kind: NodeKind) {
    if (!menu) return;
    const definition = registry[kind];
    const pending = menu.pending;
    let position = { x: menu.flow.x - NODE_WIDTH / 2, y: menu.flow.y - 32 };
    let connection: Connection | null = null;

    if (pending?.handleType === 'source') {
      const inputIndex = definition.inputs.findIndex((input) => areProductPortsCompatible({type:pending.dataType,...(pending.artifact?{artifact:pending.artifact}:{})},input));
      const input = definition.inputs[inputIndex];
      if (!input) return;
      position = { x: menu.flow.x, y: menu.flow.y - PORT_TOP - inputIndex * PORT_GAP };
      const newId = addNode(kind, position);
      connection = { source: pending.nodeId, sourceHandle: pending.handleId, target: newId, targetHandle: input.id };
    } else if (pending?.handleType === 'target') {
      const outputIndex = definition.outputs.findIndex((output) => areProductPortsCompatible(output,{type:pending.dataType,...(pending.artifact?{artifact:pending.artifact}:{})}));
      const output = definition.outputs[outputIndex];
      if (!output) return;
      position = { x: menu.flow.x - NODE_WIDTH, y: menu.flow.y - PORT_TOP - outputIndex * PORT_GAP };
      const newId = addNode(kind, position);
      connection = { source: newId, sourceHandle: output.id, target: pending.nodeId, targetHandle: pending.handleId };
    } else {
      addNode(kind, position);
    }

    if (connection) connect(connection);
    setMenu(null);
  }

  function insertAsset(item: LibraryAssetPayload, destination: { projectId: string; targetNodeId?: string }, flowPosition?: { x: number; y: number }) {
    const current = useFlowStore.getState();
    if (!isCurrentAssetProject(destination.projectId, current.document?.id)) throw new Error('Das Projekt wurde während des Ladens gewechselt. Es wurde nichts verändert.');
    if (destination.targetNodeId) {
      const target = current.nodes.find((node) => node.id === destination.targetNodeId);
      if (!target || !isCompatibleAssetTarget(item.kind, target.data.kind) || !current.bindAssetToNode(target.id, item)) {
        throw new Error('Die gewählte Eingabe ist nicht mehr verfügbar oder nicht kompatibel.');
      }
      setAssetNotice(translate('canvas.assetReplaced',{node:target.data.label,asset:item.name,version:item.version}));
      return;
    }
    const position = flowPosition ?? screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const image = item.kind === 'image';
    const value = assetValue(item);
    if (!value) throw new Error('Die Asset-Version enthält keinen verwendbaren Inhalt.');
    const id = current.addNode(assetNodeKind(item.kind), assetCanvasNodePosition(position, NODE_WIDTH), assetNodeConfig(item));
    current.updateNode(id, { value, outputValues: image ? { image: value } : { text: value }, status: 'fresh', persisted: true, assetId: item.assetId }, true);
    current.endGesture();
    setAssetNotice(translate('canvas.assetInserted',{asset:item.name,type:image?'Image':'Text'}));
  }

  function nodeIdAtEvent(event: ReactDragEvent): string | undefined {
    return ((event.target as Element | null)?.closest('.react-flow__node') as HTMLElement | null)?.dataset.id;
  }

  function handleAssetDragOver(event: ReactDragEvent) {
    if (!draggedAsset) return;
    const targetId = nodeIdAtEvent(event);
    const target = targetId ? nodes.find((node) => node.id === targetId) : undefined;
    event.preventDefault();
    event.dataTransfer.dropEffect = !target || isCompatibleAssetTarget(draggedAsset.kind, target.data.kind) ? 'copy' : 'none';
    setAssetDropTarget(targetId);
  }

  async function handleAssetDrop(event: ReactDragEvent) {
    if (!draggedAsset && !Array.from(event.dataTransfer.types).includes(FLOWZ_ASSET_MIME)) return;
    event.preventDefault(); event.stopPropagation();
    const summary = decodeAssetDrag(event.dataTransfer.getData(FLOWZ_ASSET_MIME)) ?? draggedAsset;
    const targetId = nodeIdAtEvent(event);
    const expectedProjectId = useFlowStore.getState().document?.id;
    if (!expectedProjectId) return;
    const dropPosition = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    setAssetDropTarget(undefined); setDraggedAsset(undefined);
    if (!summary) { setAssetNotice(translate('canvas.invalidAsset')); return; }
    const target = targetId ? nodes.find((node) => node.id === targetId) : undefined;
    if (target && !isCompatibleAssetTarget(summary.kind, target.data.kind)) {
      setAssetNotice(translate('canvas.assetMismatch',{type:summary.kind==='image'?'Images':'Texts'}));
      return;
    }
    try {
      if (target && summary.kind === 'image' && DIRECT_MEDIA_TARGETS.has(target.data.kind)) {
        const reference = await getLibraryAssetReference(summary.versionId);
        const current = useFlowStore.getState();
        if (current.document?.id !== expectedProjectId) return;
        const previous = directMediaBindingFromConfig(target.data as unknown as Record<string, import('./domain/project').JsonValue>);
        if (!current.bindDirectMediaToNode(target.id, assetVersionDirectMediaBinding(summary, reference, previous?.priority ?? 'fallback'))) throw new Error('Die Asset-Version konnte nicht sicher an diese Node gebunden werden.');
        setAssetNotice(translate('canvas.assetReplaced',{node:target.data.label,asset:summary.name,version:summary.version}));
        return;
      }
      const loaded = await loadAssetForCurrentProject(expectedProjectId, () => useFlowStore.getState().document?.id, () => getLibraryAssetContent(summary.versionId));
      if (loaded.status === 'superseded') return;
      insertAsset(loaded.value, { projectId: expectedProjectId, ...(target ? { targetNodeId: target.id } : {}) }, dropPosition);
    } catch (reason) {
      setAssetNotice(translate('canvas.assetInsertFailed'));
    }
  }

  async function restoreOrphanResult(result: LibraryResult) {
    const currentProject = useFlowStore.getState().document;
    const image=Boolean(result.blobHash&&result.mediaType?.startsWith('image/'));
    if ((!result.textValue&&!image) || !currentProject || result.projectId !== currentProject.id) return;
    const textValue = result.textValue ?? '';
    const position = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const nodeId = useFlowStore.getState().addNode(image?'imageInput':'textInput', { x: position.x - NODE_WIDTH / 2, y: position.y - 40 }, image ? {} : { text: textValue });
    try {
      await useFlowStore.getState().flushPendingSave();
      await reassignResult(currentProject.id, result.resultId, nodeId);
      const cost = result.costMicrounits == null ? undefined : result.costMicrounits / 1_000_000;
      const parameters = displayParameters(result.parameters);
      const timestamps = persistedTranscriptionTimestamps(result.parameters);
      const imageValue=image?await loadLibraryResultData(currentProject.id,result.resultId):undefined;
      if (image && !imageValue) throw new Error('Das gespeicherte Bild konnte nicht geladen werden.');
      useFlowStore.getState().updateNode(nodeId, image?{
        value:imageValue,blobHash:result.blobHash,mediaType:result.mediaType,assetId:result.assetId,outputValues:{image:`flowz-cas:${result.blobHash}`},status:'fresh',persisted:true,cost,
        history:[{id:result.resultId,createdAt:result.createdAt,value:imageValue??'',blobHash:result.blobHash,mediaType:result.mediaType,assetId:result.assetId,cost,model:result.model,parameters,persisted:true,active:true}],
      }:{
        value: textValue, outputValues: { text: textValue }, status: 'fresh', persisted: true, cost,
        history: [{ id: result.resultId, createdAt: result.createdAt, value: textValue, cost, model: result.model, parameters, timestamps, persisted: true, active: true }],
      }, true);
      setOrphanRunsOpen(false); setAssetNotice(translate('canvas.orphanRestored',{type:image?'Image':'Text'}));
    } catch (error) {
      useFlowStore.getState().deleteNode(nodeId);
      setAssetNotice(translate('canvas.restoreFailed'));
    }
  }

  if (phase === 'booting') return <div className="project-loading" role="status"><div className="loading-mark"><Sparkles size={18} /></div><div><strong>{t('canvas.loadingTitle')}</strong><span>{t('canvas.loadingBody')}</span></div></div>;
  if (phase === 'error' || !document) return <div className="project-failure" role="alert"><AlertTriangle size={22} /><strong>{t('canvas.failedTitle')}</strong><p>{store.projectError ?? t('common.error')}</p><button className="secondary" onClick={() => location.reload()}>{t('canvas.retry')}</button></div>;

  const saveLabel = store.saveState === 'saving' ? t('save.saving') : store.saveState === 'dirty' ? t('save.dirty') : store.saveState === 'saved' ? t('save.saved') : store.saveState === 'offline' ? t('save.offline') : store.saveState === 'conflict' ? t('save.conflict') : store.saveState === 'error' ? t('save.error') : t('save.local');
  const groupedNodeIds = new Set(document.graph.groups.flatMap((group) => group.nodeIds));
  const groupableSelection = nodes.filter((node) => node.selected && !groupedNodeIds.has(node.id)).map((node) => node.id);
  const protectedResultIds = new Set(nodes.flatMap((node) => [
    ...(node.data.collectionResultIds ?? []), ...(node.data.fanOutResultIds ?? []),
    ...(node.data.history ?? []).filter((item) => item.active).map((item) => item.id),
    ...((node.data.directMedia as {source?:{kind?:string;resultId?:string}}|undefined)?.source?.kind === 'project-result'
      ? [String((node.data.directMedia as {source:{resultId:string}}).source.resultId)] : []),
  ]));
  for (const edge of edges) if (edge.sourceHandle?.startsWith('variant:')) protectedResultIds.add(edge.sourceHandle.slice('variant:'.length));
  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-mark"><Sparkles size={15} /></div><strong>FlowZ</strong><div className="project-switcher-wrap"><span className="project-switcher" aria-label={`Aktiver Flow: ${document.name}`}><span>{document.name}</span></span></div></div>
      <div className="top-actions"><div className="history-actions"><button className="icon-button" disabled={!store.canUndo} onClick={store.undo} aria-label={t('canvas.undo')}><Undo2 size={14} /></button><button className="icon-button" disabled={!store.canRedo} onClick={store.redo} aria-label={t('canvas.redo')}><Redo2 size={14} /></button></div><button className={`save-note ${store.saveState}`} onClick={store.saveState === 'conflict' ? () => { if (confirm(t('canvas.reloadConflict'))) void store.reloadAfterConflict(); } : store.saveState === 'error' ? store.retrySave : undefined} disabled={!['conflict','error'].includes(store.saveState)}>{store.saveState === 'saving' && <LoaderCircle className="spin" size={12} />}{['conflict','error'].includes(store.saveState) && <AlertTriangle size={12} />}{saveLabel}</button><button className={`secondary workflow-run-trigger ${workflowRun ? 'is-active' : ''}`} onClick={workflowRun ? cancelWorkflow : () => void runWorkflow(undefined, t('canvas.runStale'))} aria-label={workflowRun ? t('canvas.cancelRun') : t('canvas.runStale')}>{workflowRun ? <Square size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}{workflowRun ? `${workflowRun.completed}/${workflowRun.total} · ${t('common.cancel')}` : t('canvas.runStale')}</button><button ref={assetTriggerRef} className={`secondary ${assetPaletteOpen ? 'is-active' : ''}`} aria-pressed={assetPaletteOpen} onClick={() => assetPaletteOpen ? closeAssetPalette() : setAssetPaletteOpen(true)}><Library size={15} />{t('canvas.assets')}</button><button className={`secondary ${dataManagerOpen ? 'is-active' : ''}`} aria-pressed={dataManagerOpen} onClick={() => setDataManagerOpen((open) => !open)}><Database size={15} />{t('canvas.storage')}</button><button className={`secondary ${orphanRunsOpen ? 'is-active' : ''}`} aria-pressed={orphanRunsOpen} onClick={() => setOrphanRunsOpen((open) => !open)}><History size={15} />{t('canvas.unassigned')}</button></div>
    </header>
    <main className="canvas-wrap" onContextMenu={(event) => event.preventDefault()}>
      <ReactFlow key={document.id} nodes={dropNodes} edges={edges.map((edge) => ({ ...edge, type: 'default', reconnectable: true, style: { stroke: typeColors[edge.data?.dataType ?? 'text'], strokeWidth: 2 } }))} nodeTypes={nodeTypes} onlyRenderVisibleElements onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={connect} onConnectStart={handleConnectStart} onConnectEnd={handleConnectEnd} onReconnectStart={handleReconnectStart} onReconnect={handleReconnect} onReconnectEnd={handleReconnectEnd} reconnectRadius={12} edgesReconnectable onPaneContextMenu={handlePaneContextMenu} onPaneClick={() => { setMenu(null); store.setProjectMenuOpen(false); }} onDragOver={handleAssetDragOver} onDrop={(event) => void handleAssetDrop(event)} isValidConnection={validConnection} defaultViewport={initialViewState?.viewport ?? document.canvas.viewport} onMoveStart={() => store.beginGesture()} onMoveEnd={(_, viewport) => { store.setViewport(viewport); store.endGesture(); }} onNodeDragStart={() => store.beginGesture()} onNodeDragStop={() => store.endGesture()} fitView={document.graph.nodes.length > 0 && !initialViewState && document.canvas.viewport.zoom === 1 && document.canvas.viewport.x === 0 && document.canvas.viewport.y === 0} fitViewOptions={{ padding: 0.18 }} minZoom={0.2} maxZoom={1.8} colorMode="dark" deleteKeyCode={['Backspace','Delete']}>
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--canvas-dot)" />
        <WorkflowGroups groups={document.graph.groups} nodes={nodes} onRun={(group) => void runWorkflow(group.nodeIds, group.name)} onDelete={(group) => setConfirmation({ title: t('canvas.deleteWorkflowTitle'), message: t('canvas.deleteWorkflowMessage',{name:group.name,count:group.nodeIds.length}), confirmLabel: t('canvas.deleteWorkflow'), action: () => { cancelWorkflow(); store.deleteGroupNodes(group.id); } })} />
        <Controls position="bottom-left" showInteractive={false} />
        <MiniMap position="bottom-right" pannable zoomable maskColor="oklch(0.08 0 0 / 0.72)" nodeColor="oklch(0.29 0.012 355)" />
      </ReactFlow>
      {groupableSelection.length >= 2 && <button className="group-selection-action" onClick={() => store.createGroup(groupableSelection)}><Group size={13} />{t('canvas.groupSelected',{count:groupableSelection.length})}</button>}
      <div className="canvas-hint"><MousePointer2 size={13} /><span>{t('canvas.rightClick')}</span></div>
      {document.graph.nodes.length === 0 && showEmptyHelp && <div className="canvas-empty"><button className="canvas-empty-dismiss" aria-label={t('canvas.dismiss')} onClick={() => { localStorage.setItem(`flowz-empty-help-dismissed:${document.id}`,'1'); setShowEmptyHelp(false); }}><X size={12}/></button><Sparkles size={18} /><strong>{t('canvas.emptyQuestion')}</strong><span>{t('canvas.emptyExplanation')}</span><div><button className="primary" onClick={() => openMenu({x:window.innerWidth/2,y:window.innerHeight/2},undefined,'templates')}><LayoutTemplate size={13}/>{t('canvas.chooseTemplate')}</button><button className="secondary" onClick={() => openMenu({x:window.innerWidth/2,y:window.innerHeight/2},undefined,'nodes')}>{t('canvas.addNode')}</button></div></div>}
      {document.graph.nodes.length === 0 && !showEmptyHelp && <button className="empty-help-reopen" onClick={() => { localStorage.removeItem(`flowz-empty-help-dismissed:${document.id}`); setShowEmptyHelp(true); }}><Sparkles size={12}/>{t('canvas.openIntro')}</button>}
      {store.pendingLegacyImports.assets.length > 0 && <div className="migration-note"><AlertTriangle size={13} /><span>{t('canvas.legacyMedia',{count:store.pendingLegacyImports.assets.length})}</span></div>}
      <button className="reset-flow" onClick={() => setConfirmation({ title: t('canvas.exampleTitle'), message: t('canvas.exampleMessage'), confirmLabel: t('canvas.loadExample'), action: () => { cancelWorkflow(); reset(); } })}><RotateCcw size={13} />{t('canvas.loadExample')}</button>
      {menu && <NodeMenu state={menu} onSelect={selectNode} onSelectTemplate={(template) => { if (store.insertTemplate(template, menu.flow)) setAssetNotice(t('canvas.templateInserted',{name:template.name})); setMenu(null); }} onClose={() => setMenu(null)} />}
      <AssetPalette projectId={document.id} open={assetPaletteOpen} onClose={closeAssetPalette} onInsert={insertAsset} compatibleTargets={nodes.map((node) => ({ id: node.id, label: node.data.label, kind: node.data.kind }))} onAssetDrag={(asset) => { setDraggedAsset(asset); if (!asset) setAssetDropTarget(undefined); }} />
      {orphanRunsOpen && <OrphanRunsPalette projectId={document.id} onClose={() => setOrphanRunsOpen(false)} onRestore={restoreOrphanResult} />}
      {dataManagerOpen ? <Suspense fallback={null}><LazyDataManagerPalette open projectId={document.id} projectName={document.name} nodeNames={new Map(nodes.map((node)=>[node.id,node.data.label]))} protectedResultIds={protectedResultIds} onClose={()=>setDataManagerOpen(false)} onChanged={async()=>{await useFlowStore.getState().refreshPersistedResults();}} onProjectDeleted={async()=>{setDataManagerOpen(false);await useFlowStore.getState().createAndOpenProject(t('canvas.newFlowName'));}} /></Suspense> : null}
      <div className="asset-drop-status" role="status" aria-live="polite">{assetNotice}</div>
      <div className="workflow-live-status" role="status" aria-live="polite">{workflowRun ? `${workflowRun.label}: ${workflowRun.completed} von ${workflowRun.total}` : ''}</div>
    </main>
    <ModalDialog open={Boolean(workflowFailure)} className="workflow-failure-dialog" label={t('common.error')} onClose={() => { failureResolverRef.current?.('abort'); failureResolverRef.current = undefined; setWorkflowFailure(undefined); }}>
      <header><AlertTriangle size={18} /><div><strong>{t('canvas.workflowFailed')}</strong><span>{nodes.find((node) => node.id === workflowFailure?.nodeId)?.data.label ?? workflowFailure?.nodeId}</span></div></header>
      <p>{workflowFailure?localizeErrorMessage(workflowFailure.message):''}</p>
      <footer><button className="secondary" onClick={() => { failureResolverRef.current?.('skip'); failureResolverRef.current = undefined; setWorkflowFailure(undefined); }}>{t('canvas.skip')}</button><button className="secondary danger" onClick={() => { failureResolverRef.current?.('abort'); failureResolverRef.current = undefined; setWorkflowFailure(undefined); }}>{t('canvas.abortRemaining')}</button><button className="primary" onClick={() => { failureResolverRef.current?.('retry'); failureResolverRef.current = undefined; setWorkflowFailure(undefined); }}>{t('canvas.retry')}</button></footer>
    </ModalDialog>
    <ModalDialog open={Boolean(costPreflight)} className="workflow-failure-dialog" label={t('canvas.paidTitle')} onClose={() => { costResolverRef.current?.(false); costResolverRef.current = undefined; setCostPreflight(undefined); }}>
      <header><AlertTriangle size={18} /><div><strong>{t('canvas.paidTitle')}</strong><span>{t('canvas.paidCount',{count:costPreflight?.paid??0})}</span></div></header>
      <p>{costPreflight?.estimateMicrounits ? `${t('canvas.costEstimate',{amount:formatCurrency(costPreflight.estimateMicrounits/1_000_000)})} ` : ''}{costPreflight?.unknown ? `${t('canvas.costUnknown',{count:costPreflight.unknown})} ` : ''}{t('canvas.costExcluded')}</p>
      <footer><button className="secondary" onClick={() => { costResolverRef.current?.(false); costResolverRef.current = undefined; setCostPreflight(undefined); }}>{t('common.cancel')}</button><button className="primary" onClick={() => { costResolverRef.current?.(true); costResolverRef.current = undefined; setCostPreflight(undefined); }}>{t('canvas.runPaid')}</button></footer>
    </ModalDialog>
    <ModalDialog open={Boolean(confirmation)} className="workflow-failure-dialog" label={confirmation?.title ?? t('canvas.confirmAction')} onClose={() => setConfirmation(undefined)}>
      <header><AlertTriangle size={18} /><div><strong>{confirmation?.title}</strong></div></header><p>{confirmation?.message}</p>
      <footer><button className="secondary" onClick={() => setConfirmation(undefined)}>{t('common.cancel')}</button><button className="primary" onClick={() => { const action = confirmation?.action; setConfirmation(undefined); action?.(); }}>{confirmation?.confirmLabel}</button></footer>
    </ModalDialog>
  </div>;
}

export interface FlowZAppShellProps {
  artboardRepository?: ArtboardDocumentRepository;
  documentCatalogActions?: {
    list: () => Promise<DocumentCatalogRecord[]>;
    create: (kind: 'flow' | 'artboard', name: string, operationId: string) => Promise<DocumentCatalogRecord>;
    rename: (record: Pick<DocumentCatalogRecord, 'id' | 'kind' | 'revision'>, name: string) => Promise<DocumentCatalogRecord>;
    duplicate: (record: Pick<DocumentCatalogRecord, 'id' | 'kind' | 'revision'>, name: string | undefined, operationId: string) => Promise<DocumentCatalogRecord>;
    delete: (record: Pick<DocumentCatalogRecord, 'id' | 'kind' | 'revision'>, confirmationFingerprint?: string) => Promise<DeleteDocumentResult>;
  };
}

const defaultDocumentCatalogActions: NonNullable<FlowZAppShellProps['documentCatalogActions']> = {
  list: () => import('./home/catalog-api').then((module) => module.listDocuments()),
  create: (kind, name, operationId) => import('./home/catalog-api').then((module) => module.createDocument(kind, name, operationId)),
  rename: (record, name) => import('./home/catalog-api').then((module) => module.renameDocument(record, name)),
  duplicate: (record, name, operationId) => import('./home/catalog-api').then((module) => module.duplicateDocument(record, name, operationId)),
  delete: (record, confirmationFingerprint) => import('./home/catalog-api').then((module) => module.deleteDocument(record, confirmationFingerprint)),
};

export function FlowZAppShell({ artboardRepository = lazyDesktopArtboardRepository, documentCatalogActions = defaultDocumentCatalogActions }: FlowZAppShellProps) {
  const { t } = useI18n();
  const [catalog, setCatalog] = useState<DocumentRecord[]>([]);
  const [session, setSession] = useState<AppSession>(() => emptySession());
  const [sessionReady, setSessionReady] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string>();
  const [query, setQuery] = useState<CatalogQuery>({ search: '', filter: 'all', sort: 'updated' });
  const [selectedDocumentId, setSelectedDocumentId] = useState<string>();
  const [contextMenu, setContextMenu] = useState<HomeContextMenuState>();
  const [notice, setNotice] = useState('');
  const [documentAction, setDocumentAction] = useState<DocumentAction>();
  const [documentActionBusy, setDocumentActionBusy] = useState(false);
  const [documentActionError, setDocumentActionError] = useState<string>();
  const [artboardLinkRequest, setArtboardLinkRequest] = useState<ArtboardNodeRequest>();
  const [availableArtboardSnapshots, setAvailableArtboardSnapshots] = useState<ArtboardInputSnapshot[]>([]);
  const [shellSettingsOpen, setShellSettingsOpen] = useState(false);
  const storeDocumentId = useFlowStore((state) => state.document?.id);
  const storeSaveState = useFlowStore((state) => state.saveState);
  const closeInFlightRef = useRef(false);
  const artboardFlushRef = useRef<(() => Promise<void>) | undefined>(undefined);
  const artboardCompositeGenerationRef = useRef(new Map<string, number>());
  const artboardCompositeChainRef = useRef(new Map<string, Promise<void>>());
  const coverCoordinatorRef = useRef<DocumentCoverCoordinator | undefined>(undefined);

  const applyCatalogSnapshot = useCallback((records: readonly DocumentCatalogRecord[]) => {
    const documents = records.map(catalogRecordToDocument);
    setCatalog(documents);
    setSession((current) => reconcileSessionWithCatalog(current, documents));
    return documents;
  }, []);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let disposed=false;let coordinator:DocumentCoverCoordinator|undefined;
    void import('./home/document-covers').then(({DocumentCoverCoordinator})=>{
      if(disposed)return;
      coordinator = new DocumentCoverCoordinator({
        list: documentCatalogActions.list,
        openArtboard: artboardRepository.open,
        onCover: (documentId, cover, source) => {
          const current = catalogRecordToDocument({ ...source, cover });
          setCatalog((items) => items.map((item) => item.id === documentId ? current : item));
        },
      });
      coverCoordinatorRef.current = coordinator;
      return documentCatalogActions.list().then((records) => coordinator?.scheduleMissing(records.map(catalogRecordToDocument)));
    }).catch(()=>undefined);
    return () => { disposed=true;coordinator?.dispose();if(coverCoordinatorRef.current===coordinator)coverCoordinatorRef.current=undefined; };
  }, [artboardRepository, documentCatalogActions]);

  const flushBeforeCatalogAction = useCallback(async () => {
    const current = useFlowStore.getState();
    if (current.document && isDesktopRuntime()) await current.flushPendingSave();
    if (artboardFlushRef.current) await artboardFlushRef.current();
  }, []);

  const refreshActionDocument = useCallback(async (requested: DocumentRecord) => {
    await flushBeforeCatalogAction();
    const records = await documentCatalogActions.list();
    const fresh = records.find((record) => record.id === requested.id && record.kind === requested.kind);
    if (!fresh || fresh.revision === undefined) throw new Error('Das Projekt wurde zwischenzeitlich entfernt oder kann nicht sicher bearbeitet werden.');
    applyCatalogSnapshot(records);
    return { apiRecord: fresh, document: catalogRecordToDocument(fresh) };
  }, [applyCatalogSnapshot, documentCatalogActions, flushBeforeCatalogAction]);

  useEffect(() => {
    const reportPersistenceError = (event: Event) => {
      const message = (event as CustomEvent<{ message?: string }>).detail?.message;
      setNotice(message || 'Der aktuelle Stand konnte nicht sicher gespeichert werden.');
    };
    window.addEventListener('flowz-persistence-error', reportPersistenceError);
    return () => window.removeEventListener('flowz-persistence-error', reportPersistenceError);
  }, []);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      const appWindow = getCurrentWindow();
      unlisten = await appWindow.onCloseRequested(async (event) => {
        event.preventDefault();
        if (closeInFlightRef.current) return;
        closeInFlightRef.current = true;
        try {
          const current = useFlowStore.getState();
          if (current.document) await current.flushPendingSave();
          if (artboardFlushRef.current) await artboardFlushRef.current();
          if (!disposed) await appWindow.destroy();
        } catch (error) {
          if (!disposed) setNotice(error instanceof Error ? error.message : String(error));
          closeInFlightRef.current = false;
        }
      });
    }).catch((error) => {
      console.error('Sicheres Speichern beim Schließen konnte nicht eingerichtet werden.', error);
      if (!disposed) setNotice('Sicheres Speichern beim Schließen konnte nicht eingerichtet werden.');
    });
    return () => { disposed = true; unlisten?.(); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setCatalogLoading(true);
    documentCatalogActions.list().then((records) => {
      if (cancelled) return;
      const documents = records.map(catalogRecordToDocument);
      setCatalog(documents);
      setSession(loadStoredSession(typeof localStorage === 'undefined' ? undefined : localStorage, documents));
      setSessionReady(true);
      setCatalogError(undefined);
    }).catch((error) => {
      if (cancelled) return;
      setCatalogError(error instanceof Error ? error.message : String(error));
      setSession(emptySession());
      setSessionReady(true);
    }).finally(() => { if (!cancelled) setCatalogLoading(false); });
    return () => { cancelled = true; };
  }, [documentCatalogActions]);

  useEffect(() => {
    if (sessionReady) persistStoredSession(typeof localStorage === 'undefined' ? undefined : localStorage, session);
  }, [session, sessionReady]);

  useEffect(() => {
    if (!storeDocumentId) return;
    const nextSaveState = saveStateForFlowStore(storeSaveState);
    setSession((current) => current.openDocuments.some((tab) => tab.documentId === storeDocumentId && tab.saveState !== nextSaveState)
      ? reduceSession(current, { type: 'save-state', documentId: storeDocumentId, saveState: nextSaveState })
      : current);
  }, [storeDocumentId, storeSaveState]);
  useEffect(() => { if (storeDocumentId && storeSaveState === 'saved') coverCoordinatorRef.current?.schedule(storeDocumentId); }, [storeDocumentId, storeSaveState]);
  useEffect(() => {
    const invalidate = (event: Event) => {
      const documentId = (event as CustomEvent<{ documentId?: string }>).detail?.documentId;
      if (documentId) coverCoordinatorRef.current?.schedule(documentId);
    };
    window.addEventListener(FLOW_COVER_INVALIDATED_EVENT, invalidate);
    return () => window.removeEventListener(FLOW_COVER_INVALIDATED_EVENT, invalidate);
  }, []);

  const openDocumentTab = useCallback((document: DocumentRecord) => {
    if (document.health.state !== 'healthy') return;
    setSession((current) => boundedSession(reduceSession(current, { type: 'open', document, at: new Date().toISOString() })));
    setSelectedDocumentId(document.id);
    setContextMenu(undefined);
  }, []);

  const openDocument = useCallback(async (document: DocumentRecord) => {
    if (document.kind === 'flow') { openDocumentTab(document); return; }
    openDocumentTab(document);
  }, [openDocumentTab]);

  const createDocument = useCallback(async (kind: 'flow' | 'artboard') => {
    setNotice('');
    try {
      await flushBeforeCatalogAction();
      const created = catalogRecordToDocument(await documentCatalogActions.create(kind, kind === 'flow' ? 'Neuer Flow' : 'Neues Artboard', newOperationId()));
      setCatalog((items) => [...items.filter((item) => item.id !== created.id), created]);
      coverCoordinatorRef.current?.schedule(created.id);
      await openDocument(created);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  }, [documentCatalogActions, flushBeforeCatalogAction, openDocument]);

  const updateFlowViewState = useCallback((documentId: string, viewState: DocumentViewState) => {
    setSession((current) => current.openDocuments.some((tab) => tab.documentId === documentId && tab.kind === viewState.kind)
      ? reduceSession(current, { type: 'update-view', documentId, viewState })
      : current);
  }, []);

  const closeTab = useCallback(async (documentId: string) => {
    const tab = session.openDocuments.find((item) => item.documentId === documentId);
    if (!tab) return;
    if (tab.kind === 'flow' && useFlowStore.getState().document?.id === documentId && isDesktopRuntime()) {
      try { await useFlowStore.getState().flushPendingSave(); }
      catch (error) { setNotice(error instanceof Error ? error.message : String(error)); return; }
    }
    if (tab.kind === 'artboard' && session.active.surface === 'document' && session.active.documentId === documentId && artboardFlushRef.current) {
      try { await artboardFlushRef.current(); }
      catch (error) { setNotice(error instanceof Error ? error.message : String(error)); return; }
    }
    setSession((current) => reduceSession(current, { type: 'close', documentId, discardDirty: true }));
  }, [session.active, session.openDocuments]);

  const activateTarget = useCallback(async (target: DocumentTabTarget) => {
    const currentTab = tabForActive(session);
    if (target.surface === 'document' && currentTab?.documentId === target.documentId) return;
    if (currentTab?.kind === 'flow' && useFlowStore.getState().document?.id === currentTab.documentId) {
      const current = useFlowStore.getState();
      if (current.document) updateFlowViewState(currentTab.documentId, {
        kind: 'flow', viewport: current.document.canvas.viewport,
        selectedNodeIds: current.nodes.filter((node) => node.selected).map((node) => node.id),
        selectedEdgeIds: current.edges.filter((edge) => edge.selected).map((edge) => edge.id),
      });
      if (isDesktopRuntime()) {
        try { await current.flushPendingSave(); }
        catch (error) { setNotice(error instanceof Error ? error.message : String(error)); return; }
      }
    }
    if (currentTab?.kind === 'artboard' && artboardFlushRef.current) {
      try { await artboardFlushRef.current(); }
      catch (error) { setNotice(error instanceof Error ? error.message : String(error)); return; }
    }
    setSession((current) => target.surface === 'home' ? reduceSession(current, { type: 'show-home' }) : reduceSession(current, { type: 'activate', documentId: target.documentId, at: new Date().toISOString() }));
  }, [session, updateFlowViewState]);

  const applyArtboardNodeBinding = useCallback((binding: ArtboardNodeBinding) => {
    const state = useFlowStore.getState();
    if (state.document?.id === binding.flowId && state.document.graph.nodes.some((node) => node.id === binding.nodeId)) {
      const patch: Partial<FlowNodeData> = {
        artboardWorkspaceId: binding.workspaceId, artboardWorkspaceName: binding.workspaceName,
        artboardRevisionId: binding.revisionId, artboardRevisionNumber: binding.revisionNumber,
        artboardInputSnapshotId: binding.inputSnapshotId, artboardLinkedInputSignature: binding.linkedInputSignature,
        artboardPreviewSvg: binding.previewSvg, artboardActiveImageHash: binding.activeImageHash,
        artboardSelectedImageHashes: binding.selectedImageHashes, status: 'fresh', persisted: true,
      };
      const graphNode = state.nodes.find((node) => node.id === binding.nodeId);
      const outputs = artboardNodeOutputs({ ...(graphNode?.data ?? { kind:'artboard',label:'Artboard',status:'fresh',updatePolicy:'manual' }), ...patch } as FlowNodeData);
      patch.value = typeof outputs.artboard === 'string' ? outputs.artboard : undefined;
      patch.outputValues = outputs;
      state.updateNode(binding.nodeId, patch, true);
    }
  }, []);

  const commitArtboardNodeBinding = useCallback((opened: OpenArtboardDocument, request: ArtboardNodeRequest) => {
    const key = `${request.flowId}\0${request.nodeId}\0${opened.record.id}`;
    const generation = (artboardCompositeGenerationRef.current.get(key) ?? 0) + 1;
    artboardCompositeGenerationRef.current.set(key, generation);
    const previous = artboardCompositeChainRef.current.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      if (artboardCompositeGenerationRef.current.get(key) !== generation) return;
      const { artboardBindingFromRevision, persistedArtboardBindingFromRevision } = await import('./artboard-workspace/node-linking');
      const before = useFlowStore.getState();
      if (before.document?.id !== request.flowId || !before.nodes.some((node) => node.id === request.nodeId)) return;
      const mustPersistReference = before.nodes.find((node) => node.id === request.nodeId)?.data.artboardWorkspaceId !== opened.record.id;
      // The native composite boundary verifies the durable Flow node link.
      // Publish and flush the compact reference first on an initial link;
      // pixels are added only after the atomic CAS batch succeeds.
      applyArtboardNodeBinding(artboardBindingFromRevision(opened, request));
      if (mustPersistReference && isDesktopRuntime()) await useFlowStore.getState().flushPendingSave();
      if (artboardCompositeGenerationRef.current.get(key) !== generation) return;
      const binding = await persistedArtboardBindingFromRevision(opened, request);
      if (artboardCompositeGenerationRef.current.get(key) !== generation) return;
      applyArtboardNodeBinding(binding);
    });
    artboardCompositeChainRef.current.set(key, run);
    void run.finally(() => {
      if (artboardCompositeChainRef.current.get(key) === run) artboardCompositeChainRef.current.delete(key);
    }).catch(() => undefined);
    return run;
  }, [applyArtboardNodeBinding]);

  const updateLinkedNodeFromRevision = useCallback((opened: OpenArtboardDocument) => {
    coverCoordinatorRef.current?.schedule(opened.record.id);
    const state = useFlowStore.getState();
    if (!state.document) return;
    const flowId = state.document.id;
    const linkedNodeIds = state.nodes
      .filter((node) => node.data.kind === 'artboard' && node.data.artboardWorkspaceId === opened.record.id)
      .map((node) => node.id);
    if (!linkedNodeIds.length) return;
    void import('./artboard-workspace/node-linking').then(({ artboardNodeRequestFromFlow }) => {
      for (const nodeId of linkedNodeIds) {
        const request = artboardNodeRequestFromFlow(flowId, nodeId, state.nodes, state.edges);
        void commitArtboardNodeBinding(opened, request).catch((error: unknown) => setNotice(error instanceof Error ? error.message : String(error)));
      }
    }).catch((error: unknown) => setNotice(error instanceof Error ? error.message : String(error)));
  }, [commitArtboardNodeBinding]);

  const linkAndOpenArtboard = useCallback(async (request: ArtboardNodeRequest, workspaceId: string) => {
    setNotice(''); setArtboardLinkRequest(undefined);
    let provisionalReference: Partial<FlowNodeData> | undefined;
    let snapshotApplied = false;
    try {
      const flow = useFlowStore.getState();
      if (flow.document?.id !== request.flowId) throw new Error('Der ursprüngliche Flow ist nicht mehr aktiv. Öffne ihn und verknüpfe das Artboard erneut.');
      const opened = await artboardRepository.open(workspaceId);
      if (!opened) throw new Error('Das ausgewählte Artboard wurde nicht gefunden.');
      const { createArtboardInputSnapshot } = await import('./artboard-workspace/node-linking');
      const snapshot = await createArtboardInputSnapshot(request, flow.nodes, flow.edges);
      const currentNode = flow.nodes.find((node) => node.id === request.nodeId);
      if (!currentNode) throw new Error('Die Artboard-Node wurde nicht gefunden.');
      if (currentNode.data.artboardWorkspaceId !== workspaceId) {
        provisionalReference = {
          artboardWorkspaceId: currentNode.data.artboardWorkspaceId,
          artboardWorkspaceName: currentNode.data.artboardWorkspaceName,
        };
        // The native snapshot boundary validates the exact source edge against
        // the durably linked target node. Persist only this reversible pointer
        // before applying the immutable snapshot.
        flow.updateNode(request.nodeId, { artboardWorkspaceId: workspaceId, artboardWorkspaceName: opened.revision.workspace.name }, false);
        if (isDesktopRuntime()) await useFlowStore.getState().flushPendingSave();
      }
      const boardId = opened.revision.workspace.activeBoardId;
      const linked = await artboardRepository.apply(opened, operationBatch({ id: opened.revision.id, number: opened.revision.revisionNumber }, [{ type:'set-board-inputs', boardId, snapshot }], 'flow-link'));
      snapshotApplied = true;
      await commitArtboardNodeBinding(linked, request);
      if (isDesktopRuntime()) await useFlowStore.getState().flushPendingSave();
      const document = catalog.find((item) => item.kind === 'artboard' && item.id === workspaceId)
        ?? (await artboardRepository.list()).find((item) => item.id === workspaceId);
      if (!document) throw new Error('Das verknüpfte Artboard fehlt im Dokumentkatalog.');
      openDocumentTab(document); await activateTarget({ surface:'document', documentId:workspaceId });
    } catch (error) {
      if (provisionalReference && !snapshotApplied) {
        const current = useFlowStore.getState();
        if (current.document?.id === request.flowId && current.nodes.some((node) => node.id === request.nodeId)) {
          current.updateNode(request.nodeId, provisionalReference, false);
          if (isDesktopRuntime()) await current.flushPendingSave().catch(() => undefined);
        }
      }
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }, [activateTarget, artboardRepository, catalog, commitArtboardNodeBinding, openDocumentTab]);

  const createLinkedArtboard = useCallback(async () => {
    const request = artboardLinkRequest; if (!request) return;
    try {
      await flushBeforeCatalogAction();
      const document = catalogRecordToDocument(await documentCatalogActions.create('artboard', 'Neues Artboard', newOperationId()));
      setCatalog((items) => [...items.filter((item) => item.id !== document.id), document]);
      await linkAndOpenArtboard(request, document.id);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  }, [artboardLinkRequest, documentCatalogActions, flushBeforeCatalogAction, linkAndOpenArtboard]);

  useEffect(() => {
    const open = (event: Event) => {
      const request = (event as CustomEvent<ArtboardNodeRequest>).detail;
      const document = request.workspaceId ? catalog.find((item) => item.kind === 'artboard' && item.id === request.workspaceId) : undefined;
      if (!document) { setNotice('Das verknüpfte Artboard wurde nicht gefunden.'); return; }
      openDocumentTab(document); void activateTarget({ surface:'document', documentId:document.id });
    };
    const link = (event: Event) => {
      const request = (event as CustomEvent<ArtboardNodeRequest>).detail;
      if (request.workspaceId) void linkAndOpenArtboard(request, request.workspaceId);
      else setArtboardLinkRequest(request);
    };
    window.addEventListener(ARTBOARD_NODE_OPEN_EVENT, open); window.addEventListener(ARTBOARD_NODE_LINK_EVENT, link);
    return () => { window.removeEventListener(ARTBOARD_NODE_OPEN_EVENT, open); window.removeEventListener(ARTBOARD_NODE_LINK_EVENT, link); };
  }, [activateTarget, catalog, linkAndOpenArtboard, openDocumentTab]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const shortcut = appShortcut(event); if (!shortcut) return;
      if (shortcut.type === 'activate-home') { event.preventDefault(); void activateTarget({ surface: 'home' }); return; }
      if (shortcut.type === 'activate-tab') {
        const tab = session.openDocuments[shortcut.index]; if (!tab) return;
        event.preventDefault(); void activateTarget({ surface: 'document', documentId: tab.documentId }); return;
      }
      if (shortcut.type === 'cycle-tabs') { event.preventDefault(); void activateTarget(cycledTarget(session, shortcut.direction)); return; }
      if (shortcut.type === 'new-flow') { event.preventDefault(); void createDocument('flow'); return; }
      const active = tabForActive(session); if (active) { event.preventDefault(); void closeTab(active.documentId); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activateTarget, closeTab, createDocument, session]);

  const requestDocumentAction = useCallback((kind: DocumentAction['kind'], document: DocumentRecord) => {
    setContextMenu(undefined); setDocumentActionError(undefined); setDocumentActionBusy(false);
    if (kind === 'rename') setDocumentAction({ kind, document, name: document.name });
    else if (kind === 'duplicate') setDocumentAction({ kind, document, name: t('document.defaultCopyName', { name: document.name }), operationId: newOperationId() });
    else setDocumentAction({ kind, document, references: [], confirmationFingerprint: undefined });
  }, [t]);

  const submitDocumentAction = useCallback(async (submittedName?: string) => {
    const action = documentAction; if (!action || documentActionBusy) return;
    const name = submittedName?.trim();
    if (action.kind !== 'delete') {
      const validationError = validateDocumentName(name ?? '');
      if (validationError) { setDocumentActionError(validationError); return; }
    }
    setDocumentActionBusy(true); setDocumentActionError(undefined); setNotice('');
    try {
      const fresh = await refreshActionDocument(action.document);
      const duplicateOperationId = action.kind === 'duplicate'
        ? operationIdForDuplicateAttempt(
          { operationId: action.operationId, name: action.name, revision: action.document.revision },
          { name: name!, revision: fresh.document.revision },
        )
        : newOperationId();
      setDocumentAction(action.kind === 'rename'
        ? { ...action, document: fresh.document, name: name! }
        : action.kind === 'duplicate'
          ? { ...action, document: fresh.document, name: name!, operationId: duplicateOperationId }
          : { ...action, document: fresh.document });
      if (action.kind === 'rename') {
        const renamed = catalogRecordToDocument(await documentCatalogActions.rename(fresh.apiRecord, name!));
        setCatalog((current) => replaceDocumentEverywhere(current, emptySession(), renamed).catalog);
        setSession((current) => replaceDocumentEverywhere([], current, renamed).session);
        setDocumentAction(undefined);
        coverCoordinatorRef.current?.schedule(renamed.id);
        if (renamed.kind === 'flow' && useFlowStore.getState().document?.id === renamed.id) {
          try { await useFlowStore.getState().openExistingProject(renamed.id); setNotice(t('document.renamed', { name: renamed.name })); }
          catch { setNotice(t('document.renamedFlowDeferred', { name: renamed.name })); }
        } else setNotice(t('document.renamed', { name: renamed.name }));
      } else if (action.kind === 'duplicate') {
        const duplicate = catalogRecordToDocument(await documentCatalogActions.duplicate(fresh.apiRecord, name, duplicateOperationId));
        setCatalog((current) => replaceDocumentEverywhere(current, emptySession(), duplicate).catalog);
        coverCoordinatorRef.current?.schedule(duplicate.id);
        setSelectedDocumentId(duplicate.id); setDocumentAction(undefined); setNotice(t('document.duplicated', { name: duplicate.name }));
      } else {
        const result = await documentCatalogActions.delete(fresh.apiRecord, action.confirmationFingerprint);
        if (result.requiresConfirmation && !result.deleted) {
          setDocumentAction({ kind: 'delete', document: fresh.document, references: result.references, confirmationFingerprint: result.confirmationFingerprint });
          return;
        }
        if (!result.deleted) throw new Error(t('document.deleteFailed'));
        const loadedFlowId = useFlowStore.getState().document?.id;
        setCatalog((current) => removeDocumentEverywhere(current, emptySession(), action.document.id).catalog);
        setSession((current) => removeDocumentEverywhere([], current, action.document.id).session);
        setSelectedDocumentId((current) => current === action.document.id ? undefined : current);
        coverCoordinatorRef.current?.cancel(action.document.id);
        setDocumentAction(undefined); setNotice(t('document.deleted', { name: action.document.name }));
        if (loadedFlowId && result.references.some((reference) => reference.flowId === loadedFlowId)) {
          try { await useFlowStore.getState().openExistingProject(loadedFlowId); }
          catch { setNotice(t('document.deletedFlowDeferred', { name: action.document.name })); }
        }
        try { applyCatalogSnapshot(await documentCatalogActions.list()); }
        catch { setNotice(t('document.deletedCatalogDeferred', { name: action.document.name })); }
      }
    } catch (error) {
      setDocumentActionError(error instanceof Error ? error.message : String(error));
    } finally { setDocumentActionBusy(false); }
  }, [applyCatalogSnapshot, documentAction, documentActionBusy, documentCatalogActions, refreshActionDocument, t]);

  const activeTab = tabForActive(session);
  useEffect(() => {
    let cancelled = false;
    if (!activeTab || activeTab.kind !== 'artboard') { setAvailableArtboardSnapshots([]); return; }
    const flow = useFlowStore.getState();
    if (!flow.document) { setAvailableArtboardSnapshots([]); return; }
    const linked = flow.nodes.filter((node) => node.data.kind === 'artboard' && node.data.artboardWorkspaceId === activeTab.documentId);
    void import('./artboard-workspace/node-linking').then(async ({ artboardNodeRequestFromFlow, createArtboardInputSnapshot }) => {
      const snapshots = await Promise.all(linked.map((node) => {
        const request = artboardNodeRequestFromFlow(flow.document!.id, node.id, flow.nodes, flow.edges);
        return createArtboardInputSnapshot(request, flow.nodes, flow.edges);
      }));
      if (!cancelled) setAvailableArtboardSnapshots(snapshots);
    }).catch((reason: unknown) => { if (!cancelled) setNotice(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancelled = true; };
  }, [activeTab?.documentId, activeTab?.kind]);
  const visibleDocuments = useMemo(() => selectCatalog(catalog, query), [catalog, query]);

  return <div className="flowz-root-shell">
    <DocumentTabs tabs={session.openDocuments} active={session.active} onActivate={(target) => void activateTarget(target)} onCloseRequest={(tab) => void closeTab(tab.documentId)} />
    <div className="flowz-active-surface">
      {session.active.surface === 'home' || !activeTab ? <Suspense fallback={<div className="home-shell-loading" role="status"><LoaderCircle className="spin" size={18} /></div>}><LazyHomeScreen documents={visibleDocuments} query={query} selectedDocumentId={selectedDocumentId} contextMenu={contextMenu} loading={catalogLoading} errorMessage={catalogError} resolveCoverSrc={(document) => document.cover ? `${mediaUrl(document.cover.blobHash)}?cover=${encodeURIComponent(document.cover.contentFingerprint.slice(0, 16))}` : undefined} canCreateKind={() => true} onCreate={(kind) => void createDocument(kind)} onOpenSettings={() => setShellSettingsOpen(true)} onQueryChange={setQuery} onSelect={setSelectedDocumentId} onOpen={(document) => void openDocument(document)} onRenameRequest={(document) => requestDocumentAction('rename', document)} onDuplicateRequest={(document) => requestDocumentAction('duplicate', document)} onDeleteRequest={(document) => requestDocumentAction('delete', document)} onContextMenuRequest={(request) => setContextMenu({ documentId: request.document.id, x: request.x, y: request.y })} onContextMenuClose={() => setContextMenu(undefined)} /></Suspense>
        : activeTab.kind === 'flow' ? <RecoveryBoundary scope="workspace" resetKey={activeTab.documentId}><ReactFlowProvider key={activeTab.documentId}><Workspace projectId={activeTab.documentId} initialViewState={activeTab.viewState.kind === 'flow' ? activeTab.viewState : undefined} onViewStateChange={updateFlowViewState} /></ReactFlowProvider></RecoveryBoundary>
          : <Suspense fallback={<div className="home-shell-loading" role="status"><LoaderCircle className="spin" size={18} /></div>}><LazyArtboardDocumentSurface key={activeTab.documentId} documentId={activeTab.documentId} name={activeTab.name} repository={artboardRepository} availableSnapshots={availableArtboardSnapshots} onBack={() => void activateTarget({ surface: 'home' })} onNameChange={(name) => { setCatalog((items) => items.map((item) => item.id === activeTab.documentId ? { ...item, name } : item)); setSession((current) => reduceSession(current, { type: 'rename', documentId: activeTab.documentId, name })); }} onSaveStateChange={(saveState) => setSession((current) => reduceSession(current, { type: 'save-state', documentId: activeTab.documentId, saveState }))} onRegisterFlush={(flush) => { artboardFlushRef.current = flush; }} onRevisionChange={updateLinkedNodeFromRevision} onOpenProviderSettings={() => setShellSettingsOpen(true)} /></Suspense>}
    </div>
    <ModalDialog open={Boolean(artboardLinkRequest)} className="artboard-link-dialog" label={t('artboard.linkTitle')} onClose={() => setArtboardLinkRequest(undefined)}>
      <header><Sparkles size={18} /><div><strong>{t('artboard.linkTitle')}</strong><span>{t('artboard.linkDescription')}</span></div></header>
      <div className="artboard-link-options">
        {catalog.filter((item) => item.kind === 'artboard' && item.health.state === 'healthy').map((item) => <button type="button" key={item.id} onClick={() => artboardLinkRequest && void linkAndOpenArtboard(artboardLinkRequest, item.id)}><span>{item.name}</span><small>{t('artboard.updated',{date:formatDate(item.updatedAt,{dateStyle:'medium'})})}</small></button>)}
        {!catalog.some((item) => item.kind === 'artboard' && item.health.state === 'healthy') && <p>{t('artboard.none')}</p>}
      </div>
      <footer><button type="button" className="secondary" onClick={() => setArtboardLinkRequest(undefined)}>{t('common.cancel')}</button><button type="button" className="primary" onClick={() => void createLinkedArtboard()}>{t('artboard.create')}</button></footer>
    </ModalDialog>
    <Suspense fallback={null}><LazyDocumentActionDialog action={documentAction} busy={documentActionBusy} error={documentActionError} onClose={() => { if (!documentActionBusy) { setDocumentAction(undefined); setDocumentActionError(undefined); } }} onSubmit={(name) => void submitDocumentAction(name)} /></Suspense>
    <Suspense fallback={null}><LazySettings open={shellSettingsOpen} onClose={() => setShellSettingsOpen(false)} /></Suspense>
    {notice && <div className="home-shell-notice" role="status"><span>{notice}</span><button type="button" onClick={() => setNotice('')} aria-label={translate('common.close')}><X size={13} /></button></div>}
  </div>;
}

export default function App() { return <FlowZAppShell />; }
