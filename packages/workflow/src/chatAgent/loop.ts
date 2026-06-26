// The transport-agnostic agentic chat loop. Drives a transport adapter + an
// injected provider-turn (the keyed model call) + an injected tool executor,
// emitting the streaming events the surface renders. One loop, every runtime.

import { chatTransportAdapter } from './providerTurn.js';
import { safeParseJsonObject } from './sse.js';
import {
  chatAgenticSystemPrompt,
  chatLoopExhaustedMessage,
  chatNoTextFallback,
  chatResult,
  effectiveChatWalletAddress,
} from './systemPrompt.js';
import {
  CHAT_TOOL_MAX_ITERATIONS,
  CHAT_TOOL_NAMES,
  chatToolStatusLabel,
  validateChatProposedAction,
} from './tools.js';
import {
  anthropicHeaders,
  anthropicMessagesUrl,
  bearerJsonHeaders,
  geminiHeaders,
  geminiStreamGenerateContentUrl,
  isOpenRouterProfile,
  openAiChatCompletionsUrl,
  openRouterAttributionHeaders,
  providerFailureMessage,
  resolveChatTransport,
} from './transport.js';
import type {
  ChatAiTransport,
  ChatEventEmitter,
  ChatHistoryMessage,
  ChatModelProfile,
  ChatToolExecutor,
  ChatToolResultItem,
  ChatTransportAdapter,
  RunProviderTurn,
} from './types.js';

const PROPOSE_TOOL = 'propose_wallet_action';

// Emit `text` as a few token events so a fallback message still "streams".
async function streamTextAsTokens(text: string, emit: ChatEventEmitter, signal?: AbortSignal): Promise<void> {
  const clean = (text ?? '').toString();
  if (!clean) return;
  const chunks = clean.match(/\S+\s*/g) ?? [clean];
  for (const chunk of chunks) {
    if (signal?.aborted) return;
    await emit({ type: 'token', text: chunk });
  }
}

export interface ChatLoopRequest {
  messages: ChatHistoryMessage[];
  walletAddress?: string;
  cluster?: string;
  context?: Record<string, unknown>;
}

// The low-level loop: caller supplies the adapter + provider-turn (streaming OR
// native) + tool executor. Used directly by the native device-agent path.
export async function runAgentChatLoop(opts: {
  request: ChatLoopRequest;
  adapter: ChatTransportAdapter;
  runProviderTurn: RunProviderTurn;
  executeTool: ChatToolExecutor;
  emit: ChatEventEmitter;
  signal?: AbortSignal;
  maxIterations?: number;
}): Promise<void> {
  const { request, adapter, runProviderTurn, executeTool, emit, signal } = opts;
  const walletAddress = effectiveChatWalletAddress(request);
  const history = (request.messages ?? []).filter((m) => m.role === 'user' || m.role === 'assistant');
  const messages = adapter.initialMessages(history);
  const max = opts.maxIterations ?? CHAT_TOOL_MAX_ITERATIONS;
  let proposalEmitted = false;

  for (let iteration = 0; iteration < max; iteration += 1) {
    if (signal?.aborted) return;
    const outcome = await runProviderTurn(messages, (text) => { void emit({ type: 'token', text }); }, signal);
    if (signal?.aborted) return;

    if (outcome.toolCalls.length === 0) {
      const finalText = outcome.text.trim();
      if (!finalText) await streamTextAsTokens(chatNoTextFallback(proposalEmitted), emit, signal);
      await emit({ type: 'done', result: chatResult(finalText || chatNoTextFallback(proposalEmitted)) });
      return;
    }

    adapter.pushAssistant(messages, outcome);
    const results: ChatToolResultItem[] = [];
    for (const call of outcome.toolCalls) {
      if (signal?.aborted) return;
      const input = safeParseJsonObject(call.args);
      if (call.name === PROPOSE_TOOL) {
        const { proposal, error } = validateChatProposedAction(input);
        if (proposal) {
          await emit({ type: 'proposal', proposal });
          proposalEmitted = true;
          results.push({ call, content: 'Action prepared. Tell the user to review the card below and approve it in their wallet.' });
        } else {
          results.push({ call, content: `Could not prepare action: ${error}`, isError: true });
        }
        continue;
      }
      if (!CHAT_TOOL_NAMES.has(call.name)) {
        results.push({ call, content: `Unknown tool: ${call.name}`, isError: true });
        continue;
      }
      await emit({ type: 'tool_status', tool: call.name, phase: 'start', label: chatToolStatusLabel(call.name, input) });
      const result = await executeTool(call.name, input, walletAddress);
      await emit({ type: 'tool_status', tool: call.name, phase: 'done', label: result.summary });
      results.push({ call, content: JSON.stringify(result.data).slice(0, 6000), data: result.data });
    }
    adapter.pushToolResults(messages, results);
  }
  await emit({ type: 'done', result: chatResult(chatLoopExhaustedMessage()) });
}

function chatProviderEndpoint(profile: ChatModelProfile, apiKey: string, transport: ChatAiTransport): { url: string; headers: Record<string, string> } {
  const openRouter = isOpenRouterProfile(profile);
  // OpenRouter attribution (HTTP-Referer + X-Title) rides on the OpenAI/Anthropic
  // transports (the only ones OpenRouter serves). Gemini-native is never OpenRouter.
  const attribution = openRouter ? openRouterAttributionHeaders(profile.openRouterReferer, profile.openRouterTitle) : {};
  if (transport === 'anthropic-messages') return { url: anthropicMessagesUrl(profile), headers: { ...anthropicHeaders(apiKey, openRouter), ...attribution } };
  if (transport === 'gemini-native') return { url: geminiStreamGenerateContentUrl(profile), headers: geminiHeaders(apiKey) };
  return { url: openAiChatCompletionsUrl(profile), headers: { ...bearerJsonHeaders(apiKey, openRouter), ...attribution } };
}

// Build a STREAMING provider-turn: keyed fetch → SSE parse. The key stays inside
// this closure. Used by the server and by browser/Tauri Device Agent (key in JS).
export function createStreamingProviderTurn(input: {
  adapter: ChatTransportAdapter;
  profile: ChatModelProfile;
  apiKey: string;
  systemPrompt: string;
  model: string;
  fetchImpl?: typeof fetch;
}): RunProviderTurn {
  const doFetch = input.fetchImpl ?? fetch;
  const toolSpecs = input.adapter.toolSpecs();
  const { url, headers } = chatProviderEndpoint(input.profile, input.apiKey, input.adapter.transport);
  return async (messages, onToken, signal) => {
    const body = input.adapter.buildBody(input.systemPrompt, messages, input.model, toolSpecs);
    const res = await doFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(providerFailureMessage(payload, res.status));
    }
    return input.adapter.parseStream(res, onToken, signal);
  };
}

// High-level convenience for the common STREAMING case (server + browser/Tauri
// Device Agent): resolve transport, build adapter + streaming turn, run the loop.
export async function streamAgentChat(opts: {
  request: ChatLoopRequest;
  profile: ChatModelProfile;
  apiKey: string;
  executeTool: ChatToolExecutor;
  emit: ChatEventEmitter;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  maxIterations?: number;
}): Promise<ChatAiTransport> {
  const transport = resolveChatTransport(opts.profile);
  const adapter = chatTransportAdapter(transport);
  const systemPrompt = chatAgenticSystemPrompt(opts.request);
  const runProviderTurn = createStreamingProviderTurn({
    adapter,
    profile: opts.profile,
    apiKey: opts.apiKey,
    systemPrompt,
    model: opts.profile.model,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  await runAgentChatLoop({
    request: opts.request,
    adapter,
    runProviderTurn,
    executeTool: opts.executeTool,
    emit: opts.emit,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.maxIterations ? { maxIterations: opts.maxIterations } : {}),
  });
  return transport;
}
