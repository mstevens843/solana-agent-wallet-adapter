import LZString from 'lz-string';
import { describe, expect, it } from 'vitest';

import {
  CHAT_LZ_BASE64_PREFIX,
  CHAT_LZ_PREFIX,
  chatSessionIsCloudStub,
  compressChatMessages,
  decideCloudChatMeta,
  decompressChatMessages,
  mergeChatMessagesById,
  stubMessageCount,
} from '../chatCloudSync.js';

describe('chat cloud sync helpers', () => {
  describe('compress/decompress round-trip', () => {
    const messages = [
      { id: 'm1', role: 'user', content: 'hi', createdAt: '2026-06-22T00:00:00.000Z', status: 'done' },
      { id: 'm2', role: 'assistant', content: 'your balance is 0.089 SOL', createdAt: '2026-06-22T00:00:01.000Z', status: 'done' },
    ];

    it('compresses to the base64 cloud scheme (LZ64:) and round-trips', () => {
      const blob = compressChatMessages(messages);
      expect(blob.startsWith(CHAT_LZ_BASE64_PREFIX)).toBe(true);
      // base64 body is plain ASCII (no JSON-escaping / multi-byte UTF-8 bloat).
      expect(/^[A-Za-z0-9+/=]*$/.test(blob.slice(CHAT_LZ_BASE64_PREFIX.length))).toBe(true);
      expect(decompressChatMessages(blob)).toEqual(messages);
    });

    it('still decodes a legacy UTF-16 (LZ1:) cloud blob for back-compat', () => {
      const legacy = CHAT_LZ_PREFIX + LZString.compressToUTF16(JSON.stringify(messages));
      expect(decompressChatMessages(legacy)).toEqual(messages);
    });

    it('round-trips an empty array', () => {
      expect(decompressChatMessages(compressChatMessages([]))).toEqual([]);
    });

    it('returns [] for garbage / non-array / empty input', () => {
      expect(decompressChatMessages('not-a-blob')).toEqual([]);
      expect(decompressChatMessages('')).toEqual([]);
      expect(decompressChatMessages(`${CHAT_LZ_BASE64_PREFIX}@@@corrupt@@@`)).toEqual([]);
      expect(decompressChatMessages(`${CHAT_LZ_PREFIX}@@@corrupt@@@`)).toEqual([]);
      // A valid prefix with an empty body decodes to nothing.
      expect(decompressChatMessages(`${CHAT_LZ_BASE64_PREFIX}`)).toEqual([]);
    });
  });

  describe('chatSessionIsCloudStub', () => {
    it('is a stub when cloud count is positive and no messages are loaded', () => {
      expect(chatSessionIsCloudStub({ messages: [], cloudMessageCount: 3 })).toBe(true);
    });
    it('is not a stub once messages are loaded', () => {
      expect(chatSessionIsCloudStub({ messages: [{}], cloudMessageCount: 3 })).toBe(false);
    });
    it('is not a stub for a fresh local empty session (no cloud count)', () => {
      expect(chatSessionIsCloudStub({ messages: [] })).toBe(false);
      expect(chatSessionIsCloudStub({ messages: [], cloudMessageCount: 0 })).toBe(false);
    });
  });

  describe('decideCloudChatMeta (last-writer-wins by updatedAt)', () => {
    it('creates a stub when there is no local copy', () => {
      expect(decideCloudChatMeta(undefined, { updatedAt: '2026-06-22T00:00:00.000Z' })).toBe('create-stub');
    });
    it('re-stubs when the cloud copy is strictly newer', () => {
      const local = { updatedAt: '2026-06-22T00:00:00.000Z', messages: [{}] };
      expect(decideCloudChatMeta(local, { updatedAt: '2026-06-22T01:00:00.000Z' })).toBe('restub');
    });
    it('marks an empty local session (reloaded stub) as a stub', () => {
      const local = { updatedAt: '2026-06-22T05:00:00.000Z', messages: [] };
      expect(decideCloudChatMeta(local, { updatedAt: '2026-06-22T01:00:00.000Z' })).toBe('mark-stub');
    });
    it('keeps a local session that has content and is newer/equal', () => {
      const local = { updatedAt: '2026-06-22T05:00:00.000Z', messages: [{}] };
      expect(decideCloudChatMeta(local, { updatedAt: '2026-06-22T05:00:00.000Z' })).toBe('keep');
      expect(decideCloudChatMeta(local, { updatedAt: '2026-06-22T01:00:00.000Z' })).toBe('keep');
    });
    it('keeps local content when the cloud copy is newer only within the skew window', () => {
      const local = { updatedAt: '2026-06-22T05:00:00.000Z', messages: [{}] };
      // +30s newer (< 60s skew) → near-simultaneous edit, prefer local content.
      expect(decideCloudChatMeta(local, { updatedAt: '2026-06-22T05:00:30.000Z' })).toBe('keep');
      // +90s newer (> 60s skew) → genuinely newer → restub.
      expect(decideCloudChatMeta(local, { updatedAt: '2026-06-22T05:01:30.000Z' })).toBe('restub');
    });
  });

  describe('mergeChatMessagesById', () => {
    const s = (id: string, createdAt: string, content = id) => ({ id, createdAt, content });
    it('unions both arrays by id, ordered by createdAt', () => {
      const server = [s('a', '2026-06-22T00:00:00.000Z'), s('b', '2026-06-22T00:00:02.000Z')];
      const local = [s('a', '2026-06-22T00:00:00.000Z'), s('c', '2026-06-22T00:00:01.000Z')];
      const merged = mergeChatMessagesById(server, local);
      expect(merged.map((m) => m.id)).toEqual(['a', 'c', 'b']);
    });
    it('lets the local copy win on an id collision (passed last)', () => {
      const server = [s('a', '2026-06-22T00:00:00.000Z', 'server')];
      const local = [s('a', '2026-06-22T00:00:00.000Z', 'local')];
      expect(mergeChatMessagesById(server, local)[0]?.content).toBe('local');
    });
    it('drops entries without a usable id', () => {
      const merged = mergeChatMessagesById(
        [{ id: '', createdAt: 'x' } as { id: string; createdAt: string }],
        [s('a', '2026-06-22T00:00:00.000Z')],
      );
      expect(merged.map((m) => m.id)).toEqual(['a']);
    });
  });

  describe('stubMessageCount', () => {
    it('normalizes to a positive marker', () => {
      expect(stubMessageCount(5)).toBe(5);
      expect(stubMessageCount(0)).toBe(1);
      expect(stubMessageCount(undefined)).toBe(1);
    });
  });
});
