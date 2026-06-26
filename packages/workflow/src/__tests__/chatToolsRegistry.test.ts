import { describe, expect, it } from 'vitest';

import { chatToolsAnthropic, chatToolStatusLabel, CHAT_TOOL_NAMES } from '../chatAgent/tools.js';

describe('chat tool registry', () => {
  const tools = chatToolsAnthropic();
  const toolNames = new Set(tools.map((t) => t.name as string));

  it('exposes the new Helius/CoinGecko/BirdEye read tools', () => {
    for (const name of ['get_wallet_nfts', 'get_asset', 'get_coin_market', 'get_trending_coins', 'get_new_listings']) {
      expect(CHAT_TOOL_NAMES.has(name)).toBe(true);
      expect(toolNames.has(name)).toBe(true);
    }
  });

  it('never advertises a read-tool name without a matching tool definition', () => {
    // Every gated read-tool name must have a real schema entry, else the loop advertises a
    // tool the executor will reject as "unknown" (the resolve_sol_domain trap we removed).
    for (const name of CHAT_TOOL_NAMES) {
      expect(toolNames.has(name), `missing tool def for ${name}`).toBe(true);
    }
  });

  it('every tool has a non-empty description and an object input schema', () => {
    for (const tool of tools) {
      expect(typeof tool.description === 'string' && (tool.description as string).length > 0).toBe(true);
      expect((tool.input_schema as Record<string, unknown>).type).toBe('object');
    }
  });

  it('gives each new tool a distinct status label', () => {
    expect(chatToolStatusLabel('get_wallet_nfts', {})).toContain('NFT');
    expect(chatToolStatusLabel('get_asset', {})).toContain('asset');
    expect(chatToolStatusLabel('get_coin_market', { query: 'SOL' })).toContain('SOL');
    expect(chatToolStatusLabel('get_trending_coins', {})).toContain('trending');
    expect(chatToolStatusLabel('get_new_listings', {})).toContain('listings');
  });
});
