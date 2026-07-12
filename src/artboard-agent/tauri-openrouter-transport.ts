import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { OpenRouterAgentTransport, OpenRouterStreamEvent } from "./openrouter-adapter";
import type { ARTBOARD_AGENT_TOOL_SPECS } from "./tool-specs";

type Chunk = { id?: string; choices?: { delta?: { content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number | string } };
const SYSTEM = "You are FlowZ's Artboard design agent. Use only the supplied tools. Read bounded state and create proposal operations; never claim they are applied. Finish with finish_working.";
const micros = (value: unknown) => { const number = typeof value === "string" ? Number(value) : value; return typeof number === "number" && Number.isFinite(number) && number >= 0 ? Math.round(number * 1_000_000) : undefined; };

export class TauriOpenRouterAgentTransport implements OpenRouterAgentTransport {
  async keyStatus() { return invoke<boolean>("openrouter_key_status"); }
  async listModels() {
    const result = await invoke<{ data?: { id: string; name?: string; supported_parameters?: string[]; architecture?: { input_modalities?: string[] } }[] }>("list_models", { kind: "text" });
    return (result.data ?? []).map((model) => ({ id: model.id, name: model.name, inputModalities: model.architecture?.input_modalities, supportedParameters: model.supported_parameters }));
  }
  async run(input: { runId: string; sessionId: string; modelId: string; reasoningEffort?: string; userText: string; tools: typeof ARTBOARD_AGENT_TOOL_SPECS }, handlers: { event(event: OpenRouterStreamEvent): void; tool(call: { id: string; name: string; arguments: unknown }): Promise<{ content: unknown }> }): Promise<{ providerTurnId: string }> {
    const messages: Record<string, unknown>[] = [{ role: "system", content: SYSTEM }, { role: "user", content: input.userText }]; let providerTurnId = "";
    for (let round = 0; round < 25; round += 1) {
      const calls = new Map<number, { id: string; name: string; arguments: string }>(); let content = ""; let streamError: unknown;
      const unlisten = await listen<{ runId: string; chunk: Chunk }>("openrouter-artboard-chunk", ({ payload }) => {
        if (payload.runId !== input.runId) return; const chunk = payload.chunk; if (chunk.id && !providerTurnId) { providerTurnId = chunk.id; handlers.event({ type: "turn-started", id: chunk.id }); }
        const delta = chunk.choices?.[0]?.delta; if (delta?.content) { content += delta.content; handlers.event({ type: "text-delta", text: delta.content }); }
        for (const part of delta?.tool_calls ?? []) { const current = calls.get(part.index) ?? { id: "", name: "", arguments: "" }; current.id += part.id ?? ""; current.name += part.function?.name ?? ""; current.arguments += part.function?.arguments ?? ""; calls.set(part.index, current); }
        if (chunk.usage) handlers.event({ type: "usage", inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens, costMicrounits: micros(chunk.usage.cost), generationId: chunk.id || providerTurnId });
      });
      try { await invoke<void>("openrouter_artboard_step", { request: { runId: input.runId, body: { model: input.modelId, messages, tools: input.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })), tool_choice: "auto", parallel_tool_calls: false, reasoning: input.reasoningEffort ? { effort: input.reasoningEffort } : undefined } } }); } catch (error) { streamError = error; } finally { unlisten(); }
      if (streamError) { const message = String(streamError); handlers.event(/cancel/i.test(message) ? { type: "failed", error: "Abgebrochen." } : { type: "failed", error: message }); throw streamError; }
      const ordered = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
      if (!ordered.length) { handlers.event({ type: "completed" }); return { providerTurnId: providerTurnId || `openrouter:${crypto.randomUUID()}` }; }
      messages.push({ role: "assistant", content: content || null, tool_calls: ordered.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) });
      for (const call of ordered) { let args: unknown; try { args = JSON.parse(call.arguments); } catch { throw new Error(`Ungültige Tool-Argumente von OpenRouter: ${call.name}.`); } const output = await handlers.tool({ id: call.id, name: call.name, arguments: args }); messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output.content) }); }
    }
    throw new Error("Der OpenRouter-Agent hat das maximale Tool-Rundenbudget überschritten.");
  }
  async cancel(runId: string) { await invoke<boolean>("openrouter_artboard_cancel", { runId }); }
  async close() {}
}
