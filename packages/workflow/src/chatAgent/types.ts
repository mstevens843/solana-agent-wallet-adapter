// Shared, transport-agnostic agentic chat loop — types.
//
// This module is the single source of truth for the streaming Chat-tab agent. It
// runs identically on the SERVER (cloud relay + local bridge, via mcp-server) and
// in the BROWSER/on-device (Device Agent, via browser-demo). The loop never makes
// the keyed model call or executes a tool itself — both are injected:
//   • runProviderTurn — performs ONE model completion for a transport and returns
//     the assistant text + any tool calls (streaming where supported).
//   • executeTool — runs a read tool by name and returns compact JSON.
// That keeps the Device Agent provider key on-device while the orchestration,
// tool schemas, system prompt, and proposal validation stay shared.

import type { AgentChatProposedAction, AgentChatStreamEvent, ChatCitation, ChatUsage } from '../agentPlans.js';

// The provider transports the loop knows how to drive with a tool/function-calling
// turn. 'cli-agent' (subscription connector) has no tool loop and is handled by the
// caller's single-shot fallback, not this module.
export type ChatAiTransport =
  | 'anthropic-messages'
  | 'openai-compatible'
  | 'openai-responses'
  | 'gemini-native'
  | 'cli-agent';

// The non-secret model profile used to resolve the transport and build requests.
// The API key is intentionally absent — it lives in the injected runProviderTurn.
export interface ChatModelProfile {
  provider: string;
  apiFormat: string;
  baseUrl: string;
  model: string;
  engine?: string;
  // Optional OpenRouter attribution (HTTP-Referer + X-Title). OpenRouter uses these
  // for per-app analytics + fairer rate-limits. The client passes its browser origin
  // + app title; the server passes an app title (no browser origin).
  openRouterReferer?: string;
  openRouterTitle?: string;
  // User-pickable reasoning/thinking depth, mapped per provider (OpenAI reasoning_effort,
  // Anthropic extended thinking, Gemini thinkingConfig). Absent → provider default.
  reasoningEffort?: ChatReasoningLevel;
}

// A single reasoning-depth knob the user sets once; each adapter maps it to its
// provider's native mechanism.
export type ChatReasoningLevel = 'minimal' | 'low' | 'medium' | 'high';

// Per-turn build options (replaces the old bare `streaming` boolean).
export interface ChatBuildBodyOpts {
  // SSE streaming (default true). false = a single non-streamed response (native path).
  streaming?: boolean;
  reasoningEffort?: ChatReasoningLevel;
  // True only for genuine OpenAI / OpenRouter (which support `stream_options`); false for
  // arbitrary OpenAI-compatible gateways (Ollama/LiteLLM) that 400 on the unknown field.
  openAiNative?: boolean;
}

// One user/assistant turn of prior conversation (system is added by the loop).
export interface ChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

// A normalized tool/function call surfaced by a provider turn.
export interface ChatToolCall {
  id: string;
  name: string;
  args: string; // raw JSON arguments (parsed by the loop)
}

// The result of one model completion: streamed text plus any tool calls.
export interface ChatTurnOutcome {
  text: string;
  toolCalls: ChatToolCall[];
  // The provider's stop/finish reason, normalized to lowercase (e.g. 'stop',
  // 'tool_calls', 'length'/'max_tokens', 'end_turn', 'safety'). Used to detect a
  // TRUNCATED turn (cut-off tool-call JSON or a cut-off answer). Absent if unknown.
  finishReason?: string;
  // Token usage for THIS turn (the loop sums it across turns). Absent if unreported.
  usage?: ChatUsage;
  // Web sources the model cited this turn (Anthropic native web_search).
  citations?: ChatCitation[];
}

// One executed tool result to echo back to the model. `content` is the canonical
// string (used by OpenAI/Anthropic); `data` is the structured payload (used by the
// Gemini functionResponse format).
export interface ChatToolResultItem {
  call: ChatToolCall;
  content: string;
  data?: unknown;
  isError?: boolean;
}

// Executes a read tool. Server backs this with secret-holding adapters; the client
// backs it with cloud/public read endpoints. Must never throw the turn — return a
// short summary + compact data (use { unavailable: true } / { error } on failure).
export type ChatToolExecutor = (
  name: string,
  input: Record<string, unknown>,
  walletAddress: string,
) => Promise<{ summary: string; data: unknown }>;

// Emits a streaming event to the surface (SSE on the server; ChatStreamHandlers in
// the browser).
export type ChatEventEmitter = (event: AgentChatStreamEvent) => void | Promise<void>;

// Performs ONE model completion. Receives the provider-format messages (already
// built by the transport adapter) and streams text via onToken. Returns the turn.
// Streaming transports parse SSE; the native transport returns the turn whole.
export type RunProviderTurn = (
  messages: unknown[],
  onToken: (text: string) => void | Promise<void>,
  signal?: AbortSignal,
) => Promise<ChatTurnOutcome>;

// A transport adapter owns ALL provider-format concerns so the loop stays generic.
export interface ChatTransportAdapter {
  transport: ChatAiTransport;
  // Provider-format tool/function definitions.
  toolSpecs(): unknown[];
  // Convert prior {role,content} turns into the provider's message array.
  initialMessages(history: ChatHistoryMessage[]): unknown[];
  // Build the full request body for one turn (includes system + tools). `opts.streaming`
  // false asks for a single non-streamed response (native path); `opts.reasoningEffort`
  // maps to the provider's reasoning/thinking config; `opts.openAiNative` gates
  // `stream_options`. Back-compat: a bare `boolean` is treated as `{ streaming }`.
  buildBody(system: string, messages: unknown[], model: string, toolSpecs: unknown[], opts?: ChatBuildBodyOpts | boolean): Record<string, unknown>;
  // Parse a streamed provider Response into a turn, forwarding text via onToken.
  parseStream(res: Response, onToken: (text: string) => void | Promise<void>, signal?: AbortSignal): Promise<ChatTurnOutcome>;
  // Parse a NON-streamed provider JSON response into a turn (native path). The
  // non-streaming twin of parseStream — same { text, toolCalls } contract.
  parseResponse(json: Record<string, unknown>): ChatTurnOutcome;
  // Echo the assistant turn (text + tool calls) back into the running messages.
  pushAssistant(messages: unknown[], outcome: ChatTurnOutcome): void;
  // Append ALL tool results for one turn (batched — Anthropic/Gemini require a
  // single follow-up turn carrying every tool result).
  pushToolResults(messages: unknown[], results: ChatToolResultItem[]): void;
}

export type { AgentChatProposedAction, AgentChatStreamEvent, ChatCitation, ChatUsage };
