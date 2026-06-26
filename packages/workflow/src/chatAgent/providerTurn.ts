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
// Anthropic extended-thinking budget for medium/high; undefined = no thinking.
function anthropicThinkingBudget(level?: ChatReasoningLevel): number | undefined {
  if (level === 'medium') return 2048;
  if (level === 'high') return 6144;
  return undefined;
}
// Gemini 2.5 thinkingBudget; only for 2.5 (thinking) models. 128 floor is safe for
// Flash + Pro; -1 = dynamic (medium). undefined = leave the model default.
function geminiThinkingBudget(model: string, level?: ChatReasoningLevel): number | undefined {
  if (!level || !/(gemini-)?2\.?5|2\.0-flash-thinking/i.test(model)) return undefined;
  switch (level) {
    case 'minimal': return 128;
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
  | { type: 'tool_use'; id: string; name: string; inputJson: string };

const anthropicAdapter: ChatTransportAdapter = {
  transport: 'anthropic-messages',
  // Our function tools + Anthropic's native web_search (server tool). Anthropic
  // executes web_search inline; parseStream/parseResponse ignore its server_tool_use
  // / web_search_tool_result blocks and only surface our function tool_use + the text.
  toolSpecs: () => [...chatToolsAnthropic(), chatAnthropicWebSearchTool()],
  initialMessages: (history) => history.map((m) => ({ role: m.role, content: m.content })),
  buildBody: (system, messages, model, toolSpecs, opts) => {
    const o = normalizeBuildOpts(opts);
    // Extended thinking (medium/high reasoning depth): Anthropic streams `thinking`
    // blocks (our parser already ignores them), REQUIRES temperature unset, and needs
    // max_tokens > the thinking budget.
    const thinkBudget = anthropicThinkingBudget(o.reasoningEffort);
    const maxTokens = thinkBudget ? Math.max(CHAT_ANTHROPIC_MAX_TOKENS, thinkBudget + 2048) : CHAT_ANTHROPIC_MAX_TOKENS;
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
      ...(thinkBudget
        ? { thinking: { type: 'enabled', budget_tokens: thinkBudget } }
        : { temperature: 0.3 }),
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
    for (const block of blocks) {
      // 'text' / our 'tool_use' are surfaced; web_search_tool_result blocks yield
      // citations; Anthropic's server_tool_use block is otherwise ignored.
      if (block.type === 'text' && typeof block.text === 'string') text += block.text;
      else if (block.type === 'tool_use' && typeof block.name === 'string' && isKnownChatTool(block.name)) {
        toolCalls.push({ id: String(block.id ?? ''), name: block.name, args: toolArgsString(block.input) });
      } else citations.push(...anthropicCitations(block));
    }
    const usage = anthropicResponseUsage(json.usage);
    return { text, toolCalls, ...normalizeFinish(json.stop_reason), ...(usage ? { usage } : {}), ...(citations.length ? { citations } : {}) };
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
    const usage = usageOrUndefined(inTok, outTok, cacheRead, cacheWrite);
    return { text, toolCalls, ...normalizeFinish(stopReason), ...(usage ? { usage } : {}), ...(citations.length ? { citations } : {}) };
  },
  pushAssistant(messages, outcome) {
    // Reconstruct the assistant turn (one text block + the tool_use blocks). Drop an
    // empty text block — Anthropic rejects empty text content on the echo.
    const content: Array<Record<string, unknown>> = [];
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
    // (need `max_completion_tokens`); standard models use `max_tokens`. reasoning_effort
    // maps the user's chosen depth onto o-series/gpt-5.
    const reasoning = isDefaultTemperatureOnlyModel(model);
    const effort = openAiReasoningEffort(model, o.reasoningEffort);
    return {
      model,
      messages: [{ role: 'system', content: system }, ...messages],
      [reasoning ? 'max_completion_tokens' : 'max_tokens']: CHAT_TOOL_MAX_TOKENS,
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
      if (frame.data === '[DONE]') break;
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
  buildBody: (system, contents, model, toolSpecs, opts) => ({
    systemInstruction: { parts: [{ text: system }] },
    contents,
    tools: toolSpecs,
    toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: CHAT_TOOL_MAX_TOKENS,
      // Gemini 2.5 ships thinking ON by default (latency + token cost every turn). Map
      // the user's reasoning depth onto a budget (only for 2.5 thinking models; others
      // keep their default). includeThoughts:false → thought parts stay out of the answer.
      ...((budget) => (budget !== undefined ? { thinkingConfig: { thinkingBudget: budget, includeThoughts: false } } : {}))(geminiThinkingBudget(model, normalizeBuildOpts(opts).reasoningEffort)),
    },
    // Crypto/wallet discussion (moving funds, risk, swaps) routinely trips Gemini's
    // default DANGEROUS_CONTENT filter → an empty/blocked candidate. Relax it for this
    // financial assistant; keep the others at the high threshold.
    safetySettings: [
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
    ],
  }),
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
