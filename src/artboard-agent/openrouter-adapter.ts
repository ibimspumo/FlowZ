import { ARTBOARD_AGENT_TOOL_CONTRACT_VERSION, validateToolInvocation, type ToolBudget } from "./tool-contract";
import { ARTBOARD_AGENT_TOOL_SPECS } from "./tool-specs";
import { agentSessionKey, type ArtboardAgentRepository } from "./repository";
import { prepareArtboardTurnDelta, sessionWithArtboardTurnCheckpoint } from "./manual-context-delta";
import type { AgentEvent, AgentProviderStatus, AgentRunSnapshot, ArtboardAgentAdapter, ArtboardAgentModel, ArtboardAgentToolExecutor, AgentSessionKey, PersistedAgentSession } from "./types";

export type OpenRouterStreamEvent =
  | { type: "turn-started"; id: string }
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; id: string; name: string; arguments: unknown }
  | { type: "usage"; inputTokens?: number; outputTokens?: number; costMicrounits?: number; generationId?: string }
  | { type: "completed" }
  | { type: "failed"; error: string };

export interface OpenRouterAgentTransport {
  keyStatus(): Promise<boolean>;
  listModels(): Promise<{ id: string; name?: string; inputModalities?: string[]; supportedParameters?: string[] }[]>;
  run(input: { runId: string; sessionId: string; modelId: string; reasoningEffort?: string; userText: string; tools: typeof ARTBOARD_AGENT_TOOL_SPECS }, handlers: {
    event(event: OpenRouterStreamEvent): void;
    tool(call: { id: string; name: string; arguments: unknown }): Promise<{ content: unknown }>;
  }): Promise<{ providerTurnId: string }>;
  cancel(runId: string): Promise<void>;
  close(): Promise<void>;
}

export class OpenRouterArtboardAgentAdapter implements ArtboardAgentAdapter {
  readonly provider = "openrouter" as const;
  constructor(private readonly transport: OpenRouterAgentTransport, private readonly repository: ArtboardAgentRepository, private readonly executor: ArtboardAgentToolExecutor) {}
  async probe(): Promise<AgentProviderStatus> { return await this.transport.keyStatus() ? { state: "ready" } : { state: "auth-required" }; }
  async listModels(): Promise<ArtboardAgentModel[]> {
    return (await this.transport.listModels()).filter((model) => model.inputModalities?.includes("text") && model.supportedParameters?.includes("tools")).map((model) => ({
      provider: this.provider, id: model.id, name: model.name ?? model.id, inputModalities: model.inputModalities!.includes("image") ? ["text", "image"] : ["text"],
    }));
  }
  latestRun(key: AgentSessionKey) { return this.repository.findLatestRun(agentSessionKey(key)); }
  saveRun(run: AgentRunSnapshot) { return this.repository.saveRun(run); }
  async openSession(input: AgentSessionKey & { modelId: string; reasoningEffort?: string; previousProviderSessionId?: string }): Promise<PersistedAgentSession> {
    const existing = await this.repository.findSession(agentSessionKey(input));
    const providerSessionId = input.previousProviderSessionId ?? existing?.providerSessionId ?? `or-session:${crypto.randomUUID()}`;
    const session: PersistedAgentSession = { ...agentSessionKey(input), providerSessionId, modelId: input.modelId, reasoningEffort: input.reasoningEffort, ...(existing?.providerSessionId === providerSessionId && existing.lastTurnId ? { lastTurnId: existing.lastTurnId } : {}), ...(existing?.manualContextCheckpoint ? { manualContextCheckpoint: existing.manualContextCheckpoint } : {}) };
    await this.repository.saveSession(session); return session;
  }
  async runTurn(input: AgentRunSnapshot, userText: string, onEvent: (event: AgentEvent) => void): Promise<{ providerTurnId: string }> {
    if (input.provider !== this.provider || input.toolContractVersion !== ARTBOARD_AGENT_TOOL_CONTRACT_VERSION) throw new Error("Inkompatibler OpenRouter-Agentlauf.");
    const preparedDelta = await prepareArtboardTurnDelta(this.executor, this.repository, input);
    const contextualUserText = `${preparedDelta.initialContext}${preparedDelta.delta ? `\n\n${preparedDelta.delta}` : ""}\n\nUse the exact current board/layer IDs above. For a system font set fontFamily without fontHash; only reuse a CAS fontHash already present in the snapshot. Avoid redundant reads and make at most one targeted recovery read after a rejected mutation.\n\nUser request:\n${userText}`;
    let budget: ToolBudget = { calls: 0, mutations: 0 }; let proposalId: string | undefined; let providerTurnId = input.providerTurnId;
    const usage = { inputTokens: 0, outputTokens: 0, costMicrounits: 0, generationId: undefined as string | undefined };
    let sawUsage = false;
    await this.repository.saveRun({ ...input, state: "submitting" }); onEvent({ type: "status", status: "submitting" });
    try {
      const result = await this.transport.run({ runId: input.runId, sessionId: input.providerSessionId, modelId: input.modelId, reasoningEffort: input.reasoningEffort, userText: contextualUserText, tools: ARTBOARD_AGENT_TOOL_SPECS }, {
        event: (event) => {
          if (event.type === "turn-started") { providerTurnId = event.id; void this.repository.saveRun({ ...input, providerTurnId: event.id, state: "streaming" }).catch(() => undefined); onEvent({ type: "provider-turn-started", providerTurnId: event.id }); onEvent({ type: "status", status: "streaming" }); }
          else if (event.type === "text-delta") onEvent({ type: "text-delta", text: event.text });
          else if (event.type === "usage") { sawUsage = true; usage.inputTokens += event.inputTokens ?? 0; usage.outputTokens += event.outputTokens ?? 0; usage.costMicrounits += event.costMicrounits ?? 0; usage.generationId = event.generationId ?? usage.generationId; onEvent({ type: "usage", ...usage }); }
          else if (event.type === "failed") onEvent({ type: "failed", error: event.error });
        },
        tool: async (call) => {
          const rawArguments = call.arguments && typeof call.arguments === "object" ? call.arguments as Record<string, unknown> : undefined;
          const operationId = typeof rawArguments?.operationId === "string" ? rawArguments.operationId : call.id;
          onEvent({ type: "tool-started", tool: call.name, operationId });
          try {
            const checked = validateToolInvocation({ tool: call.name, arguments: call.arguments }, budget); budget = checked.nextBudget;
            const output = await this.executor.execute(checked.invocation); proposalId = output.proposalId ?? proposalId;
            onEvent({ type: "tool-completed", tool: checked.invocation.tool, operationId, success: true });
            if (output.proposalId) onEvent({ type: "proposal-updated", proposalId: output.proposalId });
            return { content: output.content };
          } catch (error) {
            onEvent({ type: "tool-completed", tool: call.name, operationId, success: false });
            throw error;
          }
        },
      });
      providerTurnId = result.providerTurnId;
      if (!proposalId) throw new Error("Der Design-Agent hat keinen anwendbaren Vorschlag erzeugt.");
      if (sawUsage) await this.repository.saveUsage({ runId: input.runId, providerTurnId, ...usage });
      onEvent({ type: "status", status: "finalizing" }); onEvent({ type: "completed", proposalId });
      await this.repository.saveRun({ ...input, providerTurnId, proposalId, state: "proposal-ready" });
      await this.repository.saveSession(sessionWithArtboardTurnCheckpoint({ ...agentSessionKey(input), providerSessionId: input.providerSessionId, modelId: input.modelId, reasoningEffort: input.reasoningEffort, lastTurnId: providerTurnId }, preparedDelta));
      return { providerTurnId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error); const cancelled = /abort|cancel/i.test(message);
      onEvent(cancelled ? { type: "interrupted" } : { type: "failed", error: message });
      if (sawUsage) await this.repository.saveUsage({ runId: input.runId, providerTurnId, ...usage });
      await this.repository.saveRun({ ...input, providerTurnId, state: cancelled ? "interrupted" : "failed", error: message }); throw error;
    }
  }
  async cancel(runId: string) { await this.transport.cancel(runId); }
  async recover(run: AgentRunSnapshot) {
    if (["submitting", "streaming", "tool-executing", "finalizing", "cancel-requested"].includes(run.state)) return { ...run, state: "unknown" as const, error: "OpenRouter kann einen getrennten SSE-Lauf nicht sicher erneut anhängen; nie automatisch erneut senden." };
    return run;
  }
  async close() { await this.transport.close(); }
}
