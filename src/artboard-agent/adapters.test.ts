import { describe, expect, it, vi } from "vitest";
import { ARTBOARD_AGENT_TOOL_CONTRACT_VERSION } from "./tool-contract";
import { MemoryArtboardAgentRepository } from "./repository";
import { OpenRouterArtboardAgentAdapter, type OpenRouterAgentTransport } from "./openrouter-adapter";
import { CodexLocalArtboardAgentAdapter, type CodexAppServerTransport, type CodexServerEvent } from "./codex-adapter";
import type { AgentRunSnapshot, ArtboardAgentToolExecutor } from "./types";

const run = (provider: "openrouter" | "codex-local"): AgentRunSnapshot => ({ runId: "run-1", workspaceId: "workspace-1", branchId: "branch-main", provider, toolContractVersion: ARTBOARD_AGENT_TOOL_CONTRACT_VERSION, providerSessionId: provider === "openrouter" ? "or-session" : "thread-1", modelId: "model-1", inputRevision: 3, selectedBoardRevisionIds: ["revision-1"], state: "idle", submittedAt: "2026-07-12T10:00:00Z" });
const executor: ArtboardAgentToolExecutor = { execute: vi.fn(async () => ({ content: { queued: true }, proposalId: "proposal-1" })) };

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
});

class MockCodexTransport implements CodexAppServerTransport {
  listeners = new Set<(event: CodexServerEvent) => void>(); calls: { method: string; params: Record<string, unknown> }[] = [];
  async start() {} async scratchDirectory() { return "/private/tmp/flowz-artboard/workspace-1"; }
  async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    if (method === "account/read") return { account: { type: "chatgpt", email: "test@example.com" }, requiresOpenaiAuth: true } as T;
    if (method === "model/list") return { data: [] } as T;
    if (method === "thread/start" || method === "thread/resume") return { thread: { id: "thread-1" } } as T;
    if (method === "turn/start") return { turn: { id: "turn-1" } } as T;
    return {} as T;
  }
  async respond() {} subscribe(listener: (event: CodexServerEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event: CodexServerEvent) { for (const listener of this.listeners) listener(event); }
  async close() {}
}

describe("Codex local Artboard adapter", () => {
  it("starts in a read-only, offline scratch cwd and exposes only exact dynamic tools", async () => {
    const transport = new MockCodexTransport(); const adapter = new CodexLocalArtboardAgentAdapter(transport, new MemoryArtboardAgentRepository(), executor);
    expect(await adapter.probe()).toMatchObject({ state: "ready", accountLabel: "test@example.com" });
    await adapter.openSession({ workspaceId: "workspace-1", branchId: "branch-main", provider: "codex-local", toolContractVersion: ARTBOARD_AGENT_TOOL_CONTRACT_VERSION, modelId: "gpt-test" });
    const start = transport.calls.find((call) => call.method === "thread/start")!;
    expect(start.params).toMatchObject({ cwd: "/private/tmp/flowz-artboard/workspace-1", approvalPolicy: "never", sandbox: "read-only" });
    expect(JSON.stringify(start.params)).toContain('"networkAccess":false'); expect(JSON.stringify(start.params)).not.toMatch(/shellCommand|command\/exec|https?:/);
  });

  it("executes validated dynamic calls into a proposal and completes without applying it", async () => {
    const transport = new MockCodexTransport(); const repository = new MemoryArtboardAgentRepository(); const adapter = new CodexLocalArtboardAgentAdapter(transport, repository, executor);
    const promise = adapter.runTurn(run("codex-local"), "Baue eine Headline", () => undefined);
    await vi.waitFor(() => expect(transport.calls.some((call) => call.method === "turn/start")).toBe(true));
    transport.emit({ method: "item/tool/call", id: 9, params: { callId: "call-1", threadId: "thread-1", turnId: "turn-1", tool: "finish_working", arguments: { workspaceId: "workspace-1", branchId: "branch-main", proposalId: "proposal-1", operationId: "operation-1", expectedRevision: 3 } } });
    await vi.waitFor(() => expect(executor.execute).toHaveBeenCalled());
    transport.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
    await expect(promise).resolves.toEqual({ providerTurnId: "turn-1" }); expect(repository.runs.get("run-1")?.proposalId).toBe("proposal-1");
  });

  it("marks a killed local process without resubmitting a turn", async () => {
    const transport = new MockCodexTransport(); const adapter = new CodexLocalArtboardAgentAdapter(transport, new MemoryArtboardAgentRepository(), executor); const promise = adapter.runTurn(run("codex-local"), "x", () => undefined);
    await vi.waitFor(() => expect(transport.calls.some((call) => call.method === "turn/start")).toBe(true)); transport.emit({ method: "process/lost" }); await expect(promise).rejects.toThrow("CODEX_PROCESS_LOST");
    expect(transport.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
  });

  it("ignores events from another thread instead of cross-wiring runs", async () => {
    const transport = new MockCodexTransport(); const repository = new MemoryArtboardAgentRepository(); const localExecutor: ArtboardAgentToolExecutor = { execute: vi.fn(async () => ({ content: {}, proposalId: "proposal-1" })) };
    const adapter = new CodexLocalArtboardAgentAdapter(transport, repository, localExecutor); const promise = adapter.runTurn(run("codex-local"), "x", () => undefined);
    await vi.waitFor(() => expect(transport.calls.some((call) => call.method === "turn/start")).toBe(true));
    transport.emit({ method: "item/tool/call", id: 4, params: { callId: "foreign", threadId: "thread-foreign", turnId: "turn-1", tool: "finish_working", arguments: {} } });
    expect(localExecutor.execute).not.toHaveBeenCalled();
    transport.emit({ method: "process/lost" }); await expect(promise).rejects.toThrow("CODEX_PROCESS_LOST");
  });
});
