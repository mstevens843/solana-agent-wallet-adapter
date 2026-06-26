// Provider SSE parsing — shared by every streaming transport. Pure Web APIs
// (fetch Response, TextDecoder), so it runs in Node 18+ and the browser alike.

export function safeParseJsonObject(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// Parse one `\n\n`-delimited SSE frame into {event?, data}. Handles Anthropic
// (named `event:` lines) and OpenAI (`data:` only). Returns null if the frame
// carries no `data:` line (comments/heartbeats/blank frames).
export function parseSseFrame(frame: string): { event?: string; data: string } | null {
  let eventName: string | undefined;
  const dataLines: string[] = [];
  for (const rawLine of frame.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith('event:')) eventName = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (dataLines.length === 0) return null;
  return { event: eventName, data: dataLines.join('\n') };
}

// Hard ceiling on the unparsed SSE buffer. A well-behaved provider delimits frames
// with a blank line; if we never see one, this stops an unbounded-frame stream from
// growing memory without limit.
const MAX_SSE_BUFFER_BYTES = 8 * 1024 * 1024;

// Parse a provider SSE body into discrete events. Yields one event per
// blank-line-delimited frame, then flushes any trailing frame the provider did not
// terminate with a blank line. Stops early when `signal` aborts.
export async function* iterateProviderSse(response: Response, signal?: AbortSignal): AsyncGenerator<{ event?: string; data: string }> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sepMatch = /\r?\n\r?\n/.exec(buffer);
      while (sepMatch?.index !== undefined) {
        const parsed = parseSseFrame(buffer.slice(0, sepMatch.index));
        buffer = buffer.slice(sepMatch.index + sepMatch[0].length);
        if (parsed) yield parsed;
        if (signal?.aborted) return;
        sepMatch = /\r?\n\r?\n/.exec(buffer);
      }
      if (buffer.length > MAX_SSE_BUFFER_BYTES) throw new Error('AI provider stream exceeded the maximum frame size.');
    }
    // Flush any bytes the decoder buffered for an incomplete multibyte sequence at
    // the very end of the stream, then parse the trailing (unterminated) frame.
    buffer += decoder.decode();
    const tail = parseSseFrame(buffer);
    if (tail) yield tail;
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message));
}
