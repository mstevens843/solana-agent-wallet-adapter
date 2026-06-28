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

  it('exposes the BirdEye wallet/token-intelligence tools with distinct status labels', () => {
    for (const name of ['get_wallet_portfolio', 'get_wallet_pnl', 'get_wallet_origin', 'get_token_top_traders', 'get_token_supply_changes']) {
      expect(CHAT_TOOL_NAMES.has(name)).toBe(true);
      expect(toolNames.has(name)).toBe(true);
    }
    // Wallet tools take an OPTIONAL wallet (any wallet, or the connected one) — never required.
    const pnl = tools.find((t) => t.name === 'get_wallet_pnl');
    expect((pnl?.input_schema as { required?: string[] }).required ?? []).not.toContain('wallet');
    // Token tools require a mint.
    const traders = tools.find((t) => t.name === 'get_token_top_traders');
    expect((traders?.input_schema as { required?: string[] }).required).toContain('mint');
    expect(chatToolStatusLabel('get_wallet_portfolio', {})).toContain('net worth');
    expect(chatToolStatusLabel('get_wallet_pnl', {})).toContain('PnL');
    expect(chatToolStatusLabel('get_token_top_traders', { mint: 'SOL' })).toContain('traders');
  });

  it('exposes the Round-2 activity/pair/alpha/net-worth-history tools with status labels', () => {
    for (const name of ['get_token_activity', 'get_pair_overview', 'get_smart_money_tokens', 'get_gainers_losers', 'get_wallet_net_worth_history']) {
      expect(CHAT_TOOL_NAMES.has(name)).toBe(true);
      expect(toolNames.has(name)).toBe(true);
    }
    // pair overview requires a pair `address`; token activity requires a `mint`.
    const pair = tools.find((t) => t.name === 'get_pair_overview');
    expect((pair?.input_schema as { required?: string[] }).required).toContain('address');
    const activity = tools.find((t) => t.name === 'get_token_activity');
    expect((activity?.input_schema as { required?: string[] }).required).toContain('mint');
    // net-worth history takes an OPTIONAL wallet (any wallet, or the connected one).
    const nwh = tools.find((t) => t.name === 'get_wallet_net_worth_history');
    expect((nwh?.input_schema as { required?: string[] }).required ?? []).not.toContain('wallet');
    expect(chatToolStatusLabel('get_token_activity', { mint: 'SOL' })).toContain('activity');
    expect(chatToolStatusLabel('get_smart_money_tokens', {})).toContain('smart-money');
    expect(chatToolStatusLabel('get_gainers_losers', {})).toContain('traders');
  });

  it('exposes the Round-3 network/transaction tools with status labels', () => {
    for (const name of ['get_priority_fee', 'get_transaction']) {
      expect(CHAT_TOOL_NAMES.has(name)).toBe(true);
      expect(toolNames.has(name)).toBe(true);
    }
    const pf = tools.find((t) => t.name === 'get_priority_fee');
    expect((pf?.input_schema as { required?: string[] }).required ?? []).toHaveLength(0);
    const tx = tools.find((t) => t.name === 'get_transaction');
    expect((tx?.input_schema as { required?: string[] }).required).toContain('signature');
    expect(chatToolStatusLabel('get_priority_fee', {})).toContain('priority fee');
    expect(chatToolStatusLabel('get_transaction', { signature: 'abc' })).toContain('transaction');
  });

  it('exposes the Round-4 token-holders + coin-categories tools with status labels', () => {
    for (const name of ['get_token_holders', 'get_coin_categories']) {
      expect(CHAT_TOOL_NAMES.has(name)).toBe(true);
      expect(toolNames.has(name)).toBe(true);
    }
    const holders = tools.find((t) => t.name === 'get_token_holders');
    expect((holders?.input_schema as { required?: string[] }).required).toContain('mint');
    const cats = tools.find((t) => t.name === 'get_coin_categories');
    expect((cats?.input_schema as { required?: string[] }).required ?? []).toHaveLength(0);
    expect(chatToolStatusLabel('get_token_holders', { mint: 'SOL' })).toContain('holders');
    expect(chatToolStatusLabel('get_coin_categories', {})).toContain('sector');
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
