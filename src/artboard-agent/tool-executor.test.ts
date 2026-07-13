import { describe, expect, it } from "vitest";
import { ARTBOARD_DOCUMENT_VERSION, ARTBOARD_WORKSPACE_VERSION, type ArtboardWorkspace } from "../nodes/brand/artboard-domain";
import { MemoryArtboardProposalRepository } from "./proposal-repository";
import { createProposalResolver, PersistentArtboardAgentToolExecutor, type ArtboardAgentContextProvider } from "./tool-executor";
import type { ArtboardAgentToolName, ToolInvocation } from "./tool-contract";

const imageHash = "a".repeat(64);
const workspace = (): ArtboardWorkspace => ({
  schemaVersion: ARTBOARD_WORKSPACE_VERSION, id: "workspace-1", name: "Launch", activeBoardId: "board-1", selectedBoardIds: ["board-1"], placements: { "board-1": { x: 64, y: 64 } }, pasteboard: { margin: 64, gap: 64, grid: 8 },
  boards: { "board-1": { id: "board-1", name: "Post", activeRevisionId: "board-revision-1", createdAt: "2026-07-12T12:00:00.000Z", ancestry: { branchId: "branch-main" }, inputSnapshot: { id: "snapshot-1", createdAt: "2026-07-12T12:00:00.000Z", bindings: { "image-input": { id: "image-input", source: { projectId: "flow-1", nodeId: "image-node", portId: "image", resultId: "result-1" }, snapshot: { kind: "cas", hash: imageHash }, mode: "pinned" } } }, document: { schemaVersion: ARTBOARD_DOCUMENT_VERSION, id: "document-1", name: "Post", format: { preset: "instagram-post", width: 1080, height: 1080 }, paint: { kind: "solid", color: "#FFFFFF" }, layers: {
    headline: { id: "headline", type: "text", name: "Headline", locked: false, visible: true, version: 1, geometry: { x: 80, y: 80, width: 800, height: 180, rotation: 0 }, text: "FlowZ", color: "#111111",fontRef:"font-local",fontFamily:"Inter",fontHash:"b".repeat(64),fontWeight:600,fontStyle:"normal",fontAxes:{wght:600}, fontSize: 90, align: "left" },
    accent: { id: "accent", type: "shape", name: "Accent", locked: false, visible: true, version: 1, geometry: { x: 80, y: 300, width: 300, height: 40, rotation: 0 }, shape: "rectangle", fill: { kind: "solid", color: "#EE3399" } },
  }, rootLayerIds: ["headline", "accent"], bindings: { "image-input": { id: "image-input", source: { projectId: "flow-1", nodeId: "image-node", portId: "image", resultId: "result-1" }, snapshot: { kind: "cas", hash: imageHash }, mode: "pinned" } }, tokenRefs: {} } } },
});

class Context implements ArtboardAgentContextProvider {
  revision = { id: "revision-4", number: 4 };
  async getContext(request: { workspaceId: string; branchId: string; expectedRevisionId?: string; expectedRevisionNumber?: number }) {
    if (request.expectedRevisionId && request.expectedRevisionId !== this.revision.id || request.expectedRevisionNumber !== undefined && request.expectedRevisionNumber !== this.revision.number) throw new Error("stale revision");
    return { workspace: workspace(), branchId: "branch-main", revision: { ...this.revision }, selection: { activeBoardId: "board-1", boardIds: ["board-1"], layerIds: ["headline"] } };
  }
}

const read = (tool: ArtboardAgentToolName, extra: Record<string, unknown> = {}): ToolInvocation => ({ tool, arguments: { workspaceId: "workspace-1", branchId: "branch-main", ...extra } });
const write = (tool: ArtboardAgentToolName, proposalId: string, operationId: string, extra: Record<string, unknown> = {}): ToolInvocation => ({ tool, arguments: { workspaceId: "workspace-1", branchId: "branch-main", proposalId, operationId, expectedRevision: 4, ...extra } });
const review = (executor: PersistentArtboardAgentToolExecutor, proposalId: string, boardId = "board-1") => executor.execute(read("render_preview", { proposalId, boardId, width: 270, height: 270 }));
const textLayer = (id: string, text = "Neue Headline") => ({ id, type: "text", name: "Titel", locked: false, visible: true, geometry: { x: 20, y: 20, width: 500, height: 120, rotation: 0 }, text, color: "#112233", fontSize: 64, align: "left" });

describe("productive Artboard Agent tool executor", () => {
  it("returns only bounded structured read state and previews", async () => {
    const executor = new PersistentArtboardAgentToolExecutor(new Context(), new MemoryArtboardProposalRepository());
    await expect(executor.execute(read("get_workspace_info"))).resolves.toMatchObject({ content: { workspaceId: "workspace-1", revision: { number: 4 } } });
    await expect(executor.execute(read("get_selection"))).resolves.toMatchObject({ content: { layerIds: ["headline"] } });
    await expect(executor.execute(read("get_board", { boardId: "board-1" }))).resolves.toMatchObject({ content: { layerCount: 2 } });
    await expect(executor.execute(read("get_layer_tree", { boardId: "board-1" }))).resolves.toMatchObject({ content: { roots: [{ id: "headline" }, { id: "accent" }] } });
    await expect(executor.execute(read("get_layers", { layerIds: ["headline"] }))).resolves.toMatchObject({ content: { layers: [{ id: "headline", text: "FlowZ" }] } });
    await expect(executor.execute(read("get_bound_inputs", { bindingIds: ["image-input"] }))).resolves.toMatchObject({ content: { bindings: [{ id: "image-input", snapshot: { kind: "cas" } }] } });
    const preview = await executor.execute(read("render_preview", { boardId: "board-1", width: 270, height: 270 }));
    expect(preview.content).toMatchObject({ kind: "structured-artboard-preview", width: 270 });
    expect((preview.content as { items: unknown[] }).items).toEqual(expect.arrayContaining([expect.objectContaining({ id: "headline", x: 20 })]));
    expect(JSON.stringify(preview.content)).not.toMatch(/(?:https?:|<svg|data:image)/);
  });

  it("validates and freezes all concrete layer, board, binding and paid-intent operations", async () => {
    const repository = new MemoryArtboardProposalRepository(); const executor = new PersistentArtboardAgentToolExecutor(new Context(), repository);
    await executor.execute(write("create_layers", "proposal-all", "op-create", { boardId: "board-1", layers: [textLayer("subhead")] }));
    await executor.execute(write("update_layers", "proposal-all", "op-update", { boardId: "board-1", layers: [textLayer("headline", "Präzise Marke")] }));
    await executor.execute(write("duplicate_layers", "proposal-all", "op-duplicate", { boardId: "board-1", layerIds: ["accent"] }));
    await executor.execute(write("reorder_layers", "proposal-all", "op-reorder", { boardId: "board-1", layerIds: ["accent", "headline"] }));
    await executor.execute(write("set_board_properties", "proposal-all", "op-board", { boardId: "board-1", name: "Kampagne", backgroundColor: "#FAFAFA", width: 1080, height: 1080 }));
    await executor.execute(write("create_layers", "proposal-all", "op-image", { boardId: "board-1", layers: [{ id: "hero", type: "image", name: "Hero", locked: false, visible: true, geometry: { x: 0, y: 500, width: 1080, height: 500, rotation: 0 }, casHash: imageHash, fit: "cover" }] }));
    await executor.execute(write("bind_layer_resource", "proposal-all", "op-bind", { boardId: "board-1", layerId: "hero", bindingId: "image-input" }));
    const paid = await executor.execute(write("propose_image_generation", "proposal-all", "op-paid", { boardId: "board-1", prompt: "Abstrakte Markenwelt", role: "Hero", aspectRatio: "1:1", referenceBindingIds: ["image-input"] }));
    expect(paid.content).toMatchObject({ provider: "fal.ai", generated: false, status: "awaiting-explicit-paid-confirmation" });
    await executor.execute(write("delete_layers", "proposal-all", "op-delete", { boardId: "board-1", layerIds: ["subhead"] }));
    await review(executor, "proposal-all"); const finished = await executor.execute(write("finish_working", "proposal-all", "op-finish"));
    expect(finished.content).toMatchObject({ frozen: true, paidFollowUpCount: 1 });
    const resolved = await createProposalResolver(repository)("proposal-all");
    expect(resolved.batch.operations).toEqual(expect.arrayContaining([expect.objectContaining({type:"update-layer",patch:expect.objectContaining({fontFamily:"Inter",fontHash:"b".repeat(64),fontWeight:600})})]));
    expect(resolved.batch).toMatchObject({ expectedRevisionId: "revision-4", expectedRevisionNumber: 4 });
    expect(resolved.followUpIntents).toEqual([expect.objectContaining({ provider: "fal.ai", requiresExplicitConfirmation: true })]);
    expect(resolved.changes.length).toBeGreaterThan(2);
  });

  it("renders the current proposal draft instead of the unchanged workspace", async () => {
    const repository = new MemoryArtboardProposalRepository(); const executor = new PersistentArtboardAgentToolExecutor(new Context(), repository);
    await executor.execute(write("create_layers", "proposal-preview", "op-create-preview", { boardId: "board-1", layers: [textLayer("draft-headline", "Nur im Entwurf")] }));
    const preview = await executor.execute(read("render_preview", { boardId: "board-1", proposalId: "proposal-preview", width: 270, height: 270 }));
    expect(preview.content).toMatchObject({ proposalId: "proposal-preview", items: expect.arrayContaining([expect.objectContaining({ id: "draft-headline" })]) });
    expect((await repository.findProposal("proposal-preview"))?.receipts).toEqual(expect.arrayContaining([expect.objectContaining({ result: expect.objectContaining({ kind: "visual-review", boardId: "board-1", operationCount: 1 }) })]));
  });

  it("refuses to freeze a proposal without persisted current visual evidence", async () => {
    const repository = new MemoryArtboardProposalRepository(); const executor = new PersistentArtboardAgentToolExecutor(new Context(), repository);
    await executor.execute(write("set_board_properties", "proposal-unreviewed", "op-change", { boardId: "board-1", name: "Nicht geprüft" }));
    await expect(executor.execute(write("finish_working", "proposal-unreviewed", "op-finish"))).rejects.toThrow(/render_preview|visuell geprüft/);
    expect((await repository.findProposal("proposal-unreviewed"))?.state).toBe("draft");
  });

  it("preserves immutable font and asset provenance when an update omits unchanged optional metadata",async()=>{
    const repository=new MemoryArtboardProposalRepository();const executor=new PersistentArtboardAgentToolExecutor(new Context(),repository);
    await executor.execute(write("create_layers","proposal-provenance","op-image",{boardId:"board-1",layers:[{id:"asset-image",type:"image",name:"Asset",locked:false,visible:true,geometry:{x:0,y:400,width:300,height:300,rotation:0},casHash:imageHash,assetVersionId:"asset-version-1",fit:"cover"}]}));
    await executor.execute(write("update_layers","proposal-provenance","op-image-update",{boardId:"board-1",layers:[{id:"asset-image",type:"image",name:"Asset angepasst",locked:false,visible:true,geometry:{x:20,y:420,width:300,height:300,rotation:0},casHash:imageHash,fit:"contain"}]}));
    const draft=await repository.findProposal("proposal-provenance");expect(draft?.operations).toEqual(expect.arrayContaining([expect.objectContaining({type:"update-layer",patch:expect.objectContaining({assetVersionId:"asset-version-1"})})]));
  });

  it("switches an imported font to a system family without retaining or inventing a CAS hash", async () => {
    const repository = new MemoryArtboardProposalRepository();
    const executor = new PersistentArtboardAgentToolExecutor(new Context(), repository);
    await executor.execute(write("update_layers", "proposal-system-font", "op-font", {
      boardId: "board-1",
      layers: [{ ...textLayer("headline", "FlowZ"), fontFamily: "Georgia", fontWeight: 600, fontStyle: "normal" }],
    }));
    const draft = await repository.findProposal("proposal-system-font");
    const operation = draft?.operations.find((item) => item.type === "update-layer");
    expect(operation).toMatchObject({ type: "update-layer", patch: { fontFamily: "Georgia", fontWeight: 600 } });
    if (operation?.type !== "update-layer") throw new Error("Font update operation missing");
    expect(operation.patch).not.toHaveProperty("fontHash");
    expect(operation.patch).not.toHaveProperty("fontRef");
    expect(operation.patch).not.toHaveProperty("fontAxes");

    await expect(executor.execute(write("create_layers", "proposal-fake-font", "op-fake-font", {
      boardId: "board-1",
      layers: [{ ...textLayer("fake-font"), fontFamily: "Georgia", fontHash: "0".repeat(64) }],
    }))).rejects.toThrow(/keinen bereits geladenen Workspace-Font|fontHash/);
  });

  it("supports nested group creation and deterministic deep duplication", async () => {
    const repository = new MemoryArtboardProposalRepository(); const executor = new PersistentArtboardAgentToolExecutor(new Context(), repository);
    const group = { id: "group-1", type: "group", name: "Gruppe", locked: false, visible: true, geometry: { x: 0, y: 0, width: 600, height: 300, rotation: 0 }, childIds: ["child-1"] };
    await executor.execute(write("create_layers", "proposal-group", "op-group", { boardId: "board-1", layers: [group, textLayer("child-1")] }));
    const result = await executor.execute(write("duplicate_layers", "proposal-group", "op-group-copy", { boardId: "board-1", layerIds: ["group-1"] }));
    expect(result.content).toMatchObject({ duplicatedLayerIds: [expect.stringMatching(/^group-1-copy-/)] });
    await review(executor, "proposal-group"); await expect(executor.execute(write("finish_working", "proposal-group", "op-done"))).resolves.toBeTruthy();
  });

  it("renders canonical Flex/Gradient evidence from the current proposal after a layout write", async () => {
    const repository = new MemoryArtboardProposalRepository(); const executor = new PersistentArtboardAgentToolExecutor(new Context(), repository);
    const container={id:"layout-1",type:"container",name:"Hero layout",locked:false,visible:true,geometry:{x:100,y:400,width:880,height:300,rotation:0},childIds:["layout-a","layout-b"],layout:{mode:"flex",direction:"row",gap:20,padding:30,justify:"space-between",align:"stretch"},fill:{kind:"linear-gradient",angle:120,stops:[{color:"#EE3399",offset:0},{color:"#5533EE",offset:1}]},style:{borderRadius:20}};
    await executor.execute(write("create_layers","proposal-layout","op-layout",{boardId:"board-1",layers:[container,textLayer("layout-a","A"),textLayer("layout-b","B")]}));
    await executor.execute(write("reorder_layers","proposal-layout","op-layout-z",{boardId:"board-1",layerIds:["layout-b","layout-a"]}));
    const preview=await executor.execute(read("render_preview",{boardId:"board-1",proposalId:"proposal-layout",width:270,height:270}));
    expect(preview.content).toMatchObject({renderer:"canonical-v2",proposalId:"proposal-layout",items:expect.arrayContaining([expect.objectContaining({id:"layout-1",layout:expect.objectContaining({mode:"flex"}),paint:expect.objectContaining({kind:"linear-gradient"})}),expect.objectContaining({id:"layout-a"}),expect.objectContaining({id:"layout-b"})])});
    const items=(preview.content as {items:Array<{id:string;x:number;zIndex:number}>}).items;expect(items.find((item)=>item.id==="layout-b")!.x).toBeLessThan(items.find((item)=>item.id==="layout-a")!.x);expect(items.find((item)=>item.id==="layout-b")!.zIndex).toBeLessThan(items.find((item)=>item.id==="layout-a")!.zIndex);
  });

  it("proposes a collision-free cross-format board variant without mutating the workspace head",async()=>{
    const repository=new MemoryArtboardProposalRepository();const context=new Context();const executor=new PersistentArtboardAgentToolExecutor(context,repository);
    const created=await executor.execute(write("duplicate_board_as_variant","proposal-story","op-story",{sourceBoardId:"board-1",name:"Story-Variante",width:1080,height:1920}));
    expect(created.content).toMatchObject({sourceBoardId:"board-1",format:{preset:"instagram-story",width:1080,height:1920},placement:expect.objectContaining({x:expect.any(Number),y:expect.any(Number)})});
    const boardId=(created.content as {boardId:string}).boardId;expect(workspace().boards[boardId]).toBeUndefined();
    const preview=await executor.execute(read("render_preview",{boardId,proposalId:"proposal-story",width:270,height:480}));expect(preview.content).toMatchObject({boardId,width:270,height:480,items:expect.arrayContaining([expect.objectContaining({id:"headline"})])});
    await review(executor,"proposal-story",boardId);await executor.execute(write("finish_working","proposal-story","op-story-finish"));const resolved=await createProposalResolver(repository)("proposal-story");expect(resolved.changes).toEqual(expect.arrayContaining([expect.objectContaining({id:`board:${boardId}`,kind:"add"})]));expect(resolved.batch.operations).toEqual([expect.objectContaining({type:"create-board",board:expect.objectContaining({name:"Story-Variante"})})]);
  });

  it("proposes an explicit whole-board removal without mutating the workspace head", async () => {
    const twoBoards = workspace();
    twoBoards.boards["board-2"] = { ...structuredClone(twoBoards.boards["board-1"]), id: "board-2", name: "Entfernen", activeRevisionId: "board-revision-2", document: { ...structuredClone(twoBoards.boards["board-1"].document), id: "document-2", name: "Entfernen" } };
    twoBoards.placements["board-2"] = { x: 1200, y: 64 };
    const context: ArtboardAgentContextProvider = { getContext: async () => ({ workspace: structuredClone(twoBoards), branchId: "branch-main", revision: { id: "revision-4", number: 4 }, selection: { activeBoardId: "board-2", boardIds: ["board-2"], layerIds: [] } }) };
    const repository = new MemoryArtboardProposalRepository();
    const executor = new PersistentArtboardAgentToolExecutor(context, repository);
    const result = await executor.execute(write("delete_board", "proposal-remove", "op-remove", { boardId: "board-2" }));
    expect(result.content).toMatchObject({ boardId: "board-2", boardName: "Entfernen", status: "awaiting-explicit-apply" });
    expect(twoBoards.boards["board-2"]).toBeDefined();
    const preview = await executor.execute(read("render_preview", { boardId: "board-2", proposalId: "proposal-remove", width: 270, height: 270 }));
    expect(preview.content).toMatchObject({ boardId: "board-2", removalPreview: true });
    await executor.execute(write("finish_working", "proposal-remove", "op-remove-finish"));
    const resolved = await createProposalResolver(repository)("proposal-remove");
    expect(resolved.batch.operations).toEqual([{ type: "delete-board", boardId: "board-2" }]);
    expect(resolved.changes).toContainEqual(expect.objectContaining({ kind: "remove", boardName: "Entfernen" }));

    const lastExecutor = new PersistentArtboardAgentToolExecutor(new Context(), new MemoryArtboardProposalRepository());
    await expect(lastExecutor.execute(write("delete_board", "proposal-last", "op-last", { boardId: "board-1" }))).rejects.toThrow(/letzte Artboard/);
  });

  it("replays duplicate operation IDs only for the identical payload and isolates proposals", async () => {
    const repository = new MemoryArtboardProposalRepository(); const executor = new PersistentArtboardAgentToolExecutor(new Context(), repository);
    const invocation = write("set_board_properties", "proposal-a", "same-operation", { boardId: "board-1", name: "A" });
    const first = await executor.execute(invocation); expect(await executor.execute(invocation)).toEqual(first);
    await expect(executor.execute(write("set_board_properties", "proposal-a", "same-operation", { boardId: "board-1", name: "B" }))).rejects.toThrow(/ander.*Payload/);
    await executor.execute(write("set_board_properties", "proposal-b", "same-operation", { boardId: "board-1", name: "B" }));
    expect((await repository.findProposal("proposal-a"))?.operations).not.toEqual((await repository.findProposal("proposal-b"))?.operations);
  });

  it("fails closed for stale revisions and invalid geometry", async () => {
    const context = new Context(); const repository = new MemoryArtboardProposalRepository(); const executor = new PersistentArtboardAgentToolExecutor(context, repository);
    await executor.execute(write("set_board_properties", "proposal-stale", "op-1", { boardId: "board-1", name: "A" })); context.revision = { id: "revision-5", number: 5 };
    await expect(executor.execute(write("set_board_properties", "proposal-stale", "op-2", { boardId: "board-1", name: "B" }))).rejects.toThrow(/stale revision/);
    await expect(executor.execute(write("create_layers", "proposal-invalid", "op-invalid", { boardId: "board-1", layers: [{ ...textLayer("bad"), geometry: { x: 1000, y: 0, width: 500, height: 100, rotation: 0 } }] }))).rejects.toThrow(/außerhalb|Revision|stale/);
  });

  it("recovers frozen proposals after an executor restart and explains incomplete recovery", async () => {
    const repository = new MemoryArtboardProposalRepository(); const context = new Context();
    const first = new PersistentArtboardAgentToolExecutor(context, repository); await first.execute(write("set_board_properties", "proposal-restart", "op-1", { boardId: "board-1", name: "Restart" }));
    await expect(createProposalResolver(repository)("proposal-restart")).rejects.toThrow(/unvollständig/);
    const restarted = new PersistentArtboardAgentToolExecutor(context, repository); await review(restarted, "proposal-restart"); await restarted.execute(write("finish_working", "proposal-restart", "op-finish"));
    await expect(createProposalResolver(repository)("proposal-restart")).resolves.toMatchObject({ proposalId: "proposal-restart", batch: { expectedRevisionNumber: 4 } });
  });

  it("keeps frozen proposals immutable and rejects tampered persisted batches", async () => {
    const repository = new MemoryArtboardProposalRepository(); const context = new Context();
    const executor = new PersistentArtboardAgentToolExecutor(context, repository);
    await executor.execute(write("set_board_properties", "proposal-immutable", "op-1", { boardId: "board-1", name: "Sicher" }));
    await review(executor, "proposal-immutable"); await executor.execute(write("finish_working", "proposal-immutable", "op-finish"));
    const frozen = (await repository.findProposal("proposal-immutable"))!;
    await expect(repository.saveProposal({ ...frozen, updatedAt: new Date(Date.parse(frozen.updatedAt) + 1_000).toISOString() })).rejects.toThrow(/unveränderlich/);
    await expect(repository.deleteProposal("proposal-immutable")).rejects.toThrow(/unveränderlich/);
    const tampered = structuredClone(frozen);
    tampered.resolved!.batch.operations = [];
    await expect(repository.saveProposal(tampered)).rejects.toThrow(/stimmt nicht|unveränderlich/);
  });
});
