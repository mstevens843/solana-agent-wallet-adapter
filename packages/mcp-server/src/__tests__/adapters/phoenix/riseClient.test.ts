import { Direction, StopLossOrderKind } from '@ellipsis-labs/rise';
import { afterEach, describe, expect, it } from 'vitest';

import {
  redactAccessCode,
  withPhoenixErrors,
} from '../../../adapters/phoenix/client.js';
import {
  buildRisePhoenixClient,
  feeToBps,
  hasRiseExtensions,
  normalizeFundingHistory,
  normalizeMarket,
  normalizeTraderState,
  RISE_ENUM_CONSTANTS,
  usdcToLamports,
  type RisePhoenixClient,
} from '../../../adapters/phoenix/riseClient.js';
import { PHOENIX_ACCESS_CODE_ENV } from '../../../adapters/phoenix/constants.js';
import { AdapterError } from '../../../adapters/types.js';

afterEach(() => {
  delete process.env[PHOENIX_ACCESS_CODE_ENV];
});

const VALID_ACCESS_CODE = 'phoenix_invite_test_xyz';
const VALID_AUTHORITY = 'Cda4ZQ6oPdW97zh39NHX1njzvSjmJqkx3jJB8FZw1iCu';

// ---- C1 regression: Direction enum pinned to Rise SDK --------------------------------------------------------------

describe('Rise enum constants — regression against Rise SDK exports', () => {
  it('DIRECTION_GREATER_THAN matches Rise Direction.GreaterThan exactly', () => {
    expect(RISE_ENUM_CONSTANTS.DIRECTION_GREATER_THAN).toBe(Direction.GreaterThan);
    expect(RISE_ENUM_CONSTANTS.DIRECTION_GREATER_THAN).toBe(0);
  });

  it('DIRECTION_LESS_THAN matches Rise Direction.LessThan exactly', () => {
    expect(RISE_ENUM_CONSTANTS.DIRECTION_LESS_THAN).toBe(Direction.LessThan);
    expect(RISE_ENUM_CONSTANTS.DIRECTION_LESS_THAN).toBe(1);
  });

  it('STOP_LOSS_IOC matches Rise StopLossOrderKind.IOC', () => {
    expect(RISE_ENUM_CONSTANTS.STOP_LOSS_IOC).toBe(StopLossOrderKind.IOC);
    expect(RISE_ENUM_CONSTANTS.STOP_LOSS_IOC).toBe(0);
  });

  it('STOP_LOSS_LIMIT matches Rise StopLossOrderKind.Limit', () => {
    expect(RISE_ENUM_CONSTANTS.STOP_LOSS_LIMIT).toBe(StopLossOrderKind.Limit);
    expect(RISE_ENUM_CONSTANTS.STOP_LOSS_LIMIT).toBe(1);
  });

  it('SIDE_BID = 0 and SIDE_ASK = 1 (Rise Side enum)', () => {
    expect(RISE_ENUM_CONSTANTS.SIDE_BID).toBe(0);
    expect(RISE_ENUM_CONSTANTS.SIDE_ASK).toBe(1);
  });
});

// ---- buildRisePhoenixClient factory ---------------------------------------------------------------------------------

describe('buildRisePhoenixClient', () => {
  it('throws AdapterError on empty accessCode', () => {
    expect(() => buildRisePhoenixClient({ accessCode: '' })).toThrow(AdapterError);
    expect(() => buildRisePhoenixClient({ accessCode: '   ' })).toThrow(/accessCode is required/);
  });

  it('returns a client with Rise extensions', () => {
    const client = buildRisePhoenixClient({ accessCode: VALID_ACCESS_CODE });
    expect(hasRiseExtensions(client)).toBe(true);
    client.dispose();
  });

  it('accepts optional apiUrl + rpcUrl', () => {
    const client = buildRisePhoenixClient({
      accessCode: VALID_ACCESS_CODE,
      apiUrl: 'https://example.test',
      rpcUrl: 'https://rpc.example.test',
    });
    expect(hasRiseExtensions(client)).toBe(true);
    client.dispose();
  });

  it('dispose() is idempotent', () => {
    const client = buildRisePhoenixClient({ accessCode: VALID_ACCESS_CODE });
    client.dispose();
    expect(() => client.dispose()).not.toThrow();
  });
});

// ---- hasRiseExtensions ---------------------------------------------------------------------------------------------

describe('hasRiseExtensions', () => {
  it('returns true for a Rise-backed client', () => {
    const client = buildRisePhoenixClient({ accessCode: VALID_ACCESS_CODE });
    expect(hasRiseExtensions(client)).toBe(true);
    client.dispose();
  });

  it('returns false for an object lacking buildOpenIxs', () => {
    expect(hasRiseExtensions({} as RisePhoenixClient)).toBe(false);
  });

  it('returns false when buildOpenIxs is a non-function', () => {
    const stub = { buildOpenIxs: 'not a function' } as unknown as RisePhoenixClient;
    expect(hasRiseExtensions(stub)).toBe(false);
  });
});

// ---- usdcToLamports ------------------------------------------------------------------------------------------------

describe('usdcToLamports', () => {
  it('converts whole numbers (1 USDC = 1_000_000 lamports)', () => {
    expect(usdcToLamports('1')).toBe(1_000_000n);
    expect(usdcToLamports('100')).toBe(100_000_000n);
  });

  it('converts decimals up to 6 places', () => {
    expect(usdcToLamports('1.5')).toBe(1_500_000n);
    expect(usdcToLamports('0.000001')).toBe(1n);
    expect(usdcToLamports('123.456789')).toBe(123_456_789n);
  });

  it('handles zero', () => {
    expect(usdcToLamports('0')).toBe(0n);
    expect(usdcToLamports('0.0')).toBe(0n);
  });

  it('truncates beyond 6 decimal places (no rounding)', () => {
    expect(usdcToLamports('0.0000019')).toBe(1n);
    expect(usdcToLamports('1.9999999')).toBe(1_999_999n);
  });

  it('handles large numbers beyond Number.MAX_SAFE_INTEGER', () => {
    const huge = '99999999999999999.123456';
    expect(usdcToLamports(huge)).toBe(99_999_999_999_999_999_123_456n);
  });

  it('rejects non-numeric strings', () => {
    expect(() => usdcToLamports('abc')).toThrow(AdapterError);
    expect(() => usdcToLamports('1.2.3')).toThrow(/invalid amount/);
    expect(() => usdcToLamports('')).toThrow(/invalid amount/);
    expect(() => usdcToLamports('1e6')).toThrow(/invalid amount/);
  });

  it('rejects negative amounts (direction is separate field, not signed amount)', () => {
    expect(() => usdcToLamports('-1.5')).toThrow(/invalid amount/);
    expect(() => usdcToLamports('-0.000001')).toThrow(/invalid amount/);
  });

  it('trims whitespace', () => {
    expect(usdcToLamports('  1.5  ')).toBe(1_500_000n);
  });
});

// ---- normalizeMarket -----------------------------------------------------------------------------------------------

describe('normalizeMarket', () => {
  it('extracts symbol + max leverage from the leverage tiers', () => {
    const raw = {
      symbol: 'SOL-PERP',
      leverageTiers: [{ maxLeverage: 5 }, { maxLeverage: 10 }, { maxLeverage: 3 }],
    };
    const out = normalizeMarket(raw);
    expect(out.symbol).toBe('SOL-PERP');
    expect(out.maxLeverage).toBe(10);
  });

  it('handles empty leverageTiers gracefully', () => {
    const out = normalizeMarket({ symbol: 'BTC-PERP', leverageTiers: [] });
    expect(out.symbol).toBe('BTC-PERP');
    expect(out.maxLeverage).toBeUndefined();
  });

  it('converts decimal-fraction fees to bps', () => {
    const out = normalizeMarket({ symbol: 'SOL-PERP', takerFee: 0.0005, makerFee: 0.0001 });
    expect(out.takerFeeBps).toBe(5);
    expect(out.makerFeeBps).toBe(1);
  });

  it('falls back to "unknown" symbol when missing', () => {
    expect(normalizeMarket({}).symbol).toBe('unknown');
    expect(normalizeMarket(null).symbol).toBe('unknown');
  });

  it('emits asOf timestamp', () => {
    const out = normalizeMarket({ symbol: 'SOL-PERP' });
    expect(out.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ---- feeToBps ------------------------------------------------------------------------------------------------------

describe('feeToBps', () => {
  it('Phoenix taker fee (0.0005 decimal) → 5 bps', () => {
    expect(feeToBps(0.0005)).toBe(5);
  });

  it('Phoenix maker fee (0.0001 decimal) → 1 bps', () => {
    expect(feeToBps(0.0001)).toBe(1);
  });

  it('rounds non-integer bps', () => {
    expect(feeToBps(0.00045)).toBe(5); // 4.5 rounds to 5
  });

  it('handles zero', () => {
    expect(feeToBps(0)).toBe(0);
  });
});

// ---- normalizeTraderState -----------------------------------------------------------------------------------------

describe('normalizeTraderState', () => {
  it('extracts positions with side + baseSize', () => {
    const raw = {
      authority: VALID_AUTHORITY,
      pdaIndex: 0,
      traders: [
        {
          positions: [
            {
              symbol: 'SOL-PERP',
              side: 'long',
              baseLots: '0.5',
              entryPrice: { amount: '120' },
            },
            { symbol: 'BTC-PERP', side: 'short', baseLots: '0.01' },
          ],
        },
      ],
    };
    const out = normalizeTraderState(raw, VALID_AUTHORITY);
    expect(out.positions).toHaveLength(2);
    expect(out.positions[0]).toMatchObject({ symbol: 'SOL-PERP', side: 'long', baseSize: '0.5', entryPriceUsd: '120' });
    expect(out.positions[1]).toMatchObject({ symbol: 'BTC-PERP', side: 'short', baseSize: '0.01' });
  });

  it('skips positions without symbol or baseLots', () => {
    const raw = {
      traders: [
        {
          positions: [
            { symbol: 'SOL-PERP', baseLots: '0.5' },
            { side: 'long' }, // missing symbol + baseLots
            { symbol: 'BTC-PERP' }, // missing baseLots
          ],
        },
      ],
    };
    const out = normalizeTraderState(raw, VALID_AUTHORITY);
    expect(out.positions).toHaveLength(1);
    expect(out.positions[0]!.symbol).toBe('SOL-PERP');
  });

  it('extracts collateral from effectiveCollateral.amount + collateralBalance.amount', () => {
    const raw = {
      traders: [
        {
          positions: [],
          effectiveCollateral: { amount: '500' },
          collateralBalance: { amount: '600' },
        },
      ],
    };
    const out = normalizeTraderState(raw, VALID_AUTHORITY);
    expect(out.freeCollateralUsd).toBe('500');
    expect(out.totalCollateralUsd).toBe('600');
  });

  it('extracts limit orders into openOrders', () => {
    const raw = {
      traders: [
        {
          positions: [],
          limitOrders: {
            'SOL-PERP': [
              { orderSequenceNumber: '100', side: 'bid', baseLots: '0.5' },
              { orderSequenceNumber: '101', side: 'ask', baseLots: '0.3' },
            ],
          },
        },
      ],
    };
    const out = normalizeTraderState(raw, VALID_AUTHORITY);
    expect(out.openOrders).toHaveLength(2);
    expect(out.openOrders[0]).toMatchObject({ orderId: '100', symbol: 'SOL-PERP', side: 'long', type: 'limit' });
    expect(out.openOrders[1]).toMatchObject({ orderId: '101', symbol: 'SOL-PERP', side: 'short' });
  });

  it('defaults authority + traderPdaIndex from response or fallbacks', () => {
    const out = normalizeTraderState({}, VALID_AUTHORITY, 7);
    expect(out.authority).toBe(VALID_AUTHORITY);
    expect(out.traderPdaIndex).toBe(7);
  });

  it('handles null/missing response gracefully', () => {
    expect(normalizeTraderState(null, VALID_AUTHORITY).positions).toEqual([]);
    expect(normalizeTraderState(null, VALID_AUTHORITY).openOrders).toEqual([]);
  });
});

// ---- normalizeFundingHistory ---------------------------------------------------------------------------------------

describe('normalizeFundingHistory', () => {
  it('converts seconds-epoch timestamps to ISO strings', () => {
    const raw = {
      rates: [
        { timestamp: 1731000000, fundingRatePercentage: '0.0001' }, // 2024-11-07T17:20:00Z
        { timestamp: 1731003600, fundingRatePercentage: '0.0002' }, // 2024-11-07T18:20:00Z
      ],
    };
    const out = normalizeFundingHistory(raw, 'SOL-PERP');
    expect(out).toHaveLength(2);
    expect(out[0]!.observedAt).toBe('2024-11-07T17:20:00.000Z');
    expect(out[0]!.rateHourly).toBe('0.0001');
    expect(out[0]!.symbol).toBe('SOL-PERP');
  });

  it('skips entries missing timestamp or rate', () => {
    const raw = {
      rates: [
        { timestamp: 1731000000, fundingRatePercentage: '0.0001' },
        { timestamp: 1731003600 }, // missing rate
        { fundingRatePercentage: '0.0001' }, // missing timestamp
      ],
    };
    const out = normalizeFundingHistory(raw, 'SOL-PERP');
    expect(out).toHaveLength(1);
  });

  it('handles empty input', () => {
    expect(normalizeFundingHistory({}, 'SOL-PERP')).toEqual([]);
    expect(normalizeFundingHistory(null, 'SOL-PERP')).toEqual([]);
  });

  it('regression: timestamp is seconds, not ms (year < 9999)', () => {
    const raw = { rates: [{ timestamp: 1731000000, fundingRatePercentage: '0.0001' }] };
    const out = normalizeFundingHistory(raw, 'SOL-PERP');
    const year = new Date(out[0]!.observedAt).getUTCFullYear();
    expect(year).toBeGreaterThan(2020);
    expect(year).toBeLessThan(2100);
  });
});

// ---- Access code redaction (H7) -----------------------------------------------------------------------------------

describe('redactAccessCode with extraCodes', () => {
  it('scrubs env-var access codes', () => {
    process.env[PHOENIX_ACCESS_CODE_ENV] = 'env_secret_abc123';
    const msg = 'POST /v1/invite/activate failed; body included env_secret_abc123';
    expect(redactAccessCode(msg)).not.toContain('env_secret_abc123');
    expect(redactAccessCode(msg)).toContain('[redacted]');
  });

  it('scrubs BYO access codes passed via extraCodes', () => {
    const byoCode = 'phoenix_invite_byo_xyz';
    const msg = `Request failed at https://api/?token=${byoCode}`;
    const out = redactAccessCode(msg, [byoCode]);
    expect(out).not.toContain(byoCode);
    expect(out).toContain('[redacted]');
  });

  it('scrubs Authorization Bearer headers', () => {
    const msg = 'Headers: Authorization: Bearer abc.def-ghi_jkl';
    expect(redactAccessCode(msg)).toMatch(/authorization: bearer \[redacted\]/i);
  });

  it('scrubs x-phoenix-access-code headers', () => {
    const msg = 'x-phoenix-access-code: my_secret_value, content-type: ...';
    expect(redactAccessCode(msg)).toMatch(/x-phoenix-access-code\s*:\s*\[redacted\]/i);
  });

  it('handles short codes (< 4 chars) by not redacting them', () => {
    expect(redactAccessCode('error containing abc', ['abc'])).toBe('error containing abc');
  });
});

describe('withPhoenixErrors with extraCodes', () => {
  it('scrubs BYO access code from re-thrown error messages', async () => {
    const byoCode = 'byo_access_code_secret';
    const original = new Error(`Rise rejected the request with code=${byoCode}`);
    await expect(
      withPhoenixErrors('test', async () => { throw original; }, [byoCode]),
    ).rejects.toThrow(/\[redacted\]/);
    await expect(
      withPhoenixErrors('test', async () => { throw original; }, [byoCode]),
    ).rejects.not.toThrow(new RegExp(byoCode));
  });

  it('preserves the method name in the wrapped error', async () => {
    await expect(
      withPhoenixErrors('myMethod', async () => { throw new Error('boom'); }),
    ).rejects.toThrow(/Phoenix myMethod failed: boom/);
  });
});
