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

// Parse a provider SSE body into discrete events. Yields one event per
// blank-line-delimited frame, then flushes any trailing frame the provider did not
// terminate with a blank line.
export async function* iterateProviderSse(response: Response): AsyncGenerator<{ event?: string; data: string }> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sepMatch = /\r?\n\r?\n/.exec(buffer);
      while (sepMatch?.index !== undefined) {
        const parsed = parseSseFrame(buffer.slice(0, sepMatch.index));
        buffer = buffer.slice(sepMatch.index + sepMatch[0].length);
        if (parsed) yield parsed;
        sepMatch = /\r?\n\r?\n/.exec(buffer);
      }
    }
    const tail = parseSseFrame(buffer);
    if (tail) yield tail;
  } finally {
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
