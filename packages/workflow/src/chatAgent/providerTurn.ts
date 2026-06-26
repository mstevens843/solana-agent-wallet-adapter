// Per-transport adapters: build the request body, parse the streamed response into
// { text, toolCalls }, and format the assistant echo + batched tool results. These
// own ALL provider-format differences so the loop stays generic. Generalized from
// the server's runAnthropicChatLoop / runOpenAiChatLoop, plus a new Gemini turn.

import { iterateProviderSse, safeParseJsonObject } from './sse.js';
import { CHAT_ANTHROPIC_MAX_TOKENS, CHAT_TOOL_MAX_TOKENS, CHAT_TOOL_NAMES, chatAnthropicWebSearchTool, chatToolsAnthropic, chatToolsGemini, chatToolsOpenAi } from './tools.js';
import type {
  ChatAiTransport,
  ChatBuildBodyOpts,
  ChatCitation,
  ChatHistoryMessage,
  ChatReasoningLevel,
  ChatThinkingBlock,
  ChatToolCall,
  ChatToolResultItem,
  ChatTransportAdapter,
  ChatTurnOutcome,
  ChatUsage,
} from './types.js';

const PROPOSE_TOOL = 'propose_wallet_action';
function isKnownChatTool(name: string): boolean {
  return CHAT_TOOL_NAMES.has(name) || name === PROPOSE_TOOL;
}

// A 200 response can still carry a provider `error` object, or an empty result set
// (Gemini safety block, rate-limit). parseResponse (the native non-streaming path)
// must surface these as a thrown error so the loop reports the real failure instead
// of silently returning "" → "couldn't produce a response".
function throwIfProviderResponseError(json: Record<string, unknown>): void {
  const err = json.error;
  if (err === undefined || err === null) return;
  const message = typeof err === 'string'
    ? err
    : (err && typeof err === 'object' && typeof (err as Record<string, unknown>).message === 'string')
      ? String((err as Record<string, unknown>).message)
      : 'provider error';
  throw new Error(`AI provider error. ${message}`);
}

// Coerce a tool-call argument value to a JSON string. Providers occasionally hand
// back an object (Gemini) or a non-string (bad SDK shim) — normalize defensively.
function toolArgsString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '{}';
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

// Normalize a provider stop/finish reason to { finishReason: lowercased } (or {} when
// absent), so `...normalizeFinish(x)` only adds the field when present.
function normalizeFinish(reason: unknown): { finishReason?: string } {
  return typeof reason === 'string' && reason ? { finishReason: reason.toLowerCase() } : {};
}

// A turn whose output was cut off by the token cap → incomplete tool-call JSON / a
// cut-off answer. Spans OpenAI ('length'), Anthropic ('max_tokens'), Gemini ('max_tokens').
const TRUNCATION_FINISH_REASONS = new Set(['length', 'max_tokens', 'max_output_tokens', 'model_length']);
export function isTruncatedFinish(reason?: string): boolean {
  return reason !== undefined && TRUNCATION_FINISH_REASONS.has(reason.toLowerCase());
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
function usageOrUndefined(inputTokens: number, outputTokens: number, cacheRead = 0, cacheWrite = 0): ChatUsage | undefined {
  if (inputTokens <= 0 && outputTokens <= 0 && cacheRead <= 0) return undefined;
  return {
    inputTokens,
    outputTokens,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
  };
}
function openAiUsage(u: unknown): ChatUsage | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const r = u as Record<string, unknown>;
  const details = r.prompt_tokens_details && typeof r.prompt_tokens_details === 'object' ? (r.prompt_tokens_details as Record<string, unknown>) : {};
  return usageOrUndefined(num(r.prompt_tokens), num(r.completion_tokens), num(details.cached_tokens));
}
function geminiUsage(u: unknown): ChatUsage | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const r = u as Record<string, unknown>;
  return usageOrUndefined(num(r.promptTokenCount), num(r.candidatesTokenCount), num(r.cachedContentTokenCount));
}
function anthropicResponseUsage(u: unknown): ChatUsage | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const r = u as Record<string, unknown>;
  return usageOrUndefined(num(r.input_tokens), num(r.output_tokens), num(r.cache_read_input_tokens), num(r.cache_creation_input_tokens));
}
// Anthropic's web_search_tool_result block holds the cited sources; collect {url,title}.
function anthropicCitations(block: Record<string, unknown>): ChatCitation[] {
  if (block.type !== 'web_search_tool_result' || !Array.isArray(block.content)) return [];
  const out: ChatCitation[] = [];
  for (const r of block.content as unknown[]) {
    if (r && typeof r === 'object' && typeof (r as Record<string, unknown>).url === 'string') {
      const rec = r as Record<string, unknown>;
      out.push({ url: rec.url as string, ...(typeof rec.title === 'string' ? { title: rec.title } : {}) });
    }
  }
  return out;
}

// OpenAI reasoning models (o-series + gpt-5 family, incl. OpenRouter `openai/o3-…`
// prefixes): they reject `max_tokens` (need `max_completion_tokens`) + a non-default
// `temperature`, and accept `reasoning_effort`. Broad o[1-9] match future-proofs new
// o-series. Exported so callers stay consistent.
export function isOpenAiReasoningModel(model: string): boolean {
  return /(^|[/:-])(o[1-9]|gpt-5)/i.test(model.trim());
}
function isDefaultTemperatureOnlyModel(model: string): boolean {
  return isOpenAiReasoningModel(model);
}

// Back-compat: a bare boolean 5th arg means `{ streaming }`.
function normalizeBuildOpts(opts?: ChatBuildBodyOpts | boolean): ChatBuildBodyOpts & { streaming: boolean } {
  if (typeof opts === 'boolean') return { streaming: opts };
  return { streaming: true, ...opts };
}
// OpenAI reasoning_effort (o-series/gpt-5 only). 'minimal' is gpt-5-only → clamp elsewhere.
function openAiReasoningEffort(model: string, level?: ChatReasoningLevel): string | undefined {
  if (!level || !isOpenAiReasoningModel(model)) return undefined;
  if (level === 'minimal' && !/gpt-5/i.test(model)) return 'low';
  return level;
}
// Extra output budget (on TOP of the answer floor) for OpenAI reasoning models, scaled by
// effort. Reasoning models count hidden reasoning tokens against max_completion_tokens, so a
// flat 2048 cap can be entirely consumed by reasoning → an empty visible answer. Mirrors the
// Anthropic thinking headroom. (Non-reasoning models keep the plain CHAT_TOOL_MAX_TOKENS cap.)
function openAiReasoningReserve(level?: ChatReasoningLevel): number {
  switch (level) {
    case 'high': return 8192;
    case 'low': return 2048;
    case 'minimal': return 1024;
    default: return 4096; // medium (or unset, which OpenAI treats as medium)
  }
}
// Anthropic flagship generation (Opus 4.7/4.8, Fable 5, Mythos 5) REMOVED sampling params
// (temperature/top_p/top_k) and the legacy `thinking.budget_tokens` form — BOTH return 400
// there. Older models (Opus ≤4.6, Sonnet 4.x/3.x — including the app's presets) still accept
// them. We branch the body on this: flagships use `thinking:{type:'adaptive'}` + no
// temperature; older models keep the enabled+budget_tokens form + temperature-when-no-thinking.
function anthropicDropsSamplingAndBudgetTokens(model: string): boolean {
  return /(^|[/:-])(opus-4-[789]|fable-5|mythos-5)/i.test(model.trim());
}
// Anthropic extended-thinking budget for medium/high; undefined = no thinking.
function anthropicThinkingBudget(level?: ChatReasoningLevel): number | undefined {
  // Only 'high' enables Anthropic extended thinking. The default ('medium') stays FAST
  // (no thinking tax) so simple wallet lookups don't pay the per-turn latency/cost — the
  // user opts up to 'high' for deep reasoning. (Gemini 'medium' keeps its own dynamic
  // default; OpenAI o-series 'medium' still maps to reasoning_effort.)
  if (level === 'high') return 6144;
  return undefined;
}
// Gemini 2.5 thinkingBudget; only for 2.5 (thinking) models. -1 = dynamic (medium).
// undefined = leave the model default. Verified ranges: Pro 128–32768, Flash 0–24576,
// Flash-Lite 512–24576 — so 'minimal' must floor at 512 on Flash-Lite or the API 400s.
// (H7-A2: require the decimal so 'gemini-25-flash' / '25' don't match.)
function geminiThinkingBudget(model: string, level?: ChatReasoningLevel): number | undefined {
  if (!level || !/(gemini-)?2\.5|2\.0-flash-thinking/i.test(model)) return undefined;
  const flashLite = /flash-lite/i.test(model);
  switch (level) {
    case 'minimal': return flashLite ? 512 : 128;
    case 'low': return 1024;
    case 'high': return 8192;
    default: return -1; // medium → dynamic
  }
}

// Tag the LAST tool with cache_control so Anthropic caches the whole system+tools
// prefix (a single breakpoint covers everything before it).
function withLastToolCached(toolSpecs: unknown[]): unknown[] {
  if (toolSpecs.length === 0) return toolSpecs;
  const out = toolSpecs.slice();
  const last = out[out.length - 1];
  if (last && typeof last === 'object') out[out.length - 1] = { ...(last as Record<string, unknown>), cache_control: { type: 'ephemeral' } };
  return out;
}

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; inputJson: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string };

// Collect the (ordered) extended-thinking blocks from a parsed turn so pushAssistant can
// replay them verbatim on the next request (required when thinking is enabled + a tool_use
// is present — see types.ts ChatThinkingBlock).
function collectAnthropicThinking(blocks: Array<AnthropicBlock | undefined>): ChatThinkingBlock[] {
  const out: ChatThinkingBlock[] = [];
  for (const b of blocks) {
    if (!b) continue;
    if (b.type === 'thinking') out.push({ type: 'thinking', thinking: b.thinking, signature: b.signature });
    else if (b.type === 'redacted_thinking') out.push({ type: 'redacted_thinking', data: b.data });
  }
  return out;
}

const anthropicAdapter: ChatTransportAdapter = {
  transport: 'anthropic-messages',
  // Our function tools + Anthropic's native web_search (server tool). Anthropic
  // executes web_search inline; parseStream/parseResponse ignore its server_tool_use
  // / web_search_tool_result blocks and only surface our function tool_use + the text.
  toolSpecs: () => [...chatToolsAnthropic(), chatAnthropicWebSearchTool()],
  initialMessages: (history) => history.map((m) => ({ role: m.role, content: m.content })),
  buildBody: (system, messages, model, toolSpecs, opts) => {
    const o = normalizeBuildOpts(opts);
    // Extended thinking (reasoning depth High): Anthropic streams `thinking` blocks (now
    // captured by parseStream + replayed by pushAssistant), REQUIRES temperature unset, and
    // needs max_tokens > the thinking budget. The form is model-dependent (see
    // anthropicDropsSamplingAndBudgetTokens): modern flagships use `adaptive`, older models use
    // `enabled`+budget_tokens — sending the wrong one (or temperature on a flagship) 400s.
    const flagship = anthropicDropsSamplingAndBudgetTokens(model);
    const thinkBudget = anthropicThinkingBudget(o.reasoningEffort); // number only for 'high'
    const wantsThinking = thinkBudget !== undefined;
    const thinkingConfig: Record<string, unknown> | undefined = wantsThinking
      ? (flagship ? { type: 'adaptive' } : { type: 'enabled', budget_tokens: thinkBudget })
      : undefined;
    const maxTokens = wantsThinking
      ? Math.max(CHAT_ANTHROPIC_MAX_TOKENS, (thinkBudget ?? 6144) + 2048)
      : CHAT_ANTHROPIC_MAX_TOKENS;
    // temperature: removed (→400) on the modern flagships; sent only on models that accept it
    // AND only when thinking is off (thinking requires temperature unset).
    const sendTemperature = !wantsThinking && !flagship;
    return {
      model,
      max_tokens: maxTokens,
      // Prompt caching (`cache_control: ephemeral`) on the system block + the LAST tool
      // caches the stable system+tools prefix for ~5 min (major multi-turn saving).
      // Silently ignored below the cache minimum; GA on anthropic-version 2023-06-01,
      // no beta header needed (verified).
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages,
      tools: withLastToolCached(toolSpecs),
      tool_choice: { type: 'auto' },
      stream: o.streaming,
      ...(thinkingConfig ? { thinking: thinkingConfig } : {}),
      ...(sendTemperature ? { temperature: 0.3 } : {}),
    };
  },
  parseResponse(json) {
    // Non-streamed /messages: { content: [{type:'text',text}|{type:'tool_use',id,name,input}] }
    throwIfProviderResponseError(json);
    if (!Array.isArray(json.content)) {
      throw new Error('AI provider returned a response with no content.');
    }
    const blocks = json.content as Array<Record<string, unknown>>;
    let text = '';
    const toolCalls: ChatToolCall[] = [];
    const citations: ChatCitation[] = [];
    const thinking: ChatThinkingBlock[] = [];
    for (const block of blocks) {
      // 'text' / our 'tool_use' are surfaced; thinking/redacted_thinking are captured for
      // replay; web_search_tool_result blocks yield citations; Anthropic's server_tool_use
      // block is otherwise ignored.
      if (block.type === 'text' && typeof block.text === 'string') text += block.text;
      else if (block.type === 'thinking') thinking.push({ type: 'thinking', thinking: String(block.thinking ?? ''), signature: String(block.signature ?? '') });
      else if (block.type === 'redacted_thinking') thinking.push({ type: 'redacted_thinking', data: String(block.data ?? '') });
      else if (block.type === 'tool_use' && typeof block.name === 'string' && isKnownChatTool(block.name)) {
        toolCalls.push({ id: String(block.id ?? ''), name: block.name, args: toolArgsString(block.input) });
      } else citations.push(...anthropicCitations(block));
    }
    const usage = anthropicResponseUsage(json.usage);
    return { text, toolCalls, ...normalizeFinish(json.stop_reason), ...(usage ? { usage } : {}), ...(citations.length ? { citations } : {}), ...(thinking.length ? { thinking } : {}) };
  },
  async parseStream(res, onToken, signal) {
    const blocks: Array<AnthropicBlock | undefined> = [];
    let text = '';
    let stopReason: unknown;
    const citations: ChatCitation[] = [];
    let inTok = 0; let outTok = 0; let cacheRead = 0; let cacheWrite = 0;
    for await (const frame of iterateProviderSse(res, signal)) {
      if (signal?.aborted) break;
      const evt = safeParseJsonObject(frame.data);
      const type = frame.event || String(evt.type ?? '');
      if (type === 'error') {
        const err = evt.error && typeof evt.error === 'object' ? (evt.error as Record<string, unknown>) : {};
        throw new Error(`AI provider error. ${String(err.message ?? 'stream error')}`);
      }
      if (type === 'message_start') {
        const u = (evt.message as Record<string, unknown> | undefined)?.usage;
        if (u && typeof u === 'object') {
          const r = u as Record<string, unknown>;
          inTok = num(r.input_tokens); cacheRead = num(r.cache_read_input_tokens); cacheWrite = num(r.cache_creation_input_tokens);
        }
      } else if (type === 'content_block_start') {
        const cb = evt.content_block && typeof evt.content_block === 'object' ? (evt.content_block as Record<string, unknown>) : {};
        const index = Number(evt.index ?? 0);
        if (cb.type === 'text') blocks[index] = { type: 'text', text: '' };
        else if (cb.type === 'tool_use') blocks[index] = { type: 'tool_use', id: String(cb.id ?? ''), name: String(cb.name ?? ''), inputJson: '' };
        // Extended-thinking blocks (reasoning depth High). Captured so pushAssistant can replay
        // them verbatim next turn — Anthropic 400s a tool_use turn that omits its thinking block.
        // `thinking` starts empty + fills via thinking_delta/signature_delta; `redacted_thinking`
        // arrives whole with an opaque `data` blob.
        else if (cb.type === 'thinking') blocks[index] = { type: 'thinking', thinking: String(cb.thinking ?? ''), signature: String(cb.signature ?? '') };
        else if (cb.type === 'redacted_thinking') blocks[index] = { type: 'redacted_thinking', data: String(cb.data ?? '') };
        else citations.push(...anthropicCitations(cb)); // web_search_tool_result arrives whole
      } else if (type === 'content_block_delta') {
        const delta = evt.delta && typeof evt.delta === 'object' ? (evt.delta as Record<string, unknown>) : {};
        const block = blocks[Number(evt.index ?? 0)];
        if (delta.type === 'text_delta' && block?.type === 'text') {
          const piece = String(delta.text ?? '');
          block.text += piece;
          text += piece;
          if (piece) await onToken(piece);
        } else if (delta.type === 'input_json_delta' && block?.type === 'tool_use') {
          block.inputJson += String(delta.partial_json ?? '');
        } else if (delta.type === 'thinking_delta' && block?.type === 'thinking') {
          block.thinking += String(delta.thinking ?? '');
        } else if (delta.type === 'signature_delta' && block?.type === 'thinking') {
          block.signature += String(delta.signature ?? '');
        }
      } else if (type === 'message_delta') {
        // Carries the terminal stop_reason + the cumulative output token count.
        const delta = evt.delta && typeof evt.delta === 'object' ? (evt.delta as Record<string, unknown>) : {};
        if (delta.stop_reason !== undefined) stopReason = delta.stop_reason;
        const u = evt.usage && typeof evt.usage === 'object' ? (evt.usage as Record<string, unknown>) : {};
        if (u.output_tokens !== undefined) outTok = num(u.output_tokens);
      }
    }
    const toolCalls: ChatToolCall[] = blocks
      .filter((b): b is AnthropicBlock & { type: 'tool_use' } => Boolean(b) && b!.type === 'tool_use' && isKnownChatTool(b!.name))
      .map((b) => ({ id: b.id, name: b.name, args: b.inputJson }));
    const thinking = collectAnthropicThinking(blocks);
    const usage = usageOrUndefined(inTok, outTok, cacheRead, cacheWrite);
    return { text, toolCalls, ...normalizeFinish(stopReason), ...(usage ? { usage } : {}), ...(citations.length ? { citations } : {}), ...(thinking.length ? { thinking } : {}) };
  },
  pushAssistant(messages, outcome) {
    // Reconstruct the assistant turn. Replay extended-thinking block(s) FIRST and verbatim
    // (with signature): when thinking is enabled and this turn carries a tool_use, Anthropic
    // REQUIRES the originating thinking block to lead the assistant turn on the follow-up
    // request, or the next call 400s ("Expected `thinking` ... when `thinking` is enabled").
    // Then the text block (dropped if empty — Anthropic rejects empty text), then tool_use.
    const content: Array<Record<string, unknown>> = [];
    for (const tb of outcome.thinking ?? []) {
      if (tb.type === 'thinking') content.push({ type: 'thinking', thinking: tb.thinking, signature: tb.signature });
      else content.push({ type: 'redacted_thinking', data: tb.data });
    }
    if (outcome.text.trim()) content.push({ type: 'text', text: outcome.text });
    for (const t of outcome.toolCalls) content.push({ type: 'tool_use', id: t.id, name: t.name, input: safeParseJsonObject(t.args) });
    (messages as unknown[]).push({ role: 'assistant', content });
  },
  pushToolResults(messages, results) {
    (messages as unknown[]).push({
      role: 'user',
      content: results.map((r) => ({
        type: 'tool_result',
        tool_use_id: r.call.id,
        content: r.content,
        ...(r.isError ? { is_error: true } : {}),
      })),
    });
  },
};

const openAiAdapter: ChatTransportAdapter = {
  transport: 'openai-compatible',
  toolSpecs: () => chatToolsOpenAi(),
  initialMessages: (history) => history.map((m) => ({ role: m.role, content: m.content })),
  buildBody: (system, messages, model, toolSpecs, opts) => {
    const o = normalizeBuildOpts(opts);
    // Reasoning models (o-series/gpt-5) reject the legacy `max_tokens` + `temperature`
    // (need `max_completion_tokens`) and accept `reasoning_effort`. H7-A1: gate ALL of
    // these on `openAiNative` — a CUSTOM gateway (Ollama/LiteLLM) with a model merely
    // NAMED like an o-series (`o1-local`) would otherwise 400 on the OpenAI-only fields.
    const reasoning = isDefaultTemperatureOnlyModel(model) && o.openAiNative === true;
    const effort = o.openAiNative === true ? openAiReasoningEffort(model, o.reasoningEffort) : undefined;
    // Reasoning models bill hidden reasoning tokens against max_completion_tokens; give them
    // effort-scaled headroom over the answer floor so reasoning can't starve the visible reply.
    const maxOutputTokens = reasoning ? CHAT_TOOL_MAX_TOKENS + openAiReasoningReserve(o.reasoningEffort) : CHAT_TOOL_MAX_TOKENS;
    return {
      model,
      messages: [{ role: 'system', content: system }, ...messages],
      [reasoning ? 'max_completion_tokens' : 'max_tokens']: maxOutputTokens,
      tools: toolSpecs,
      tool_choice: 'auto',
      stream: o.streaming,
      // stream_options.include_usage is standard OpenAI/OpenRouter, but strict
      // OpenAI-compatible gateways (Ollama/LiteLLM) 400 on it → only send for native.
      ...(o.streaming && o.openAiNative ? { stream_options: { include_usage: true } } : {}),
      ...(effort ? { reasoning_effort: effort } : {}),
      ...(reasoning ? {} : { temperature: 0.3 }),
    };
  },
  parseResponse(json) {
    // Non-streamed /chat/completions: { choices:[{ message:{ content, tool_calls:[{id,function:{name,arguments}}] } }] }
    throwIfProviderResponseError(json);
    const choices = Array.isArray(json.choices) ? (json.choices as Array<Record<string, unknown>>) : [];
    if (choices.length === 0) throw new Error('AI provider returned no choices.');
    const message = choices[0]?.message && typeof choices[0].message === 'object' ? (choices[0].message as Record<string, unknown>) : {};
    const text = typeof message.content === 'string' ? message.content : '';
    const rawCalls = Array.isArray(message.tool_calls) ? (message.tool_calls as Array<Record<string, unknown>>) : [];
    const toolCalls: ChatToolCall[] = rawCalls
      .map((raw): ChatToolCall => {
        const fn = raw.function && typeof raw.function === 'object' ? (raw.function as Record<string, unknown>) : {};
        return { id: String(raw.id ?? ''), name: String(fn.name ?? ''), args: toolArgsString(fn.arguments) };
      })
      .filter((call) => Boolean(call.name) && isKnownChatTool(call.name));
    const usage = openAiUsage(json.usage);
    return { text, toolCalls, ...normalizeFinish(choices[0]?.finish_reason), ...(usage ? { usage } : {}) };
  },
  async parseStream(res, onToken, signal) {
    let text = '';
    let finishReason: unknown;
    let usage: ChatUsage | undefined;
    const acc: Array<{ id: string; name: string; args: string } | undefined> = [];
    for await (const frame of iterateProviderSse(res, signal)) {
      if (signal?.aborted) break;
      // H7-F1: trim so a `data: [DONE] ` with trailing whitespace still terminates the
      // loop (some gateways emit it); JSON.parse already tolerates surrounding space.
      if (frame.data.trim() === '[DONE]') break;
      const evt = safeParseJsonObject(frame.data);
      // Some OpenAI-compatible gateways stream an error object mid-stream.
      if (evt.error) {
        const e = typeof evt.error === 'object' && evt.error ? (evt.error as Record<string, unknown>) : {};
        throw new Error(`AI provider error. ${String(e.message ?? evt.error ?? 'stream error')}`);
      }
      // The final frame (stream_options.include_usage) carries usage with empty choices.
      if (evt.usage) usage = openAiUsage(evt.usage) ?? usage;
      const choices = Array.isArray(evt.choices) ? (evt.choices as Array<Record<string, unknown>>) : [];
      if (choices[0]?.finish_reason != null) finishReason = choices[0].finish_reason;
      const delta = choices[0]?.delta && typeof choices[0].delta === 'object' ? (choices[0].delta as Record<string, unknown>) : {};
      if (typeof delta.content === 'string' && delta.content) {
        text += delta.content;
        await onToken(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const raw of delta.tool_calls as Array<Record<string, unknown>>) {
          const index = Number(raw.index ?? 0);
          const slot = acc[index] ?? { id: '', name: '', args: '' };
          if (typeof raw.id === 'string' && raw.id) slot.id = raw.id;
          const fn = raw.function && typeof raw.function === 'object' ? (raw.function as Record<string, unknown>) : {};
          if (typeof fn.name === 'string') slot.name += fn.name;
          if (typeof fn.arguments === 'string') slot.args += fn.arguments;
          acc[index] = slot;
        }
      }
    }
    const toolCalls: ChatToolCall[] = acc.filter((t): t is { id: string; name: string; args: string } => Boolean(t && t.name) && isKnownChatTool(t!.name));
    return { text, toolCalls, ...normalizeFinish(finishReason), ...(usage ? { usage } : {}) };
  },
  pushAssistant(messages, outcome) {
    (messages as unknown[]).push({
      role: 'assistant',
      content: outcome.text || null,
      tool_calls: outcome.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.args } })),
    });
  },
  pushToolResults(messages, results) {
    for (const r of results) (messages as unknown[]).push({ role: 'tool', tool_call_id: r.call.id, content: r.content });
  },
};

const geminiAdapter: ChatTransportAdapter = {
  transport: 'gemini-native',
  toolSpecs: () => chatToolsGemini(),
  initialMessages: (history) => history.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
  // Gemini streams via the URL (:streamGenerateContent), not a body flag, so the
  // body is identical for streaming and non-streaming — `opts.streaming` is ignored.
  buildBody: (system, contents, model, toolSpecs, opts) => {
    // Gemini 2.5 ships thinking ON by default (latency + token cost every turn). Map the
    // user's reasoning depth onto a budget (only for 2.5 thinking models; others keep their
    // default). includeThoughts:false → thought parts stay out of the answer.
    const thinkBudget = geminiThinkingBudget(model, normalizeBuildOpts(opts).reasoningEffort);
    // Gemini bills thinking tokens against maxOutputTokens, so a flat 2048 cap while
    // thinkingBudget climbs to 8192 (or -1 dynamic) starves — or entirely empties — the
    // visible answer. Raise the cap above the thinking budget (mirrors Anthropic's headroom);
    // for dynamic (-1) thinking, reserve generous headroom so thinking can't eat the reply.
    const maxOutputTokens = thinkBudget === undefined
      ? CHAT_TOOL_MAX_TOKENS
      : thinkBudget > 0
        ? thinkBudget + CHAT_TOOL_MAX_TOKENS
        : CHAT_TOOL_MAX_TOKENS + 8192;
    return {
      systemInstruction: { parts: [{ text: system }] },
      contents,
      tools: toolSpecs,
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens,
        ...(thinkBudget !== undefined ? { thinkingConfig: { thinkingBudget: thinkBudget, includeThoughts: false } } : {}),
      },
      // Crypto/wallet discussion (moving funds, risk, swaps) can trip Gemini's
      // DANGEROUS_CONTENT filter → an empty/blocked candidate. Relax all four to the high
      // threshold for this financial assistant. NOTE: BLOCK_NONE is intentionally avoided —
      // accounts not allowlisted / not on invoiced billing get a hard 400 ("restricted
      // HarmBlockThreshold setting BLOCK_NONE") on every turn, which would break Gemini chat
      // for those BYOK users; BLOCK_ONLY_HIGH is accepted on all accounts and a rare hard
      // block still surfaces via the SAFETY finish-reason error.
      safetySettings: [
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      ],
    };
  },
  parseResponse(json) {
    // Non-streamed :generateContent: { candidates:[{ content:{ parts:[{text}|{functionCall:{name,args}}] } }] }
    throwIfProviderResponseError(json);
    const candidates = Array.isArray(json.candidates) ? (json.candidates as Array<Record<string, unknown>>) : [];
    if (candidates.length === 0) {
      // Empty candidates = safety block / recitation / rate-limit. Surface the reason.
      const feedback = json.promptFeedback && typeof json.promptFeedback === 'object' ? (json.promptFeedback as Record<string, unknown>) : {};
      throw new Error(`AI provider returned no candidates.${feedback.blockReason ? ` (${String(feedback.blockReason)})` : ''}`);
    }
    const content = candidates[0]?.content && typeof candidates[0].content === 'object' ? (candidates[0].content as Record<string, unknown>) : {};
    const parts = Array.isArray(content.parts) ? (content.parts as Array<Record<string, unknown>>) : [];
    let text = '';
    const toolCalls: ChatToolCall[] = [];
    for (const part of parts) {
      if (part.thought === true) continue; // reasoning part — never the answer (defense-in-depth; includeThoughts:false already suppresses it)
      if (typeof part.text === 'string') text += part.text;
      const fc = part.functionCall && typeof part.functionCall === 'object' ? (part.functionCall as Record<string, unknown>) : null;
      if (fc && typeof fc.name === 'string' && isKnownChatTool(fc.name)) {
        toolCalls.push({ id: `gem_${toolCalls.length}`, name: fc.name, args: toolArgsString(fc.args) });
      }
    }
    const usage = geminiUsage(json.usageMetadata);
    return { text, toolCalls, ...normalizeFinish(candidates[0]?.finishReason), ...(usage ? { usage } : {}) };
  },
  async parseStream(res, onToken, signal) {
    let text = '';
    let finishReason: unknown;
    let usage: ChatUsage | undefined;
    const toolCalls: ChatToolCall[] = [];
    for await (const frame of iterateProviderSse(res, signal)) {
      if (signal?.aborted) break;
      const evt = safeParseJsonObject(frame.data);
      if (evt.error) {
        const e = typeof evt.error === 'object' && evt.error ? (evt.error as Record<string, unknown>) : {};
        throw new Error(`AI provider error. ${String(e.message ?? 'stream error')}`);
      }
      if (evt.usageMetadata) usage = geminiUsage(evt.usageMetadata) ?? usage;
      const candidates = Array.isArray(evt.candidates) ? (evt.candidates as Array<Record<string, unknown>>) : [];
      if (candidates[0]?.finishReason != null) finishReason = candidates[0].finishReason;
      const content = candidates[0]?.content && typeof candidates[0].content === 'object' ? (candidates[0].content as Record<string, unknown>) : {};
      const parts = Array.isArray(content.parts) ? (content.parts as Array<Record<string, unknown>>) : [];
      for (const part of parts) {
        if (part.thought === true) continue; // reasoning part — never streamed as the answer
        if (typeof part.text === 'string' && part.text) {
          text += part.text;
          await onToken(part.text);
        }
        const fc = part.functionCall && typeof part.functionCall === 'object' ? (part.functionCall as Record<string, unknown>) : null;
        if (fc && typeof fc.name === 'string' && isKnownChatTool(fc.name)) {
          toolCalls.push({ id: `gem_${toolCalls.length}`, name: fc.name, args: toolArgsString(fc.args) });
        }
      }
    }
    // G1.2 — a SAFETY/RECITATION/OTHER block with no usable output is an error, not an
    // empty answer (parseResponse already throws on empty candidates; mirror it here).
    const reason = typeof finishReason === 'string' ? finishReason.toUpperCase() : '';
    if (!text && toolCalls.length === 0 && (reason === 'SAFETY' || reason === 'RECITATION' || reason === 'OTHER' || reason === 'BLOCKLIST' || reason === 'PROHIBITED_CONTENT')) {
      throw new Error(`AI provider blocked the response (${reason}).`);
    }
    return { text, toolCalls, ...normalizeFinish(finishReason), ...(usage ? { usage } : {}) };
  },
  pushAssistant(contents, outcome) {
    const parts: Array<Record<string, unknown>> = [];
    if (outcome.text.trim()) parts.push({ text: outcome.text });
    for (const t of outcome.toolCalls) parts.push({ functionCall: { name: t.name, args: safeParseJsonObject(t.args) } });
    (contents as unknown[]).push({ role: 'model', parts });
  },
  pushToolResults(contents, results) {
    (contents as unknown[]).push({
      role: 'user',
      parts: results.map((r) => ({
        functionResponse: {
          name: r.call.name,
          response: r.data !== undefined && r.data !== null && typeof r.data === 'object' ? (r.data as Record<string, unknown>) : { result: r.content },
        },
      })),
    });
  },
};

export function chatTransportAdapter(transport: ChatAiTransport): ChatTransportAdapter {
  if (transport === 'anthropic-messages') return anthropicAdapter;
  if (transport === 'gemini-native') return geminiAdapter;
  return openAiAdapter; // openai-compatible / openai-responses
}

export type { ChatHistoryMessage, ChatToolCall, ChatToolResultItem, ChatTransportAdapter, ChatTurnOutcome };
