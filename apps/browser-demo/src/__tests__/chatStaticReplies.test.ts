import { describe, expect, it } from 'vitest';

import {
  CHAT_HELP_REPLY_LINES,
  chatStaticReplyForPrompt,
} from '../chatStaticReplies.js';

describe('chat static replies', () => {
  it('matches the help suggestion exactly', () => {
    expect(chatStaticReplyForPrompt('What can you help me do?')).toEqual(CHAT_HELP_REPLY_LINES);
  });

  it('matches case, whitespace, and trailing punctuation variants', () => {
    expect(chatStaticReplyForPrompt('  what   CAN you help me do!!!  ')).toEqual(CHAT_HELP_REPLY_LINES);
    expect(chatStaticReplyForPrompt('What can you help me do')).toEqual(CHAT_HELP_REPLY_LINES);
  });

  it('does not match the live-data suggested prompts', () => {
    expect(chatStaticReplyForPrompt("What's my SOL balance worth right now?")).toBeNull();
    expect(chatStaticReplyForPrompt('Is BONK a safe token to hold?')).toBeNull();
    expect(chatStaticReplyForPrompt('Quote swapping 0.1 SOL to USDC')).toBeNull();
  });
});
