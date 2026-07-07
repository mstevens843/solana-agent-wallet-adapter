import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

// Source-scan tripwires for the permanent iOS Chat-tab jitter fix. This app package has no ESLint
// (root lint covers only packages/*), so these string checks are the CI fence that fails loudly the
// moment someone re-introduces exactly the anti-patterns we removed. They are intentionally
// brittle-by-design: if a legitimate refactor renames a helper, update the matching assertion here
// on purpose — do not just delete it.
//
// Each guard maps to a root cause (see plans / the site comments in main.ts):
//   RC1 — the --chat-keyboard-inset writer must stay idempotent, :root-targeted, and NOT fed by
//         visualViewport 'scroll'.
//   RC3 — there is exactly ONE deferred chat snap, and the full-render path delegates autoscroll to
//         the single shared helper instead of re-inlining a sync+rAF double-snap.

const source = readFileSync(new URL('../main.ts', import.meta.url), 'utf8');

/** Slice a top-level function body from its signature up to the next top-level `function ` decl. */
function sliceTopLevelFunction(signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`signature not found in main.ts: ${signature}`);
  const next = source.indexOf('\nfunction ', start + signature.length);
  return source.slice(start, next < 0 ? undefined : next);
}

describe('chat render invariants (iOS jitter fix)', () => {
  it('RC3: there is exactly ONE deferred chat snap in the whole file', () => {
    // Two rAF snaps under scroll-behavior:smooth was the historic thrash. All post-render snapping
    // funnels through applyChatAutoscrollAfterRender, which owns the single deferred snap.
    const occurrences = source.split('requestAnimationFrame(() => chatScrollToBottom(true))').length - 1;
    expect(occurrences).toBe(1);
  });

  it('RC3: the full-render path delegates autoscroll and never inlines a snap', () => {
    const body = sliceTopLevelFunction('function restoreChatComposerAfterRender(): void {');
    expect(body).toContain('applyChatAutoscrollAfterRender(');
    // No re-inlined scrollTop / double-snap in the full path — it must go through the shared helper.
    expect(body).not.toContain('chatScrollToBottom(');
  });

  it('RC1: the keyboard-inset writer keeps its idempotency guard and :root target', () => {
    const body = sliceTopLevelFunction('function applyChatKeyboardInset(): void {');
    expect(body).toContain('shouldWriteChatKeyboardInset(');
    expect(body).toContain('documentElement');
    // Must NOT write to the per-render .chat-surface node (idempotent-skip would leave a fresh node
    // without the var). The custom property inherits from :root instead.
    expect(body).not.toContain('.chat-surface');
  });

  it('RC1: the chat keyboard inset is not re-poked by visualViewport scroll', () => {
    expect(source).not.toContain("visualViewport?.addEventListener('scroll', syncChatKeyboardInset");
  });

  it('RC0: the chat keyboard inset suppresses the phantom iOS visual-viewport source', () => {
    // The actual root cause the prior fixes missed: on iOS the overlay keyboard never shrinks
    // innerHeight, so the visual-viewport delta is a PHANTOM inset. applyChatKeyboardInset must pass
    // suppressVisualViewportKeyboard: IS_IOS_APP so computeMobileRailViewportVars never promotes that
    // delta to a keyboard source. Dropping this revives the iOS Chat-tab up/down jitter loop.
    const body = sliceTopLevelFunction('function applyChatKeyboardInset(): void {');
    expect(body).toContain('suppressVisualViewportKeyboard: IS_IOS_APP');
  });
});
