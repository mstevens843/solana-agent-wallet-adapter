import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { WALLET_BALANCE_SOL_MINT, WALLET_BALANCE_USDC_MINT } from '../walletBalanceSummary.js';
import { walletBalanceAssetTitle } from '../walletBalanceDisplay.js';

const stylesSource = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

describe('wallet balance display labels', () => {
  it('shows native SOL for the wrapped SOL mint in portfolio rows', () => {
    expect(walletBalanceAssetTitle(
      { mint: WALLET_BALANCE_SOL_MINT, symbol: 'SOL' },
      { name: 'Wrapped SOL' },
    )).toBe('SOL');
  });

  it('keeps enriched names for non-SOL tokens', () => {
    expect(walletBalanceAssetTitle(
      { mint: WALLET_BALANCE_USDC_MINT, symbol: 'USDC' },
      { name: 'USD Coin' },
    )).toBe('USD Coin');
  });

  it('widens the native chat balance pill when Pending is visible', () => {
    expect(stylesSource).toContain('.chat-actions-row-end.has-balances .chat-balances-pill { max-width: min(118px, 52%); }');
    expect(stylesSource).toContain('.chat-actions-row-end.has-balances .chat-pending-label');
    expect(stylesSource).toContain('text-overflow: ellipsis;');
  });
});
