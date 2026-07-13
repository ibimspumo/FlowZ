import { describe, expect, it, vi } from "vitest";
import { ARTBOARD_AGENT_TOOL_CONTRACT_VERSION } from "./tool-contract";
import { MemoryArtboardAgentRepository } from "./repository";
import { OpenRouterArtboardAgentAdapter, type OpenRouterAgentTransport } from "./openrouter-adapter";
import { CodexLocalArtboardAgentAdapter, type CodexAppServerTransport, type CodexServerEvent } from "./codex-adapter";
import type { AgentRunSnapshot, ArtboardAgentToolExecutor } from "./types";

const run = (provider: "openrouter" | "codex-local"): AgentRunSnapshot => ({ runId: "run-1", workspaceId: "workspace-1", branchId: "branch-main", conversationId: "chat-1", provider, toolContractVersion: ARTBOARD_AGENT_TOOL_CONTRACT_VERSION, providerSessionId: provider === "openrouter" ? "or-session" : "thread-1", modelId: "model-1", inputRevision: 3, selectedBoardRevisionIds: ["revision-1"], state: "idle", submittedAt: "2026-07-12T10:00:00Z" });
const executor: ArtboardAgentToolExecutor = { execute: vi.fn(async (invocation) => ({ content: { queued: true }, proposalId: "proposal-1", ...(invocation.tool === "render_preview" ? { imageDataUrl: "data:image/png;base64,iVBORw0KGgo=" } : {}) })) };

function mutableContextExecutor(state:{revision:number;x:number}):ArtboardAgentToolExecutor{
  return {execute:vi.fn(async(invocation)=>{
    const board={id:"board-1",name:"Post",revisionId:`board-revision-${state.revision}`,format:{preset:"instagram-post",width:1080,height:1080},placement:{x:100,y:100},layerCount:1};
    const layer={boardId:"board-1",id:"headline",type:"text",name:"Headline",visible:true,locked:false,version:state.revision,geometry:{x:state.x,y:80,width:800,height:160,rotation:0},text:"Launch",color:"#111111",fontFamily:"Inter",fontWeight:700,fontSize:80,align:"left"};
    if(invocation.tool==="get_workspace_info")return{content:{workspaceId:"workspace-1",name:"Launch",revision:{id:`revision-${state.revision}`,number:state.revision},boards:[board]}};
    if(invocation.tool==="get_selection")return{content:{activeBoardId:"board-1",boardIds:["board-1"],layerIds:[]}};
    if(invocation.tool==="get_board")return{content:{...board,background:{kind:"solid",color:"#FFFFFF"},rootLayerIds:["headline"],bindingIds:[]}};
    if(invocation.tool==="get_layer_tree")return{content:{boardId:"board-1",roots:[{id:"headline",type:"text",name:"Headline",visible:true,locked:false}]}};
    if(invocation.tool==="get_layers")return{content:{layers:[layer]}};
    if(invocation.tool==="get_bound_inputs")return{content:{bindings:[]}};
    if(invocation.tool==="render_preview")return{content:{preview:true},proposalId:"proposal-1",imageDataUrl:"data:image/png;base64,iVBORw0KGgo="};
    return{content:{queued:true},proposalId:"proposal-1"};
  })};
}

describe("OpenRouter Artboard adapter", () => {
  it("filters for text + tools, validates every call and persists usage/proposal", async () => {
    const repository = new MemoryArtboardAgentRepository();
    const transport: OpenRouterAgentTransport = {
      keyStatus: async () => true,
      listModels: async () => [
        { id: "vision", inputModalities: ["text", "image"], supportedParameters: ["tools"] },
        { id: "no-tools", inputModalities: ["text"], supportedParameters: [] },
        { id: "image-output", inputModalities: ["image"], supportedParameters: ["tools"] },
      ],
      run: async (_input, handlers) => { handlers.event({ type: "turn-started", id: "gen-1" }); handlers.event({ type: "text-delta", text: "Entwurf" }); await handlers.tool({ id: "call-1", name: "set_board_properties", arguments: { workspaceId: "workspace-1", branchId: "branch-main", proposalId: "proposal-1", operationId: "operation-1", expectedRevision: 3, boardId: "board-1", name: "Neue Version" } }); handlers.event({ type: "usage", inputTokens: 10, outputTokens: 4, costMicrounits: 77, generationId: "gen-1" }); handlers.event({ type: "usage", inputTokens: 3, outputTokens: 2, costMicrounits: 9, generationId: "gen-2" }); return { providerTurnId: "gen-1" }; },
      cancel: vi.fn(), close: vi.fn(),
    };
    const adapter = new OpenRouterArtboardAgentAdapter(transport, repository, executor);
    expect((await adapter.listModels()).map((model) => model.id)).toEqual(["vision"]);
    const events: string[] = []; await adapter.runTurn(run("openrouter"), "Mach es klarer", (event) => events.push(event.type));
    expect(events).toContain("proposal-updated"); expect(repository.runs.get("run-1")?.state).toBe("proposal-ready"); expect(repository.usage.get("run-1")).toMatchObject({ inputTokens: 13, outputTokens: 6, costMicrounits: 86, generationId: "gen-2" });
  });

  it("never automatically resubmits an ambiguous detached SSE run", async () => {
    const transport = { keyStatus: async () => true, listModels: async () => [], run: vi.fn(), cancel: vi.fn(), close: vi.fn() } as unknown as OpenRouterAgentTransport;
    const recovered = await new OpenRouterArtboardAgentAdapter(transport, new MemoryArtboardAgentRepository(), executor).recover({ ...run("openrouter"), state: "streaming" });
    expect(recovered.state).toBe("unknown"); expect(transport.run).not.toHaveBeenCalled();
  });

  it("emits a failed completion event for a rejected provider tool call", async () => {
    const transport: OpenRouterAgentTransport = {
      keyStatus: async () => true, listModels: async () => [], cancel: vi.fn(), close: vi.fn(),
      run: async (_input, handlers) => {
        await handlers.tool({ id: "bad-call", name: "not_allowed", arguments: { operationId: "bad-operation" } });
        return { providerTurnId: "never" };
      },
    };
    const events: unknown[] = [];
    await expect(new OpenRouterArtboardAgentAdapter(transport, new MemoryArtboardAgentRepository(), executor).runTurn(run("openrouter"), "x", (event) => events.push(event))).rejects.toThrow();
    expect(events).toContainEqual({ type: "tool-completed", tool: "not_allowed", operationId: "bad-operation", success: false });
  });

  it("sends a current structured snapshot on every turn and keeps sessions isolated", async () => {
    const repository = new MemoryArtboardAgentRepository(); const submitted: string[] = [];
    const transport: OpenRouterAgentTransport = {
      keyStatus: async () => true, listModels: async () => [], cancel: vi.fn(), close: vi.fn(),
      run: async (input, handlers) => { submitted.push(input.userText); handlers.event({ type: "turn-started", id: `turn-${submitted.length}` }); await handlers.tool({ id: `call-${submitted.length}`, name: "set_board_properties", arguments: { workspaceId: "workspace-1", branchId: "branch-main", proposalId: "proposal-1", operationId: `operation-${submitted.length}`, expectedRevision: 3, boardId: "board-1", name: "Version" } }); return { providerTurnId: `turn-${submitted.length}` }; },
    };
    const adapter = new OpenRouterArtboardAgentAdapter(transport, repository, executor);
    await adapter.runTurn(run("openrouter"), "Erster Wunsch", () => undefined);
    await adapter.runTurn({ ...run("openrouter"), runId: "run-2" }, "Zweiter Wunsch", () => undefined);
    await adapter.runTurn({ ...run("openrouter"), runId: "run-3", conversationId: "chat-2", providerSessionId: "or-session-2" }, "Neue Unterhaltung", () => undefined);
    expect(submitted[0]).toMatch(/UNTRUSTED_DOCUMENT_CONTEXT[\s\S]*Erster Wunsch/);
    expect(submitted[1]).toMatch(/UNTRUSTED_DOCUMENT_CONTEXT[\s\S]*Zweiter Wunsch/);
    expect(submitted[2]).toMatch(/UNTRUSTED_DOCUMENT_CONTEXT[\s\S]*Neue Unterhaltung/);
    expect(repository.sessions.size).toBe(2);
    expect([...repository.sessions.values()].find((session) => session.conversationId === "chat-1")).toMatchObject({ lastTurnId: "turn-2" });
    expect([...repository.sessions.values()].find((session) => session.conversationId === "chat-2")).toMatchObject({ lastTurnId: "turn-3" });
  });

  it("checkpoints only successful turns, then sends same-chat workspace deltas but none to a new chat",async()=>{
    const repository=new MemoryArtboardAgentRepository();const state={revision:1,x:80};const contextExecutor=mutableContextExecutor(state);const submitted:string[]=[];const firstCheckpointDuringSubmit:boolean[]=[];
    const transport:OpenRouterAgentTransport={keyStatus:async()=>true,listModels:async()=>[],cancel:vi.fn(),close:vi.fn(),run:async(input,handlers)=>{submitted.push(input.userText);if(submitted.length===1)firstCheckpointDuringSubmit.push(Boolean((await repository.findSession({...run("openrouter"),conversationId:"chat-1"}))?.manualContextCheckpoint));handlers.event({type:"turn-started",id:`turn-${submitted.length}`});await handlers.tool({id:`call-${submitted.length}`,name:"set_board_properties",arguments:{workspaceId:"workspace-1",branchId:"branch-main",proposalId:"proposal-1",operationId:`operation-${submitted.length}`,expectedRevision:state.revision,boardId:"board-1",name:"Version"}});return{providerTurnId:`turn-${submitted.length}`};}};
    const adapter=new OpenRouterArtboardAgentAdapter(transport,repository,contextExecutor);
    await adapter.openSession({workspaceId:"workspace-1",branchId:"branch-main",conversationId:"chat-1",provider:"openrouter",toolContractVersion:ARTBOARD_AGENT_TOOL_CONTRACT_VERSION,modelId:"model-1",previousProviderSessionId:"or-session"});
    await adapter.runTurn(run("openrouter"),"Erster Wunsch",()=>undefined);
    expect(firstCheckpointDuringSubmit).toEqual([false]);
    expect(submitted[0]).not.toContain("Workspace changes since the previous successful agent turn");
    expect((await repository.findSession(run("openrouter")))?.manualContextCheckpoint?.revision.number).toBe(1);
    state.revision=2;state.x=160;
    await adapter.runTurn({...run("openrouter"),runId:"run-2",inputRevision:2},"Verschiebe weiter",()=>undefined);
    expect(submitted[1]).toContain("Workspace changes since the previous successful agent turn");
    expect(submitted[1]).toContain('"field":"geometry"');
    await adapter.openSession({workspaceId:"workspace-1",branchId:"branch-main",conversationId:"chat-2",provider:"openrouter",toolContractVersion:ARTBOARD_AGENT_TOOL_CONTRACT_VERSION,modelId:"model-1",previousProviderSessionId:"or-session-2"});
    await adapter.runTurn({...run("openrouter"),runId:"run-3",conversationId:"chat-2",providerSessionId:"or-session-2",inputRevision:2},"Neue Unterhaltung",()=>undefined);
    expect(submitted[2]).not.toContain("Workspace changes since the previous successful agent turn");
  });
});

class MockCodexTransport implements CodexAppServerTransport {
  listeners = new Set<(event: CodexServerEvent) => void>(); calls: { method: string; params: Record<string, unknown> }[] = [];
  responses: unknown[] = [];turnSequence=0;
  async start() {} async scratchDirectory() { return "/private/tmp/flowz-artboard/workspace-1"; }
  async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    if (method === "account/read") return { account: { type: "chatgpt", email: "test@example.com" }, requiresOpenaiAuth: true } as T;
    if (method === "model/list") return { data: [] } as T;
    if (method === "thread/start" || method === "thread/resume") return { thread: { id: "thread-1" } } as T;
    if (method === "turn/start") return { turn: { id: `turn-${++this.turnSequence}` } } as T;
    return {} as T;
  }
  async respond(_id: string | number, result: unknown) { this.responses.push(result); } subscribe(listener: (event: CodexServerEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event: CodexServerEvent) { for (const listener of this.listeners) listener(event); }
  async close() {}
}

describe("Codex local Artboard adapter", () => {
  it("starts in a read-only, offline scratch cwd and exposes only exact dynamic tools", async () => {
    const transport = new MockCodexTransport(); const adapter = new CodexLocalArtboardAgentAdapter(transport, new MemoryArtboardAgentRepository(), executor);
    expect(await adapter.probe()).toMatchObject({ state: "ready", accountLabel: "test@example.com" });
    await adapter.openSession({ workspaceId: "workspace-1", branchId: "branch-main", conversationId: "chat-1", provider: "codex-local", toolContractVersion: ARTBOARD_AGENT_TOOL_CONTRACT_VERSION, modelId: "gpt-test" });
    const start = transport.calls.find((call) => call.method === "thread/start")!;
    expect(start.params).toMatchObject({ model: "gpt-test", cwd: "/private/tmp/flowz-artboard/workspace-1", approvalPolicy: "never", sandbox: "read-only" });
    expect(JSON.stringify(start.params)).toContain('"networkAccess":false'); expect(JSON.stringify(start.params)).not.toMatch(/shellCommand|command\/exec|https?:/);
    const turnPromise = adapter.runTurn(run("codex-local"), "x", () => undefined); await vi.waitFor(() => expect(transport.calls.some((call) => call.method === "turn/start")).toBe(true)); expect(transport.calls.find((call) => call.method === "turn/start")?.params).toMatchObject({ effort: null }); transport.emit({ method: "process/lost" }); await expect(turnPromise).rejects.toThrow("CODEX_PROCESS_LOST");
  });

  it("replaces only a confirmed stale local thread before any turn is submitted", async () => {
    const transport = new MockCodexTransport(); const repository = new MemoryArtboardAgentRepository(); await repository.saveSession({ workspaceId: "workspace-1", branchId: "branch-main", conversationId: "chat-1", provider: "codex-local", toolContractVersion: ARTBOARD_AGENT_TOOL_CONTRACT_VERSION, providerSessionId: "stale-thread", modelId: "gpt-old" });
    const original = transport.request.bind(transport); transport.request = vi.fn(async (method: string, params: Record<string, unknown>) => { if (method === "thread/resume") throw new Error("no rollout found for thread id stale-thread"); return original(method, params); }) as CodexAppServerTransport["request"];
    const session = await new CodexLocalArtboardAgentAdapter(transport, repository, executor).openSession({ workspaceId: "workspace-1", branchId: "branch-main", conversationId: "chat-1", provider: "codex-local", toolContractVersion: ARTBOARD_AGENT_TOOL_CONTRACT_VERSION, modelId: "gpt-new" });
    expect(session).toMatchObject({ providerSessionId: "thread-1", modelId: "gpt-new" }); expect(transport.calls.some((call) => call.method === "turn/start")).toBe(false);
  });

  it("executes validated dynamic calls into a proposal and completes without applying it", async () => {
    const transport = new MockCodexTransport(); const repository = new MemoryArtboardAgentRepository(); const adapter = new CodexLocalArtboardAgentAdapter(transport, repository, executor);
    const promise = adapter.runTurn(run("codex-local"), "Baue eine Headline", () => undefined);
    await vi.waitFor(() => expect(transport.calls.some((call) => call.method === "turn/start")).toBe(true));
    expect(transport.calls.find((call) => call.method === "turn/start")?.params.input).toEqual([{ type: "text", text: expect.stringMatching(/workspaceId=workspace-1; branchId=branch-main; expectedRevision=3[\s\S]*UNTRUSTED_DOCUMENT_CONTEXT[\s\S]*Baue eine Headline/) }]);
    transport.emit({ method: "item/tool/call", id: 7, params: { callId: "call-write", threadId: "thread-1", turnId: "turn-1", tool: "set_board_properties", arguments: { workspaceId: "workspace-1", branchId: "branch-main", proposalId: "proposal-1", operationId: "operation-write", expectedRevision: 3, boardId: "board-1", name: "Neue Version" } } });
    await vi.waitFor(() => expect(transport.responses).toHaveLength(1));
    transport.emit({ method: "item/tool/call", id: 8, params: { callId: "call-preview", threadId: "thread-1", turnId: "turn-1", tool: "render_preview", arguments: { workspaceId: "workspace-1", branchId: "branch-main", proposalId: "proposal-1", boardId: "board-1", width: 512, height: 512 } } });
    await vi.waitFor(() => expect(transport.responses).toHaveLength(2));
    expect(transport.responses[1]).toMatchObject({ contentItems: [{ type: "inputText" }, { type: "inputImage", imageUrl: expect.stringMatching(/^data:image\/png;base64,/) }], success: true });
    transport.emit({ method: "item/tool/call", id: 9, params: { callId: "call-finish", threadId: "thread-1", turnId: "turn-1", tool: "finish_working", arguments: { workspaceId: "workspace-1", branchId: "branch-main", proposalId: "proposal-1", operationId: "operation-finish", expectedRevision: 3 } } });
    await vi.waitFor(() => expect(transport.responses).toHaveLength(3));
    expect(repository.runs.get("run-1")).toMatchObject({ state: "tool-executing", providerTurnId: "turn-1", proposalId: "proposal-1" });
    transport.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
    await expect(promise).resolves.toEqual({ providerTurnId: "turn-1" }); expect(repository.runs.get("run-1")?.proposalId).toBe("proposal-1");
  });

  it("sends the shared same-chat delta on turn two and does not advance its checkpoint after interruption",async()=>{
    const transport=new MockCodexTransport();const repository=new MemoryArtboardAgentRepository();const state={revision:1,x:80};const adapter=new CodexLocalArtboardAgentAdapter(transport,repository,mutableContextExecutor(state));
    await adapter.openSession({workspaceId:"workspace-1",branchId:"branch-main",conversationId:"chat-1",provider:"codex-local",toolContractVersion:ARTBOARD_AGENT_TOOL_CONTRACT_VERSION,modelId:"model-1"});
    const first=adapter.runTurn({...run("codex-local"),inputRevision:1},"Erster Wunsch",()=>undefined);await vi.waitFor(()=>expect(transport.calls.filter((call)=>call.method==="turn/start")).toHaveLength(1));
    transport.emit({method:"item/tool/call",id:21,params:{callId:"write-1",threadId:"thread-1",turnId:"turn-1",tool:"set_board_properties",arguments:{workspaceId:"workspace-1",branchId:"branch-main",proposalId:"proposal-1",operationId:"write-1",expectedRevision:1,boardId:"board-1",name:"Version"}}});await vi.waitFor(()=>expect(transport.responses).toHaveLength(1));
    transport.emit({method:"item/tool/call",id:22,params:{callId:"preview-1",threadId:"thread-1",turnId:"turn-1",tool:"render_preview",arguments:{workspaceId:"workspace-1",branchId:"branch-main",proposalId:"proposal-1",boardId:"board-1",width:512,height:512}}});await vi.waitFor(()=>expect(transport.responses).toHaveLength(2));
    transport.emit({method:"item/tool/call",id:23,params:{callId:"finish-1",threadId:"thread-1",turnId:"turn-1",tool:"finish_working",arguments:{workspaceId:"workspace-1",branchId:"branch-main",proposalId:"proposal-1",operationId:"finish-1",expectedRevision:1}}});await vi.waitFor(()=>expect(transport.responses).toHaveLength(3));
    transport.emit({method:"turn/completed",params:{threadId:"thread-1",turn:{id:"turn-1",status:"completed"}}});await first;
    expect((await repository.findSession(run("codex-local")))?.manualContextCheckpoint?.revision.number).toBe(1);
    state.revision=2;state.x=180;
    const second=adapter.runTurn({...run("codex-local"),runId:"run-2",inputRevision:2},"Noch weiter",()=>undefined);await vi.waitFor(()=>expect(transport.calls.filter((call)=>call.method==="turn/start")).toHaveLength(2));
    const input=transport.calls.filter((call)=>call.method==="turn/start")[1].params.input;
    expect(JSON.stringify(input)).toContain("Workspace changes since the previous successful agent turn");expect(JSON.stringify(input)).toContain('\\"field\\":\\"geometry\\"');
    transport.emit({method:"turn/completed",params:{threadId:"thread-1",turn:{id:"turn-2",status:"interrupted"}}});await expect(second).rejects.toThrow("CODEX_INTERRUPTED");
    expect((await repository.findSession(run("codex-local")))?.manualContextCheckpoint?.revision.number).toBe(1);
  });

  it("recovers a completed turn from the proposal id persisted before the final event", async () => {
    const transport = new MockCodexTransport();
    const original = transport.request.bind(transport);
    transport.request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/read") return { thread: { turns: [{ id: "turn-1", status: "completed" }] } } as never;
      return original(method, params);
    }) as CodexAppServerTransport["request"];
    const persisted = { ...run("codex-local"), providerTurnId: "turn-1", proposalId: "proposal-frozen", state: "tool-executing" as const };
    const recovered = await new CodexLocalArtboardAgentAdapter(transport, new MemoryArtboardAgentRepository(), executor).recover(persisted);
    expect(recovered).toMatchObject({ state: "proposal-ready", proposalId: "proposal-frozen", providerTurnId: "turn-1" });
  });

  it("marks a killed local process without resubmitting a turn", async () => {
    const transport = new MockCodexTransport(); const adapter = new CodexLocalArtboardAgentAdapter(transport, new MemoryArtboardAgentRepository(), executor); const promise = adapter.runTurn(run("codex-local"), "x", () => undefined);
    await vi.waitFor(() => expect(transport.calls.some((call) => call.method === "turn/start")).toBe(true)); transport.emit({ method: "process/lost" }); await expect(promise).rejects.toThrow("CODEX_PROCESS_LOST");
    expect(transport.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
  });

  it("rejects finishing a proposal that has not been visually previewed", async () => {
    const transport = new MockCodexTransport(); const events: unknown[] = []; const adapter = new CodexLocalArtboardAgentAdapter(transport, new MemoryArtboardAgentRepository(), executor); const promise = adapter.runTurn(run("codex-local"), "x", (event) => events.push(event));
    await vi.waitFor(() => expect(transport.calls.some((call) => call.method === "turn/start")).toBe(true));
    transport.emit({ method: "item/tool/call", id: 10, params: { callId: "finish-too-early", threadId: "thread-1", turnId: "turn-1", tool: "finish_working", arguments: { workspaceId: "workspace-1", branchId: "branch-main", proposalId: "proposal-1", operationId: "finish-too-early", expectedRevision: 3 } } });
    await vi.waitFor(() => expect(transport.responses).toHaveLength(1));
    expect(transport.responses[0]).toMatchObject({ success: false, contentItems: [{ text: expect.stringMatching(/render_preview/) }] });
    expect(events).toContainEqual({ type: "tool-completed", tool: "finish_working", operationId: "finish-too-early", success: false });
    transport.emit({ method: "process/lost" }); await expect(promise).rejects.toThrow("CODEX_PROCESS_LOST");
  });

  it("ignores events from another thread instead of cross-wiring runs", async () => {
    const transport = new MockCodexTransport(); const repository = new MemoryArtboardAgentRepository(); const localExecutor: ArtboardAgentToolExecutor = { execute: vi.fn(async () => ({ content: {}, proposalId: "proposal-1" })) };
    const adapter = new CodexLocalArtboardAgentAdapter(transport, repository, localExecutor); const promise = adapter.runTurn(run("codex-local"), "x", () => undefined);
    await vi.waitFor(() => expect(transport.calls.some((call) => call.method === "turn/start")).toBe(true));
    vi.mocked(localExecutor.execute).mockClear();
    transport.emit({ method: "item/tool/call", id: 4, params: { callId: "foreign", threadId: "thread-foreign", turnId: "turn-1", tool: "finish_working", arguments: {} } });
    expect(localExecutor.execute).not.toHaveBeenCalled();
    transport.emit({ method: "process/lost" }); await expect(promise).rejects.toThrow("CODEX_PROCESS_LOST");
  });
});
