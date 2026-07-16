// The transport-agnostic agentic chat loop. Drives a transport adapter + an
// injected provider-turn (the keyed model call) + an injected tool executor,
// emitting the streaming events the surface renders. One loop, every runtime.

import { wrapUntrustedToolData } from '../promptInjectionDefense.js';
import { chatTransportAdapter, isTruncatedFinish } from './providerTurn.js';
import { safeParseJsonObject } from './sse.js';
import {
  chatAgenticSystemPrompt,
  chatLoopExhaustedMessage,
  chatNoTextFallback,
  chatResult,
  chatTruncatedSuffix,
  effectiveChatWalletAddress,
} from './systemPrompt.js';
import {
  CHAT_MAX_HISTORY_MESSAGES,
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
  supportsStreamOptions,
} from './transport.js';
import type {
  ChatAiTransport,
  ChatCitation,
  ChatEventEmitter,
  ChatHistoryMessage,
  ChatModelProfile,
  ChatToolExecutor,
  ChatToolResultItem,
  ChatTransportAdapter,
  ChatUsage,
  RunProviderTurn,
} from './types.js';

const PROPOSE_TOOL = 'propose_wallet_action';
const CHAT_TOOL_RESULT_MAX_CHARS = 6000;

// Cap a tool result for the model WITHOUT producing invalid JSON. A naive
// `JSON.stringify(data).slice(n)` truncates mid-structure and hands the model
// malformed JSON; instead, when the result is too large, wrap a string preview in a
// valid JSON envelope so the model still receives well-formed, parseable content.
function boundedToolResultContent(data: unknown): string {
  let full: string | undefined;
  try {
    full = JSON.stringify(data);
  } catch {
    return JSON.stringify({ error: 'tool result was not serializable' });
  }
  if (full === undefined) return 'null';
  if (full.length <= CHAT_TOOL_RESULT_MAX_CHARS) return full;
  return JSON.stringify({
    truncated: true,
    note: 'Tool result was too large and has been summarized; ask the user to narrow the request if you need more detail.',
    preview: full.slice(0, CHAT_TOOL_RESULT_MAX_CHARS - 200),
  });
}

// Cap the prior conversation resent each turn → linear (not quadratic) token cost + no
// eventual context-length error. ALSO enforce strict user/assistant alternation ending on
// a USER turn: providers require the first turn to be user, and (H8-A) a history that ends
// on an assistant turn — or has consecutive same-role messages (cloud-sync replay, a
// checkpoint, a bridge/third-party caller; the browser client guards this but the server
// path does not) — would make pushAssistant append a SECOND adjacent assistant turn →
// Anthropic + Gemini reject it with a 400. Collapse consecutive same-role runs (keep the
// most recent) and drop a trailing assistant so the model always generates after a user.
function trimChatHistory(messages: ChatHistoryMessage[]): ChatHistoryMessage[] {
  const trimmed = messages.length > CHAT_MAX_HISTORY_MESSAGES ? messages.slice(-CHAT_MAX_HISTORY_MESSAGES) : messages;
  let start = 0;
  while (start < trimmed.length && trimmed[start]!.role !== 'user') start += 1;
  const alternating: ChatHistoryMessage[] = [];
  for (const m of trimmed.slice(start)) {
    if (alternating.length > 0 && alternating[alternating.length - 1]!.role === m.role) {
      alternating[alternating.length - 1] = m; // same-role run → keep the most recent
    } else {
      alternating.push(m);
    }
  }
  while (alternating.length > 0 && alternating[alternating.length - 1]!.role !== 'user') alternating.pop();
  return alternating;
}

// Sum usage across the loop's turns into a single total (each tool-using turn is a
// separate model call). Returns undefined if no turn reported usage.
class ChatUsageAccumulator {
  private seen = false;
  private input = 0; private output = 0; private cacheRead = 0; private cacheWrite = 0;
  add(usage: ChatUsage | undefined): void {
    if (!usage) return;
    this.seen = true;
    this.input += usage.inputTokens; this.output += usage.outputTokens;
    this.cacheRead += usage.cacheReadTokens ?? 0; this.cacheWrite += usage.cacheWriteTokens ?? 0;
  }
  total(): ChatUsage | undefined {
    if (!this.seen) return undefined;
    return {
      inputTokens: this.input,
      outputTokens: this.output,
      ...(this.cacheRead > 0 ? { cacheReadTokens: this.cacheRead } : {}),
      ...(this.cacheWrite > 0 ? { cacheWriteTokens: this.cacheWrite } : {}),
    };
  }
}

// Emit the per-answer summaries (deduped citations, then total usage) just before
// `done`, so the surface can render sources + a token/cost line on the finished message.
async function emitChatSummaries(emit: ChatEventEmitter, usage: ChatUsage | undefined, citations: ChatCitation[]): Promise<void> {
  if (citations.length > 0) {
    const seen = new Set<string>();
    const unique = citations.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true))).slice(0, 12);
    if (unique.length > 0) await emit({ type: 'citations', citations: unique });
  }
  if (usage) await emit({ type: 'usage', usage });
}

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
  // H7-B: the user's UI language (Android) so the loop's own fallback/exhausted/truncation
  // strings are localized, not hardcoded English.
  const uiLanguage = typeof request.context?.uiLanguage === 'string' ? request.context.uiLanguage : 'en';
  const truncSuffix = (): string => `\n\n_${chatTruncatedSuffix(uiLanguage)}_`;
  const walletAddress = effectiveChatWalletAddress(request);
  const history = trimChatHistory((request.messages ?? []).filter((m) => m.role === 'user' || m.role === 'assistant'));
  const messages = adapter.initialMessages(history);
  const max = opts.maxIterations ?? CHAT_TOOL_MAX_ITERATIONS;
  let proposalEmitted = false;
  const usageAcc = new ChatUsageAccumulator();
  const citations: ChatCitation[] = [];

  for (let iteration = 0; iteration < max; iteration += 1) {
    if (signal?.aborted) return;
    // Await the token emit so token/done ordering is deterministic even when the
    // surface's emit handler is async.
    const outcome = await runProviderTurn(messages, (text) => emit({ type: 'token', text }), signal);
    if (signal?.aborted) return;
    usageAcc.add(outcome.usage);
    if (outcome.citations?.length) citations.push(...outcome.citations);
    const truncated = isTruncatedFinish(outcome.finishReason);

    if (outcome.toolCalls.length === 0) {
      let finalText = outcome.text.trim();
      // The answer hit the token cap mid-sentence — tell the user it was cut off
      // instead of presenting a truncated reply as complete.
      if (finalText && truncated) finalText += truncSuffix();
      if (!finalText) await streamTextAsTokens(chatNoTextFallback(proposalEmitted, uiLanguage), emit, signal);
      await emitChatSummaries(emit, usageAcc.total(), citations);
      await emit({ type: 'done', result: chatResult(finalText || chatNoTextFallback(proposalEmitted, uiLanguage)) });
      return;
    }

    adapter.pushAssistant(messages, outcome);
    // Resolve every tool call for this turn CONCURRENTLY (reads are independent network
    // calls — sequential would be N× slower on a multi-tool turn). Promise.all preserves
    // call order for pushToolResults; proposals + errors resolve inline. Each executeTool
    // is error-wrapped so one failure never rejects the batch or strands a chip.
    const results: ChatToolResultItem[] = await Promise.all(outcome.toolCalls.map(async (call): Promise<ChatToolResultItem> => {
      const input = safeParseJsonObject(call.args);
      // A truncated turn can cut off a tool call's JSON args mid-stream → safeParse
      // yields {} for non-empty raw args. Running the tool with empty input would
      // silently produce a wrong/empty result, so surface it as a tool error instead.
      const argsRaw = call.args.trim();
      if (truncated && argsRaw !== '' && argsRaw !== '{}' && Object.keys(input).length === 0) {
        return { call, content: 'The request was cut off at the length limit before the tool arguments completed. Ask the user to rephrase more concisely.', isError: true };
      }
      if (call.name === PROPOSE_TOOL) {
        const { proposal, error } = validateChatProposedAction(input);
        if (proposal) {
          await emit({ type: 'proposal', proposal });
          proposalEmitted = true;
          return { call, content: 'Action prepared. Tell the user to review the card below and approve it in their wallet.' };
        }
        return { call, content: `Could not prepare action: ${error}`, isError: true };
      }
      if (!CHAT_TOOL_NAMES.has(call.name)) {
        // call.name is model-supplied; wrap it so every model-facing tool-result string is on one policy.
        return { call, content: wrapUntrustedToolData(`Unknown tool: ${call.name}`, 'unknown'), isError: true };
      }
      await emit({ type: 'tool_status', tool: call.name, phase: 'start', label: chatToolStatusLabel(call.name, input) });
      try {
        const result = await executeTool(call.name, input, walletAddress);
        await emit({ type: 'tool_status', tool: call.name, phase: 'done', label: result.summary });
        // Wrap the third-party tool result in <UNTRUSTED_TOOL_DATA> before it reaches the model.
        // Token names/symbols, connector facts, and market data are attacker-controllable; the
        // system prompt instructs the model to treat wrapped content as data, never instructions.
        return { call, content: wrapUntrustedToolData(boundedToolResultContent(result.data), call.name), data: result.data };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await emit({ type: 'tool_status', tool: call.name, phase: 'done', label: 'Tool failed' });
        // A tool error message can reflect attacker-controlled upstream content (e.g. an API that
        // echoes the queried token name into its error), so wrap it as untrusted AND size-cap it via
        // boundedToolResultContent — same ceiling as the success branch, so a huge reflected error
        // cannot blow the token budget.
        return { call, content: wrapUntrustedToolData(boundedToolResultContent({ error: message }), call.name), isError: true };
      }
    }));
    if (signal?.aborted) return;
    adapter.pushToolResults(messages, results);
  }
  // H7-F2: the loop exhausted iterations on a turn that produced tool calls — the results
  // are in `messages` but the model never got a turn to RESPOND to them. Give it ONE final
  // response turn (any further tool calls are ignored — strictly bounded) so the user gets
  // a real answer instead of the generic exhausted message.
  if (!signal?.aborted) {
    const closing = await runProviderTurn(messages, (text) => emit({ type: 'token', text }), signal);
    if (signal?.aborted) return;
    usageAcc.add(closing.usage);
    if (closing.citations?.length) citations.push(...closing.citations);
    let finalText = closing.text.trim();
    if (finalText && isTruncatedFinish(closing.finishReason)) finalText += truncSuffix();
    if (finalText) {
      await emitChatSummaries(emit, usageAcc.total(), citations);
      await emit({ type: 'done', result: chatResult(finalText) });
      return;
    }
  }
  await emitChatSummaries(emit, usageAcc.total(), citations);
  await emit({ type: 'done', result: chatResult(chatLoopExhaustedMessage(uiLanguage)) });
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

// Default per-request ceiling for one model turn. The browser/Tauri streaming path
// had NO timeout; native clamps 5–300s. 90s comfortably covers a tool-using turn.
const CHAT_STREAM_TIMEOUT_MS = 90_000;
export const CHAT_MAX_FETCH_ATTEMPTS = 3;

// A 4xx (or final) provider error that must NOT be retried — distinguishes a real
// client error from a transient network/timeout failure inside the retry loop.
class NonRetryableProviderError extends Error {}

export function chatAbortError(): Error {
  return typeof DOMException !== 'undefined' ? new DOMException('Aborted', 'AbortError') : Object.assign(new Error('Aborted'), { name: 'AbortError' });
}

// Whether a provider HTTP status should be retried (transient). 429 + 5xx only.
export function isRetryableChatStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

// Abort-aware delay. Rejects immediately if the caller's signal fires while waiting.
export function chatSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(chatAbortError()); return; }
    const onAbort = () => { clearTimeout(timer); reject(chatAbortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Exponential backoff with jitter; honors a Retry-After header in BOTH RFC 7231 forms —
// numeric delay-seconds AND an HTTP-date (H8-B: the date form was parsing to NaN and
// silently falling back to the aggressive 500ms·2^attempt backoff, hammering a server
// that told us to wait). Everything is capped at 8s so a far-future date can't hang.
export function chatRetryDelayMs(attempt: number, retryAfterHeader: string | null): number {
  let retryAfterMs = Number.NaN;
  if (retryAfterHeader) {
    const seconds = Number.parseInt(retryAfterHeader, 10);
    if (Number.isFinite(seconds)) {
      retryAfterMs = seconds * 1000;
    } else {
      const when = Date.parse(retryAfterHeader); // e.g. "Sun, 06 Nov 2025 08:49:37 GMT"
      if (Number.isFinite(when)) retryAfterMs = when - Date.now();
    }
  }
  const base = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 500 * 2 ** attempt;
  return Math.min(base, 8000) * (0.8 + Math.random() * 0.4);
}

// Keyed POST with a per-attempt timeout + bounded retry on 429/5xx/network/timeout
// (never on 4xx). Returns the OK Response for the adapter to stream. Abort-aware: the
// caller's signal cancels everything; our own timeout only aborts the current attempt.
async function fetchKeyedWithRetry(
  doFetch: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    if (signal?.aborted) throw chatAbortError();
    const ctrl = new AbortController();
    const relayAbort = () => ctrl.abort();
    signal?.addEventListener('abort', relayAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
    try {
      const res = await doFetch(url, { method: 'POST', headers, body, signal: ctrl.signal });
      if (res.ok) return res;
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= CHAT_MAX_FETCH_ATTEMPTS - 1) {
        const payload = await res.json().catch(() => ({}));
        throw new NonRetryableProviderError(providerFailureMessage(payload, res.status));
      }
      const delay = chatRetryDelayMs(attempt, res.headers.get('retry-after'));
      await res.body?.cancel().catch(() => undefined);
      await chatSleep(delay, signal);
    } catch (err) {
      if (err instanceof NonRetryableProviderError) throw err;
      if (signal?.aborted) throw err; // caller cancelled — propagate, don't retry
      if (attempt >= CHAT_MAX_FETCH_ATTEMPTS - 1) {
        throw timedOut
          ? new Error(`AI provider timed out after ${Math.round(timeoutMs / 1000)}s.`)
          : (err instanceof Error ? err : new Error('AI provider request failed.'));
      }
      await chatSleep(chatRetryDelayMs(attempt, null), signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', relayAbort);
    }
  }
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
  timeoutMs?: number;
}): RunProviderTurn {
  const doFetch = input.fetchImpl ?? fetch;
  const toolSpecs = input.adapter.toolSpecs();
  const { url, headers } = chatProviderEndpoint(input.profile, input.apiKey, input.adapter.transport);
  const timeoutMs = input.timeoutMs ?? CHAT_STREAM_TIMEOUT_MS;
  const buildOpts = {
    streaming: true,
    ...(input.profile.reasoningEffort ? { reasoningEffort: input.profile.reasoningEffort } : {}),
    openAiNative: supportsStreamOptions(input.profile),
  };
  return async (messages, onToken, signal) => {
    const body = JSON.stringify(input.adapter.buildBody(input.systemPrompt, messages, input.model, toolSpecs, buildOpts));
    const res = await fetchKeyedWithRetry(doFetch, url, headers, body, signal, timeoutMs);
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
