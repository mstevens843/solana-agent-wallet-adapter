import { describe, expect, it } from 'vitest';

import { renderChatMarkdown } from '../chatMarkdown.js';

describe('renderChatMarkdown — XSS safety', () => {
  it('escapes script tags', () => {
    const html = renderChatMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes event-handler HTML', () => {
    const html = renderChatMarkdown('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('does not turn a javascript: link into an anchor', () => {
    const html = renderChatMarkdown('[click](javascript:alert(1))');
    expect(html).not.toContain('<a ');
    expect(html).toContain('javascript:alert(1)');
  });

  it('renders an http(s) link safely with rel/target', () => {
    const html = renderChatMarkdown('[ok](https://example.com/x)');
    expect(html).toContain('<a href="https://example.com/x" target="_blank" rel="noopener noreferrer">ok</a>');
  });

  it('neutralizes attribute-injection attempts in a link URL', () => {
    const html = renderChatMarkdown('[x](https://a.com" onmouseover="alert(1))');
    // The space breaks the URL match, so no anchor is produced and the quote is escaped.
    expect(html).not.toContain('<a ');
    expect(html).toContain('&quot;');
    expect(html).not.toContain('onmouseover="alert');
  });
});

describe('renderChatMarkdown — formatting', () => {
  it('renders bold and inline code', () => {
    expect(renderChatMarkdown('**hi**')).toContain('<strong>hi</strong>');
    expect(renderChatMarkdown('`x`')).toContain('<code>x</code>');
  });

  it('renders bullet lists', () => {
    expect(renderChatMarkdown('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
  });

  it('renders numbered lists', () => {
    expect(renderChatMarkdown('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>');
  });

  it('wraps plain lines in divs and skips blank lines', () => {
    expect(renderChatMarkdown('one\n\ntwo')).toBe('<div>one</div><div>two</div>');
  });
});
