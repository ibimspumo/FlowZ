import { AlertTriangle, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { pickArtboardExportFolder, revealArtboardExport, writeArtboardExport, type ArtboardExportFolderGrant, type ArtboardExportResult } from "../api";
import { duplicateBoard, findBoardPlacement, validateArtboardWorkspace, type ArtboardInputSnapshot, type ArtboardPreset } from "../nodes/brand/artboard-domain";
import { mediaUrl } from "../persistence/media";
import { ArtboardExportPopover, type ArtboardExportOptions } from "./ArtboardExportPopover";
import { ArtboardWorkspace } from "./ArtboardWorkspace";
import { renderBoardExport, resolveArtboardExportFolder } from "./artboard-export";
import { operationBatch } from "./operations";
import { applyWorkspaceOperations, blankBoard, type ArtboardDocumentRepository, type OpenArtboardDocument } from "./repository";
import type { ArtboardOperationBatch } from "./types";
import type { ArtboardAssetItem } from "./types";
import { getLibraryAssetReference, getLibraryAssetThumbnail, searchLibraryAssets } from "../persistence/assets";
import { localizeErrorMessage, useI18n } from "../i18n";
import { createTauriArtboardAgentRuntime, executeArtboardImageIntent, persistPaidResultProposal, type ArtboardImageGenerationIntent } from "../artboard-agent";
import { falImageModel, type FalImageConfig } from "../nodes/image/capabilities";
import type { ArtboardAgentContext, ArtboardAgentSelection, ResolvedArtboardProposal } from "../artboard-agent-ui";
import { validateResolvedProposal } from "../artboard-agent-ui/validation";
import { assertAgentBatchMatchesHead, selectionForWorkspace, SurfaceArtboardAgentContextProvider } from "./agent-integration";
import { loadArtboardFont } from "./artboard-fonts";

export type ArtboardDocumentSurfaceProps = {
  documentId: string;
  name: string;
  repository: ArtboardDocumentRepository;
  onBack: () => void;
  onNameChange?: (name: string) => void;
  onSaveStateChange?: (state: "saved" | "dirty" | "saving" | "error") => void;
  onRegisterFlush?: (flush: (() => Promise<void>) | undefined) => void;
  onRevisionChange?: (opened: OpenArtboardDocument) => void;
  onOpenProviderSettings?: () => void;
  availableSnapshots?: ArtboardInputSnapshot[];
};

const SAVE_DELAY_MS = 2_000;

function duplicatedBoard(opened: OpenArtboardDocument, sourceBoardId: string, snapshot?: ArtboardInputSnapshot) {
  const workspace = opened.revision.workspace;
  const next = duplicateBoard(workspace, sourceBoardId, {
    boardId: crypto.randomUUID(), documentId: crypto.randomUUID(), snapshotId: crypto.randomUUID(), revisionId: crypto.randomUUID(),
  }, new Date().toISOString());
  const board = next.boards[next.activeBoardId];
  if (snapshot) { board.inputSnapshot = structuredClone(snapshot); board.document.bindings = structuredClone(snapshot.bindings); }
  return { board, placement: next.placements[board.id] };
}

export function ArtboardDocumentSurface(props: ArtboardDocumentSurfaceProps) {
  const {t}=useI18n();
  const [opened, setOpened] = useState<OpenArtboardDocument>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [exportBoardIds, setExportBoardIds] = useState<string[]>();
  const [exportFolder, setExportFolder] = useState<ArtboardExportFolderGrant>();
  const [exportOptions, setExportOptions] = useState<ArtboardExportOptions>({ includeManifest: true, overwrite: "rename" });
  const [exportBusy, setExportBusy] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportResult, setExportResult] = useState<ArtboardExportResult>();
  const [exportError, setExportError] = useState<string>();
  const [pendingAgentFollowUps, setPendingAgentFollowUps] = useState<ArtboardImageGenerationIntent[]>([]);
  const [pendingAgentFollowUpProposalId,setPendingAgentFollowUpProposalId]=useState<string>();
  const [assets, setAssets] = useState<ArtboardAssetItem[]>([]);
  const [assetTotal, setAssetTotal] = useState(0);
  const [assetPage, setAssetPage] = useState(0);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const openedRef = useRef<OpenArtboardDocument | undefined>(undefined);
  const visibleWorkspaceRef = useRef<OpenArtboardDocument["revision"]["workspace"] | undefined>(undefined);
  const pendingOperationsRef = useRef<ArtboardOperationBatch["operations"]>([]);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const loadGenerationRef = useRef(0);
  const agentApplyLockRef = useRef(false);
  const agentSelectionRef = useRef<ArtboardAgentSelection>({ activeBoardId: "", boardIds: [], layerIds: [] });
  const agentContextProviderRef = useRef<SurfaceArtboardAgentContextProvider | undefined>(undefined);
  const agentRuntimeRef = useRef<ReturnType<typeof createTauriArtboardAgentRuntime> | undefined>(undefined);
  if (!agentRuntimeRef.current) {
    const contextProvider = new SurfaceArtboardAgentContextProvider(
      () => openedRef.current,
      () => openedRef.current ? selectionForWorkspace(openedRef.current, agentSelectionRef.current) : agentSelectionRef.current,
    );
    agentContextProviderRef.current = contextProvider;
    agentRuntimeRef.current = createTauriArtboardAgentRuntime(contextProvider);
  }

  const clearSaveTimer = useCallback(() => {
    if (saveTimerRef.current !== undefined) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = undefined;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const generation = ++loadGenerationRef.current;
    clearSaveTimer(); pendingOperationsRef.current = []; openedRef.current = undefined; visibleWorkspaceRef.current = undefined;
    setOpened(undefined); setError(undefined); setExportBoardIds(undefined); setExportFolder(undefined); setExportResult(undefined); setExportError(undefined);
    props.repository.open(props.documentId).then((result) => {
      if (cancelled || generation !== loadGenerationRef.current) return;
      if (!result) setError(t('artboard.notFound'));
      else {
        openedRef.current = result; visibleWorkspaceRef.current = result.revision.workspace;
        agentSelectionRef.current = { activeBoardId: result.revision.workspace.activeBoardId, boardIds: result.revision.workspace.selectedBoardIds.length ? result.revision.workspace.selectedBoardIds : [result.revision.workspace.activeBoardId], layerIds: [] };
        setOpened(result); props.onRevisionChange?.(result);
      }
    }).catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancelled = true; clearSaveTimer(); };
  }, [clearSaveTimer, props.documentId, props.repository]);

  const loadAssetPage = useCallback(async (page: number) => {
    if (assetsLoading) return;
    setAssetsLoading(true);
    try {
      const result = await searchLibraryAssets("", "image", page, 24);
      const resolved = await Promise.all(result.items.map(async (item) => {
        const [reference, previewUrl] = await Promise.all([getLibraryAssetReference(item.versionId), getLibraryAssetThumbnail(item.versionId)]);
        return { id:item.assetId, versionId:item.versionId, name:item.name, kind:"image" as const, casHash:reference.blobHash, previewUrl, detail:item.mediaType };
      }));
      setAssets((current) => page === 0 ? resolved : [...current, ...resolved.filter((item) => !current.some((existing) => existing.versionId === item.versionId))]);
      setAssetTotal(result.total); setAssetPage(page);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setAssetsLoading(false); }
  }, [assetsLoading]);

  useEffect(() => { void loadAssetPage(0); }, [props.documentId]);

  useEffect(() => {
    if(!opened)return;
    const fonts=Object.values(opened.revision.workspace.boards).flatMap((board)=>Object.values(board.document.layers)).filter((layer)=>layer.type==="text"&&layer.fontHash);
    if(!fonts.length)return;
    let cancelled=false;
    void Promise.all(fonts.map((layer)=>layer.type==="text"&&layer.fontHash?loadArtboardFont(layer.fontHash,layer.fontStyle,layer.fontWeight):Promise.resolve(""))).then(()=>{if(!cancelled)setOpened((current)=>current?{...current}:current);}).catch((reason)=>{if(!cancelled)setError(reason instanceof Error?reason.message:String(reason));});
    return()=>{cancelled=true;};
  },[opened?.revision.id]);

  const flushPending = useCallback(async () => {
    clearSaveTimer();
    // Native persistence deliberately caps one gesture batch at 100 operations.
    // Keep headroom for future envelope operations and serialize larger agent
    // proposals deterministically instead of turning them into a rejected save.
    const operations = pendingOperationsRef.current.splice(0, 90);
    if (!operations.length) {
      await saveChainRef.current;
      if (pendingOperationsRef.current.length) await flushPending();
      return;
    }
    const generation = loadGenerationRef.current;
    const save = async () => {
      const base = openedRef.current;
      if (!base || generation !== loadGenerationRef.current) return;
      setBusy(true); setError(undefined); props.onSaveStateChange?.("saving");
      try {
        const batch = operationBatch({ id: base.revision.id, number: base.revision.revisionNumber }, operations, "autosave");
        const next = await props.repository.apply(base, batch);
        if (generation !== loadGenerationRef.current) return;
        // Selection is ephemeral UI state but travels in the workspace schema.
        // Preserve a selection changed while this request was in flight without
        // leaking still-pending content edits into the persisted revision base.
        const visible = visibleWorkspaceRef.current;
        const persistedWorkspace = visible
          ? { ...next.revision.workspace, activeBoardId: visible.activeBoardId, selectedBoardIds: visible.selectedBoardIds }
          : next.revision.workspace;
        const persisted = { ...next, revision: { ...next.revision, workspace: persistedWorkspace } };
        openedRef.current = persisted;
        if (!pendingOperationsRef.current.length) visibleWorkspaceRef.current = persistedWorkspace;
        setOpened(pendingOperationsRef.current.length && visible
          ? { ...persisted, revision: { ...persisted.revision, workspace: visible } }
          : persisted);
        props.onRevisionChange?.(persisted);
        if (next.revision.workspace.name !== base.revision.workspace.name) props.onNameChange?.(next.revision.workspace.name);
        if (!pendingOperationsRef.current.length) props.onSaveStateChange?.("saved");
      } catch (reason) {
        if (generation !== loadGenerationRef.current) return;
        const message = reason instanceof Error ? reason.message : String(reason);
        pendingOperationsRef.current = [];
        setError(message); props.onSaveStateChange?.("error");
        // Fail closed: discard the optimistic view and reopen the authoritative
        // head. A revision conflict must never become the base of another save.
        const current = await props.repository.open(props.documentId).catch(() => undefined);
        if (current && generation === loadGenerationRef.current) {
          openedRef.current = current; visibleWorkspaceRef.current = current.revision.workspace; setOpened(current);
        } else if (generation === loadGenerationRef.current) {
          openedRef.current = undefined; visibleWorkspaceRef.current = undefined; setOpened(undefined);
        }
        throw reason;
      } finally {
        if (generation === loadGenerationRef.current) setBusy(false);
      }
    };
    const queued = saveChainRef.current.then(save, save);
    saveChainRef.current = queued.catch(() => undefined);
    await queued;
    if (pendingOperationsRef.current.length) await flushPending();
  }, [clearSaveTimer, props.documentId, props.onNameChange, props.onRevisionChange, props.onSaveStateChange, props.repository]);

  const scheduleFlush = useCallback(() => {
    clearSaveTimer();
    saveTimerRef.current = setTimeout(() => { saveTimerRef.current = undefined; void flushPending().catch(() => undefined); }, SAVE_DELAY_MS);
  }, [clearSaveTimer, flushPending]);

  const persist = useCallback((batch: ArtboardOperationBatch) => {
    if (agentApplyLockRef.current) {
      setError(t('agent.editBlockedDuringApply'));
      props.onSaveStateChange?.("error");
      return;
    }
    const current = openedRef.current;
    if (!current || !batch.operations.length) return;
    try {
      const workspace = applyWorkspaceOperations(visibleWorkspaceRef.current ?? current.revision.workspace, batch.operations);
      validateArtboardWorkspace(workspace);
      visibleWorkspaceRef.current = workspace;
      setOpened((value) => value ? { ...value, revision: { ...value.revision, workspace } } : value);
      pendingOperationsRef.current.push(...batch.operations);
      props.onSaveStateChange?.("dirty");
      if (pendingOperationsRef.current.length >= 90) void flushPending().catch(() => undefined);
      else scheduleFlush();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      props.onSaveStateChange?.("error");
    }
  }, [flushPending, props.onSaveStateChange, scheduleFlush, t]);

  useEffect(() => {
    props.onRegisterFlush?.(flushPending);
    return () => props.onRegisterFlush?.(undefined);
  }, [flushPending, props.onRegisterFlush]);

  const persistOperations = (operations: ArtboardOperationBatch["operations"], prefix: string) => {
    const current = openedRef.current;
    if (current) void persist(operationBatch({ id: current.revision.id, number: current.revision.revisionNumber }, operations, prefix));
  };

  const moveHistory = async (direction: "undo" | "redo") => {
    if (!opened || busy) return;
    try { await flushPending(); } catch { return; }
    const current = openedRef.current; if (!current) return;
    setBusy(true); setError(undefined); props.onSaveStateChange?.("saving");
    try {
      const next = await props.repository[direction](current);
      openedRef.current = next; visibleWorkspaceRef.current = next.revision.workspace; setOpened(next); props.onRevisionChange?.(next); props.onSaveStateChange?.("saved");
      if (next.revision.workspace.name !== current.revision.workspace.name) props.onNameChange?.(next.revision.workspace.name);
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); props.onSaveStateChange?.("error"); }
    finally { setBusy(false); }
  };

  const prepareAgentContext = useCallback(async (): Promise<ArtboardAgentContext> => {
    await flushPending();
    const current = openedRef.current;
    if (!current) throw new Error(t('agent.workspaceClosed'));
    agentContextProviderRef.current?.pinRevision(current);
    const selection = selectionForWorkspace(current, agentSelectionRef.current);
    agentSelectionRef.current = selection;
    return {
      workspace: structuredClone(current.revision.workspace),
      branchId: current.branch.id,
      revision: { id: current.revision.id, number: current.revision.revisionNumber },
      selection: structuredClone(selection),
    };
  }, [flushPending, t]);

  const applyAgentProposal = useCallback(async (batch: ArtboardOperationBatch, proposal: ResolvedArtboardProposal) => {
    if (agentApplyLockRef.current) throw new Error(t('agent.applyAlreadyRunning'));
    agentApplyLockRef.current = true;
    try {
      await flushPending();
      const current = openedRef.current;
      if (!current) throw new Error(t('agent.workspaceClosed'));
      assertAgentBatchMatchesHead(current, batch);
      validateResolvedProposal(proposal, {
        workspace: current.revision.workspace,
        branchId: current.branch.id,
        revision: { id: current.revision.id, number: current.revision.revisionNumber },
        selection: agentSelectionRef.current,
      });
      const candidate = applyWorkspaceOperations(current.revision.workspace, batch.operations);
      validateArtboardWorkspace(candidate);
      setBusy(true); setError(undefined); props.onSaveStateChange?.("saving");
      const next = await props.repository.apply(current, batch);
      openedRef.current = next; visibleWorkspaceRef.current = next.revision.workspace; setOpened(next);
      props.onRevisionChange?.(next); props.onSaveStateChange?.("saved");
      if (next.revision.workspace.name !== current.revision.workspace.name) props.onNameChange?.(next.revision.workspace.name);
      setPendingAgentFollowUps(proposal.followUpIntents ? structuredClone(proposal.followUpIntents) : []);
      setPendingAgentFollowUpProposalId(proposal.proposalId);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message); props.onSaveStateChange?.("error");
      const current = await props.repository.open(props.documentId).catch(() => undefined);
      if (current) {
        openedRef.current = current; visibleWorkspaceRef.current = current.revision.workspace; setOpened(current); props.onRevisionChange?.(current);
      }
      throw reason;
    } finally {
      agentApplyLockRef.current = false; setBusy(false);
    }
  }, [flushPending, props.documentId, props.onNameChange, props.onRevisionChange, props.onSaveStateChange, props.repository, t]);

  const confirmAgentImageIntent=useCallback(async(intent:ArtboardImageGenerationIntent,proposalId:string,modelId:string,config:FalImageConfig,signal:AbortSignal)=>{
    await flushPending();const base=openedRef.current;if(!base)throw new Error(t('agent.workspaceClosed'));
    const model=falImageModel(modelId);if(!model)throw new Error("Der ausgewählte fal.ai-Adapter ist nicht verfügbar.");
    const context={workspace:structuredClone(base.revision.workspace),workspaceId:base.record.id,branchId:base.branch.id,revision:{id:base.revision.id,number:base.revision.revisionNumber},proposalId,intent:structuredClone(intent)};
    const result=await executeArtboardImageIntent(context,model,config,signal);
    const head=await props.repository.open(props.documentId);if(!head)throw new Error("Das bezahlte Asset wurde gesichert, aber der Artboard-Workspace ist geschlossen.");
    return persistPaidResultProposal(agentRuntimeRef.current!.proposalRepository,context,result,{workspace:head.revision.workspace,branchId:head.branch.id,revision:{id:head.revision.id,number:head.revision.revisionNumber}});
  },[flushPending,props.documentId,props.repository,t]);

  if (error && !opened) return <section className="home-artboard-surface" role="alert"><AlertTriangle size={22} /><div><strong>{t('artboard.openFailed',{name:props.name})}</strong><p>{localizeErrorMessage(error)}</p><button type="button" className="secondary" onClick={props.onBack}>{t('artboard.back')}</button></div></section>;
  if (!opened) return <section className="home-artboard-surface" role="status" aria-busy="true"><LoaderCircle className="spin" size={20} /><div><strong>{t('artboard.opening',{name:props.name})}</strong><p>{t('artboard.preparing')}</p></div></section>;

  const createBoard = (preset: ArtboardPreset, sourceBoardId?: string) => {
    const workspace = visibleWorkspaceRef.current ?? opened.revision.workspace;
    const board = blankBoard(workspace, preset, sourceBoardId);
    const placement = findBoardPlacement(workspace, board.document.format, sourceBoardId);
    persistOperations([{ type: "create-board", board, placement }], "create-board");
  };
  const createVariant = (boardId: string, snapshot?: ArtboardInputSnapshot) => {
    const workspace = visibleWorkspaceRef.current ?? opened.revision.workspace;
    const created = duplicatedBoard({ ...opened, revision: { ...opened.revision, workspace } }, boardId, snapshot);
    persistOperations([{ type: "create-board", ...created }], "variant");
  };
  const insertAsset = (asset: ArtboardAssetItem, destination?: {boardId?:string;layerId?:string;x?:number;y?:number}) => {
    if (!asset.casHash || !/^[a-f0-9]{64}$/.test(asset.casHash)) { setError(t('assets.empty')); return; }
    const workspace=visibleWorkspaceRef.current??opened.revision.workspace;
    const board=workspace.boards[destination?.boardId??workspace.activeBoardId]; if(!board)return;
    const target=destination?.layerId?board.document.layers[destination.layerId]:undefined;
    if(target?.type==="image") { persistOperations([{type:"update-layer",boardId:board.id,layerId:target.id,patch:{casHash:asset.casHash,assetVersionId:asset.versionId,bindingId:undefined,name:asset.name,version:target.version+1}}],"replace-image"); return; }
    const width=Math.min(560,board.document.format.width); const height=Math.min(560,board.document.format.height);
    const x=Math.max(0,Math.min(board.document.format.width-width,destination?.x??(board.document.format.width-width)/2));
    const y=Math.max(0,Math.min(board.document.format.height-height,destination?.y??(board.document.format.height-height)/2));
    const id=`image-${crypto.randomUUID()}`;
    persistOperations([{type:"create-layer",boardId:board.id,rootIndex:board.document.rootLayerIds.length,layer:{id,type:"image",name:asset.name,locked:false,visible:true,version:1,geometry:{x,y,width,height,rotation:0},casHash:asset.casHash,assetVersionId:asset.versionId,fit:"contain"}}],"insert-image");
  };

  const chooseExportFolder = async () => {
    try {
      setExportError(undefined);
      const folder = await pickArtboardExportFolder(props.documentId);
      if (folder) setExportFolder(folder);
      return folder;
    } catch (reason) { setExportError(reason instanceof Error ? reason.message : String(reason)); return undefined; }
  };

  const runExport = async () => {
    if (!exportBoardIds?.length || exportBusy) return;
    const folder = await resolveArtboardExportFolder(exportFolder, chooseExportFolder);
    if (!folder) return;
    setExportBusy(true); setExportProgress(2); setExportError(undefined); setExportResult(undefined);
    try {
      await flushPending();
      const current = openedRef.current;
      if (!current) throw new Error(t('artboard.exportClosed'));
      const boards = exportBoardIds.map((id) => current.revision.workspace.boards[id]);
      if (boards.some((board) => !board)) throw new Error(t('artboard.exportSelectionStale'));
      const rendered = [];
      for (let index = 0; index < boards.length; index += 1) {
        rendered.push(await renderBoardExport(boards[index]!, mediaUrl));
        setExportProgress(8 + ((index + 1) / boards.length) * 72);
      }
      setExportProgress(86);
      const result = await writeArtboardExport({
        documentId: props.documentId, workspaceId: current.record.id, revisionId: current.revision.id,
        grantId: folder.grantId, overwrite: exportOptions.overwrite, includeManifest: exportOptions.includeManifest,
        boards: rendered,
      });
      setExportProgress(100); setExportResult(result);
    } catch (reason) { setExportError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setExportBusy(false); }
  };

  return <>
    <ArtboardWorkspace
      workspace={opened.revision.workspace}
      revision={{ id: opened.revision.id, number: opened.revision.revisionNumber }}
      canUndo={Boolean(opened.revision.parentRevisionId)} canRedo={Boolean(opened.branch.redoRevisionId)} isBusy={busy}
      resolveAsset={mediaUrl}
      assets={assets} assetTotal={assetTotal} assetsLoading={assetsLoading}
      onLoadMoreAssets={() => void loadAssetPage(assetPage+1)} onInsertAsset={insertAsset}
      upstreamUpdates={Object.fromEntries(Object.values(opened.revision.workspace.boards).flatMap((board)=>{
        const current=board.inputSnapshot.source;
        if(!current)return[];
        const next=props.availableSnapshots?.find((snapshot)=>snapshot.source?.projectId===current.projectId&&snapshot.source.nodeId===current.nodeId&&snapshot.source.signature!==current.signature&&!board.inputSnapshot.ignoredSignatures?.includes(snapshot.source.signature));
        return next?[[board.id,next]]:[];
      }))}
      onBack={props.onBack}
      onApplyOperations={(batch) => persist(batch)}
      onSelectionChange={(activeBoardId, selectedBoardIds) => setOpened((current) => {
        if (!current) return current;
        const next = { ...current, revision: { ...current.revision, workspace: { ...current.revision.workspace, activeBoardId, selectedBoardIds } } };
        visibleWorkspaceRef.current = next.revision.workspace;
        if (openedRef.current) openedRef.current = { ...openedRef.current, revision: { ...openedRef.current.revision, workspace: { ...openedRef.current.revision.workspace, activeBoardId, selectedBoardIds } } };
        props.onRevisionChange?.(next);
        return next;
      })}
      onCreateBoard={createBoard}
      onDuplicateBoard={(boardId) => createVariant(boardId)}
      onCreateVariant={createVariant}
      onIgnoreUpstreamUpdate={(boardId,snapshot) => {const board=(visibleWorkspaceRef.current??opened.revision.workspace).boards[boardId];if(!board||!snapshot.source)return;const ignored=[...(board.inputSnapshot.ignoredSignatures??[]).filter((item)=>item!==snapshot.source!.signature),snapshot.source.signature].slice(-32);persistOperations([{type:"set-board-inputs",boardId,snapshot:{...board.inputSnapshot,ignoredSignatures:ignored}}],"ignore-inputs");setNotice(t('artboard.inputsPinned'));}}
      onUpdateBoardInputs={(boardId, snapshot) => {
        const board=(visibleWorkspaceRef.current??opened.revision.workspace).boards[boardId];
        if(!board)return;
        persistOperations([{ type: "set-board-inputs", boardId, snapshot:{...snapshot,ignoredSignatures:board.inputSnapshot.ignoredSignatures} }], "update-inputs");
      }}
      onUndo={() => void moveHistory("undo")} onRedo={() => void moveHistory("redo")}
      onExport={(boardIds) => { setExportBoardIds([...boardIds]); setExportProgress(0); setExportResult(undefined); setExportError(undefined); }}
      agent={{
        branchId: opened.branch.id,
        adapterFactory: agentRuntimeRef.current!.adapterFactory,
        toolExecutor: agentRuntimeRef.current!.toolExecutor,
        resolveProposal: agentRuntimeRef.current!.resolveProposal,
        prepareContext: prepareAgentContext,
        onApplyProposal: applyAgentProposal,
        onSelectionChange: (selection) => { agentSelectionRef.current = structuredClone(selection); },
        onOpenProviderSettings: props.onOpenProviderSettings,
        pendingFollowUps: pendingAgentFollowUps,
        pendingFollowUpProposalId:pendingAgentFollowUpProposalId,
        onConfirmFollowUp:confirmAgentImageIntent,
        onOpenFalSettings:props.onOpenProviderSettings,
        onDismissFollowUps: () => {setPendingAgentFollowUps([]);setPendingAgentFollowUpProposalId(undefined);},
      }}
    />
    {exportBoardIds ? <ArtboardExportPopover
      boardNames={exportBoardIds.map((id)=>opened.revision.workspace.boards[id]?.name).filter((name):name is string=>Boolean(name))}
      folder={exportFolder} busy={exportBusy} progress={exportProgress} result={exportResult} error={exportError} options={exportOptions}
      onOptions={setExportOptions} onChooseFolder={()=>void chooseExportFolder()} onExport={()=>void runExport()}
      onReveal={()=>{if(exportResult?.files[0]&&exportFolder)void revealArtboardExport(props.documentId,exportFolder.grantId,exportResult.files[0]).catch((reason)=>setExportError(reason instanceof Error?reason.message:String(reason)));}}
      onClose={()=>{if(!exportBusy)setExportBoardIds(undefined);}}
    /> : null}
    {(notice || error) && <div className="home-shell-notice" role={error ? "alert" : "status"}><span>{error ? localizeErrorMessage(error) : notice}</span><button type="button" onClick={() => { setNotice(""); setError(undefined); }} aria-label={t('artboard.noticeClose')}>×</button></div>}
  </>;
}
