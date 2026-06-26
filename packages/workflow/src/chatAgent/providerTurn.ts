// Per-transport adapters: build the request body, parse the streamed response into
// { text, toolCalls }, and format the assistant echo + batched tool results. These
// own ALL provider-format differences so the loop stays generic. Generalized from
// the server's runAnthropicChatLoop / runOpenAiChatLoop, plus a new Gemini turn.

import { iterateProviderSse, safeParseJsonObject } from './sse.js';
import { CHAT_TOOL_MAX_TOKENS, CHAT_TOOL_NAMES, chatAnthropicWebSearchTool, chatToolsAnthropic, chatToolsGemini, chatToolsOpenAi } from './tools.js';
import type {
  ChatAiTransport,
  ChatHistoryMessage,
  ChatToolCall,
  ChatToolResultItem,
  ChatTransportAdapter,
  ChatTurnOutcome,
} from './types.js';

const PROPOSE_TOOL = 'propose_wallet_action';
function isKnownChatTool(name: string): boolean {
  return CHAT_TOOL_NAMES.has(name) || name === PROPOSE_TOOL;
}

// Reasoning models reject a non-default temperature; omit it for those.
function isDefaultTemperatureOnlyModel(model: string): boolean {
  return /(^|[/:-])(o1|o3|o4|gpt-5)/i.test(model.trim());
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
  buildBody: (system, messages, model, toolSpecs, streaming = true) => ({
    model,
    max_tokens: CHAT_TOOL_MAX_TOKENS,
    system,
    messages,
    temperature: 0.3,
    tools: toolSpecs,
    tool_choice: { type: 'auto' },
    stream: streaming,
  }),
  parseResponse(json) {
    // Non-streamed /messages: { content: [{type:'text',text}|{type:'tool_use',id,name,input}] }
    const blocks = Array.isArray(json.content) ? (json.content as Array<Record<string, unknown>>) : [];
    let text = '';
    const toolCalls: ChatToolCall[] = [];
    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string') text += block.text;
      else if (block.type === 'tool_use' && typeof block.name === 'string' && isKnownChatTool(block.name)) {
        toolCalls.push({ id: String(block.id ?? ''), name: block.name, args: JSON.stringify(block.input ?? {}) });
      }
    }
    return { text, toolCalls };
  },
  async parseStream(res, onToken) {
    const blocks: Array<AnthropicBlock | undefined> = [];
    let text = '';
    for await (const frame of iterateProviderSse(res)) {
      const evt = safeParseJsonObject(frame.data);
      const type = frame.event || String(evt.type ?? '');
      if (type === 'error') {
        const err = evt.error && typeof evt.error === 'object' ? (evt.error as Record<string, unknown>) : {};
        throw new Error(`AI provider error. ${String(err.message ?? 'stream error')}`);
      }
      if (type === 'content_block_start') {
        const cb = evt.content_block && typeof evt.content_block === 'object' ? (evt.content_block as Record<string, unknown>) : {};
        const index = Number(evt.index ?? 0);
        if (cb.type === 'text') blocks[index] = { type: 'text', text: '' };
        else if (cb.type === 'tool_use') blocks[index] = { type: 'tool_use', id: String(cb.id ?? ''), name: String(cb.name ?? ''), inputJson: '' };
      } else if (type === 'content_block_delta') {
        const delta = evt.delta && typeof evt.delta === 'object' ? (evt.delta as Record<string, unknown>) : {};
        const block = blocks[Number(evt.index ?? 0)];
        if (delta.type === 'text_delta' && block?.type === 'text') {
          const piece = String(delta.text ?? '');
          block.text += piece;
          text += piece;
          if (piece) onToken(piece);
        } else if (delta.type === 'input_json_delta' && block?.type === 'tool_use') {
          block.inputJson += String(delta.partial_json ?? '');
        }
      }
    }
    const toolCalls: ChatToolCall[] = blocks
      .filter((b): b is AnthropicBlock & { type: 'tool_use' } => Boolean(b) && b!.type === 'tool_use' && isKnownChatTool(b!.name))
      .map((b) => ({ id: b.id, name: b.name, args: b.inputJson }));
    return { text, toolCalls };
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
  buildBody: (system, messages, model, toolSpecs, streaming = true) => ({
    model,
    messages: [{ role: 'system', content: system }, ...messages],
    tools: toolSpecs,
    tool_choice: 'auto',
    stream: streaming,
    ...(isDefaultTemperatureOnlyModel(model) ? {} : { temperature: 0.3 }),
  }),
  parseResponse(json) {
    // Non-streamed /chat/completions: { choices:[{ message:{ content, tool_calls:[{id,function:{name,arguments}}] } }] }
    const choices = Array.isArray(json.choices) ? (json.choices as Array<Record<string, unknown>>) : [];
    const message = choices[0]?.message && typeof choices[0].message === 'object' ? (choices[0].message as Record<string, unknown>) : {};
    const text = typeof message.content === 'string' ? message.content : '';
    const rawCalls = Array.isArray(message.tool_calls) ? (message.tool_calls as Array<Record<string, unknown>>) : [];
    const toolCalls: ChatToolCall[] = rawCalls
      .map((raw): ChatToolCall => {
        const fn = raw.function && typeof raw.function === 'object' ? (raw.function as Record<string, unknown>) : {};
        return { id: String(raw.id ?? ''), name: String(fn.name ?? ''), args: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}) };
      })
      .filter((call) => Boolean(call.name));
    return { text, toolCalls };
  },
  async parseStream(res, onToken) {
    let text = '';
    const acc: Array<{ id: string; name: string; args: string } | undefined> = [];
    for await (const frame of iterateProviderSse(res)) {
      if (frame.data === '[DONE]') break;
      const evt = safeParseJsonObject(frame.data);
      const choices = Array.isArray(evt.choices) ? (evt.choices as Array<Record<string, unknown>>) : [];
      const delta = choices[0]?.delta && typeof choices[0].delta === 'object' ? (choices[0].delta as Record<string, unknown>) : {};
      if (typeof delta.content === 'string' && delta.content) {
        text += delta.content;
        onToken(delta.content);
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
    const toolCalls: ChatToolCall[] = acc.filter((t): t is { id: string; name: string; args: string } => Boolean(t && t.name));
    return { text, toolCalls };
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
  // body is identical for streaming and non-streaming — `streaming` is ignored.
  buildBody: (system, contents, _model, toolSpecs) => ({
    systemInstruction: { parts: [{ text: system }] },
    contents,
    tools: toolSpecs,
    toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    generationConfig: { temperature: 0.3, maxOutputTokens: CHAT_TOOL_MAX_TOKENS },
  }),
  parseResponse(json) {
    // Non-streamed :generateContent: { candidates:[{ content:{ parts:[{text}|{functionCall:{name,args}}] } }] }
    const candidates = Array.isArray(json.candidates) ? (json.candidates as Array<Record<string, unknown>>) : [];
    const content = candidates[0]?.content && typeof candidates[0].content === 'object' ? (candidates[0].content as Record<string, unknown>) : {};
    const parts = Array.isArray(content.parts) ? (content.parts as Array<Record<string, unknown>>) : [];
    let text = '';
    const toolCalls: ChatToolCall[] = [];
    for (const part of parts) {
      if (typeof part.text === 'string') text += part.text;
      const fc = part.functionCall && typeof part.functionCall === 'object' ? (part.functionCall as Record<string, unknown>) : null;
      if (fc && typeof fc.name === 'string' && isKnownChatTool(fc.name)) {
        toolCalls.push({ id: `gem_${toolCalls.length}`, name: fc.name, args: JSON.stringify(fc.args ?? {}) });
      }
    }
    return { text, toolCalls };
  },
  async parseStream(res, onToken) {
    let text = '';
    const toolCalls: ChatToolCall[] = [];
    for await (const frame of iterateProviderSse(res)) {
      const evt = safeParseJsonObject(frame.data);
      const candidates = Array.isArray(evt.candidates) ? (evt.candidates as Array<Record<string, unknown>>) : [];
      const content = candidates[0]?.content && typeof candidates[0].content === 'object' ? (candidates[0].content as Record<string, unknown>) : {};
      const parts = Array.isArray(content.parts) ? (content.parts as Array<Record<string, unknown>>) : [];
      for (const part of parts) {
        if (typeof part.text === 'string' && part.text) {
          text += part.text;
          onToken(part.text);
        }
        const fc = part.functionCall && typeof part.functionCall === 'object' ? (part.functionCall as Record<string, unknown>) : null;
        if (fc && typeof fc.name === 'string' && isKnownChatTool(fc.name)) {
          toolCalls.push({ id: `gem_${toolCalls.length}`, name: fc.name, args: JSON.stringify(fc.args ?? {}) });
        }
      }
    }
    return { text, toolCalls };
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
