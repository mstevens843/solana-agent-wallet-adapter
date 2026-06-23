// Pure helpers for chat-history cloud sync. Kept out of main.ts so the
// compression round-trip, the metadata-stub predicate, and the local↔cloud merge
// decision can be unit-tested in isolation (main.ts owns the ChatSession types and
// the IO/render wiring around these).
import LZString from 'lz-string';

// Cloud per-session blob. The server stores this opaque string and never
// decompresses it. Compression scheme is chosen for the storage target:
//  - Cloud (LZ64:) = compressToBase64 — ASCII, 1 byte/char, no JSON escaping, so
//    it's ~40-50% smaller than UTF-16 once JSON-serialized into the UTF-8 HTTP
//    body and stored in the Postgres TEXT (UTF-8) column. (compressToUTF16 emits
//    many ≥U+0800 chars that cost 3 UTF-8 bytes each.)
//  - localStorage uses LZ1:+compressToUTF16 instead (optimal for the UTF-16
//    string store) — that lives in main.ts (serializeChatHistory), not here.
export const CHAT_LZ_BASE64_PREFIX = 'LZ64:';
// Legacy UTF-16 cloud prefix, still decoded for back-compat (older cloud blobs).
export const CHAT_LZ_PREFIX = 'LZ1:';

export function compressChatMessages(messages: unknown[]): string {
  return CHAT_LZ_BASE64_PREFIX + LZString.compressToBase64(JSON.stringify(messages));
}

// Returns the raw decoded array (callers normalize entries into ChatMessage).
// Detects the scheme by prefix; bad/garbage input degrades to [] so a corrupt
// cloud blob can't throw.
export function decompressChatMessages(blob: string): unknown[] {
  try {
    const json = blob.startsWith(CHAT_LZ_BASE64_PREFIX)
      ? LZString.decompressFromBase64(blob.slice(CHAT_LZ_BASE64_PREFIX.length))
      : blob.startsWith(CHAT_LZ_PREFIX)
        ? LZString.decompressFromUTF16(blob.slice(CHAT_LZ_PREFIX.length))
        : blob;
    if (!json) return [];
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export interface CloudStubbableSession {
  messages: unknown[];
  cloudMessageCount?: number;
}

// A session whose messages live in the cloud but haven't been fetched yet:
// positive server message count + no loaded messages. Derived (not a Set) so it
// survives a page reload where the stub was restored from localStorage.
export function chatSessionIsCloudStub(session: CloudStubbableSession): boolean {
  return (session.cloudMessageCount ?? 0) > 0 && session.messages.length === 0;
}

export type CloudChatMetaAction =
  | 'create-stub' // no local copy → add a metadata stub
  | 'restub'      // cloud is strictly newer → drop local messages, re-stub
  | 'mark-stub'   // local exists but has no loaded messages → keep as stub
  | 'keep';       // local has content and is newer/equal → keep (push up later)

// Decide how one cloud session-metadata row reconciles with the local copy.
// Last-writer-wins by updatedAt (ISO strings compare lexicographically).
export function decideCloudChatMeta(
  local: { updatedAt: string; messages: unknown[] } | undefined,
  meta: { updatedAt: string },
): CloudChatMetaAction {
  if (!local) return 'create-stub';
  if ((meta.updatedAt || '') > local.updatedAt) return 'restub';
  if (local.messages.length === 0) return 'mark-stub';
  return 'keep';
}

// Normalize a server-reported message count to a positive stub marker (so a stub
// is always recognized by chatSessionIsCloudStub even if the count is missing).
export function stubMessageCount(messageCount: number | undefined): number {
  return Math.max(1, messageCount ?? 1);
}
