import { describe, expect, it } from 'vitest';

import {
  VulcanPolicyError,
  assertVulcanDangerousCallAllowed,
  describeVulcanTool,
  isDangerousTool,
  sanitizeVulcanToolName,
} from '../../upstreamMcp/vulcanPolicy.js';
import type { AgentWalletConfig } from '../../config.js';

const enabledConfig = (overrides: Record<string, unknown> = {}): AgentWalletConfig =>
  ({
    cluster: 'mainnet-beta',
    connectors: {
      phoenix: {
        perps: { enabled: true, paperModeOnly: false, ...overrides },
      },
    },
  } as AgentWalletConfig);

describe('isDangerousTool', () => {
  it('returns true when the schema requires acknowledged', () => {
    expect(
      isDangerousTool({
        name: 'market.snapshot',
        inputSchema: { properties: { acknowledged: { type: 'boolean' } } },
      }),
    ).toBe(true);
  });

  it('returns true for write-verb names even without acknowledged', () => {
    expect(isDangerousTool({ name: 'trade.place_limit' })).toBe(true);
    expect(isDangerousTool({ name: 'position.close' })).toBe(false); // 'position' is in SAFE_PREFIXES
    expect(isDangerousTool({ name: 'order.cancel' })).toBe(true);
  });

  it('returns false for known read prefixes', () => {
    expect(isDangerousTool({ name: 'market.snapshot' })).toBe(false);
    expect(isDangerousTool({ name: 'position.list' })).toBe(false);
    expect(isDangerousTool({ name: 'portfolio.summary' })).toBe(false);
    expect(isDangerousTool({ name: 'history.trades' })).toBe(false);
  });
});

describe('sanitizeVulcanToolName', () => {
  it('namespaces and underscores Vulcan tool names', () => {
    expect(sanitizeVulcanToolName('market.snapshot')).toBe('solana_vulcan_market_snapshot');
    expect(sanitizeVulcanToolName('trade.place-limit')).toBe('solana_vulcan_trade_place_limit');
    expect(sanitizeVulcanToolName('strategy/grid_runner')).toBe('solana_vulcan_strategy_grid_runner');
  });

  it('collapses runs of separators and trims', () => {
    expect(sanitizeVulcanToolName('--foo--bar--')).toBe('solana_vulcan_foo_bar');
  });
});

describe('describeVulcanTool', () => {
  it('appends a dangerous note when flagged', () => {
    const description = describeVulcanTool({ name: 'trade.place_market', description: 'Places a market order.' }, true);
    expect(description).toMatch(/Places a market order\./);
    expect(description).toMatch(/prepared-action inbox/);
  });

  it('appends a read-only note when not flagged', () => {
    const description = describeVulcanTool({ name: 'market.snapshot' }, false);
    expect(description).toMatch(/Read-only proxy/);
  });
});

describe('assertVulcanDangerousCallAllowed', () => {
  it('rejects when policy.enabled is false', () => {
    expect(() =>
      assertVulcanDangerousCallAllowed({ cluster: 'mainnet-beta' } as AgentWalletConfig, { mode: 'paper' }),
    ).toThrow(VulcanPolicyError);
  });

  it('rejects when policy.readOnly is true', () => {
    expect(() =>
      assertVulcanDangerousCallAllowed(enabledConfig({ readOnly: true }), { mode: 'paper' }),
    ).toThrow(/read-only/);
  });

  it('rejects live mode when paperModeOnly is true', () => {
    expect(() =>
      assertVulcanDangerousCallAllowed(enabledConfig({ paperModeOnly: true }), { mode: 'live' }),
    ).toThrow(/paper-mode-only/);
  });

  it('rejects symbols outside the allowlist', () => {
    expect(() =>
      assertVulcanDangerousCallAllowed(enabledConfig({ allowedSymbols: ['SOL-PERP'] }), {
        mode: 'paper',
        symbol: 'BTC-PERP',
      }),
    ).toThrow(/not in the Phoenix policy allowlist/);
  });

  it('rejects over-leverage', () => {
    expect(() =>
      assertVulcanDangerousCallAllowed(enabledConfig({ maxLeverage: 5 }), {
        mode: 'paper',
        symbol: 'SOL-PERP',
        leverage: 10,
      }),
    ).toThrow(/exceeds Phoenix policy max/);
  });

  it('allows compliant calls', () => {
    expect(() =>
      assertVulcanDangerousCallAllowed(enabledConfig(), {
        mode: 'paper',
        symbol: 'SOL-PERP',
        leverage: 3,
      }),
    ).not.toThrow();
  });

  it('case-normalises symbols before checking the allowlist', () => {
    expect(() =>
      assertVulcanDangerousCallAllowed(enabledConfig({ allowedSymbols: ['SOL-PERP'] }), {
        mode: 'paper',
        symbol: 'sol-perp',
      }),
    ).not.toThrow();
  });
});
