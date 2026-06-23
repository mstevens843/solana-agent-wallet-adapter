// HIDE_CHAT_TAB flag. A build-time, comma-separated list of app surface types
// (`web,android,ios,desktop`) baked into the shared bundle; each running app
// checks its runtime-detected surface against the list. When a surface is listed,
// the Chat tab is hidden and that surface's tab layout reverts to the pre-Chat
// arrangement. Empty/unset → Chat shown everywhere (e.g. local dev).

export type AppSurfaceType = 'web' | 'android' | 'ios' | 'desktop';

export function parseHideChatTab(raw: string | undefined): Set<string> {
  return new Set(
    String(raw ?? '')
      .toLowerCase()
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function isChatTabHiddenForSurface(raw: string | undefined, surface: AppSurfaceType): boolean {
  const set = parseHideChatTab(raw);
  if (!set.size) return false;
  if (set.has(surface)) return true;
  // Convenience alias: `mobile` covers both native phone shells.
  return set.has('mobile') && (surface === 'android' || surface === 'ios');
}
