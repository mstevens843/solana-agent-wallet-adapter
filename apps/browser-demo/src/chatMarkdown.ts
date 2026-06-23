// Minimal, XSS-safe markdown for settled assistant replies in the Chat tab.
// Everything is HTML-escaped FIRST, then a fixed allowlist (bold, inline code,
// bullet/numbered lists, http(s) links) is layered on — no raw HTML from the
// model is ever rendered. Self-contained (own escapeHtml) so it stays testable
// without importing the main SPA module.

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderChatMarkdown(text: string): string {
  const inline = (s: string): string => escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    // URL char-class excludes quotes/angle brackets too (defence-in-depth — escapeHtml
    // already neutralizes them, but this keeps a stray entity tail out of the href).
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)"'<>]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  const out: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  const closeList = (): void => { if (listType) { out.push(`</${listType}>`); listType = null; } };
  for (const line of (text ?? '').split('\n')) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (bullet) {
      if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
      out.push(`<li>${inline(bullet[1] ?? '')}</li>`);
    } else if (numbered) {
      if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
      out.push(`<li>${inline(numbered[1] ?? '')}</li>`);
    } else if (line.trim() === '') {
      closeList();
    } else {
      closeList();
      out.push(`<div>${inline(line)}</div>`);
    }
  }
  closeList();
  return out.join('');
}
