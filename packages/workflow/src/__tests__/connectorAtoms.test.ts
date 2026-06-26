import { describe, expect, it } from 'vitest';

import {
  CONNECTOR_ATOMS,
  buildConnectorContext,
  clampConnectorFacts,
  connectorActionCard,
  connectorCapabilityIndex,
  findConnectorAtomByIntent,
  formatAmmLiquidity,
  formatDriftVault,
  formatJitoStake,
  formatJupiterSwapQuote,
  formatKaminoLend,
  formatLuloLend,
  formatMarinadeStake,
  formatPythOracle,
  formatWormholeBridge,
  getConnectorAtom,
} from '../connectorAtoms/index.js';

describe('getConnectorAtom', () => {
  it('resolves by action key and connectorId', () => {
    const atom = getConnectorAtom('jupiter', 'lend');
    expect(atom?.action).toBe('lend');
    expect(atom?.factSpec?.capability).toBe('earn');
  });

  it('resolves by alias and defaults connectorId to jupiter', () => {
    expect(getConnectorAtom(undefined, 'earn')?.action).toBe('lend');
    expect(getConnectorAtom('jupiter', 'take profit')?.action).toBe('limit');
    expect(getConnectorAtom('jupiter', 'recurring')?.action).toBe('dca');
  });

  it('returns undefined for unknown action / connector', () => {
    expect(getConnectorAtom('jupiter', 'nope')).toBeUndefined();
    expect(getConnectorAtom('jupiter', '')).toBeUndefined();
    // marginfi has no connector atom yet (covered connectors return their atom).
    expect(getConnectorAtom('marginfi', 'lend')).toBeUndefined();
  });
});

describe('findConnectorAtomByIntent', () => {
  it('matches only when a connector token AND an action alias are present', () => {
    expect(findConnectorAtomByIntent('show my jupiter lend positions')?.action).toBe('lend');
    expect(findConnectorAtomByIntent('what are my jup dca orders')?.action).toBe('dca');
    expect(findConnectorAtomByIntent("what's my jupiter borrow health")?.action).toBe('borrow');
  });

  it('does NOT hijack generic questions (no connector token)', () => {
    expect(findConnectorAtomByIntent('what is the price of SOL')).toBeUndefined();
    expect(findConnectorAtomByIntent('show my lend positions')).toBeUndefined();
    expect(findConnectorAtomByIntent('how is the market today')).toBeUndefined();
  });

  it('only returns fact-bearing atoms (knowledge-only portfolio excluded)', () => {
    // "jupiter portfolio" has a connector token + 'portfolio' alias but portfolio is
    // knowledge-only (assembled from lend + borrow), so intent detection skips it.
    expect(findConnectorAtomByIntent('show my jupiter portfolio')).toBeUndefined();
  });
});

describe('Jupiter format() projections', () => {
  it('lend → positions', () => {
    const raw = {
      connector: { id: 'jupiter', heavy: 'x'.repeat(500) },
      capability: 'earn',
      walletAddress: 'W',
      positions: [{ assetMint: 'So11111111111111111111111111111111111111112', tokenSymbol: 'SOL', underlyingAmount: '12.5', apy: 0.07, asOf: '2026-06-26T00:00:00Z' }],
    };
    const out = getConnectorAtom('jupiter', 'lend')!.factSpec!.format(raw);
    expect(out.kind).toBe('lend_positions');
    expect((out.positions as unknown[]).length).toBe(1);
    expect((out.positions as Array<Record<string, unknown>>)[0]).toMatchObject({ asset: 'SOL', supplied: '12.5', apy: 0.07 });
    // The verbose connector view must not leak into the compact projection.
    expect(JSON.stringify(out)).not.toContain('xxxxx');
  });

  it('lend → markets when no positions', () => {
    const raw = { connector: {}, capability: 'earn', tokens: [{ assetMint: 'm', tokenSymbol: 'USDC', apy: 0.05, utilization: 0.8 }] };
    const out = getConnectorAtom('jupiter', 'lend')!.factSpec!.format(raw);
    expect(out.kind).toBe('lend_markets');
    expect((out.markets as Array<Record<string, unknown>>)[0]).toMatchObject({ asset: 'USDC', apy: 0.05 });
  });

  it('borrow → positions with health + status', () => {
    const raw = {
      connector: {},
      capability: 'positions',
      positions: [{ vaultId: 3, collateralAmount: '100', debtAmount: '40', healthRatio: 1.8, liquidationStatus: 'safe' }],
    };
    const out = getConnectorAtom('jupiter', 'borrow')!.factSpec!.format(raw);
    expect(out.kind).toBe('borrow_positions');
    expect((out.positions as Array<Record<string, unknown>>)[0]).toMatchObject({ vault: 3, debt: '40', health: 1.8, status: 'safe' });
  });

  it('perps → read-only status', () => {
    const raw = { connector: {}, capability: 'perps', readOnly: true, apiStatus: 'beta', warnings: ['w1', 'w2', 'w3', 'w4'] };
    const out = getConnectorAtom('jupiter', 'perps')!.factSpec!.format(raw);
    expect(out).toMatchObject({ kind: 'perps_status', supported: true, readOnly: true, apiStatus: 'beta' });
    expect((out.warnings as unknown[]).length).toBe(3); // capped
  });

  it('gated products (limit/dca/prediction) strip the connector view defensively', () => {
    const raw = { connector: { heavy: 'y'.repeat(200) }, capability: 'trigger', orders: [{ id: 1 }] };
    const out = getConnectorAtom('jupiter', 'limit')!.factSpec!.format(raw);
    expect(JSON.stringify(out)).not.toContain('yyyyy');
  });
});

describe('clampConnectorFacts', () => {
  it('passes through small payloads and clamps oversized ones', () => {
    expect(clampConnectorFacts({ a: 1 }, 100)).toEqual({ a: 1 });
    const big = clampConnectorFacts({ blob: 'z'.repeat(5000) }, 200);
    expect(big.note).toMatch(/truncated/);
    expect(typeof big.preview).toBe('string');
  });
});

describe('capability index + cards', () => {
  it('index lists every atom with a tool route', () => {
    const index = connectorCapabilityIndex();
    expect(index).toContain('jupiter/lend');
    expect(index).toContain('get_connector_facts action=lend');
    // gated products are flagged
    expect(index).toMatch(/jupiter\/limit:.*\[enable flag\]/);
  });

  it('card includes the disabled note for gated products', () => {
    const card = connectorActionCard(getConnectorAtom('jupiter', 'limit'));
    expect(card).toContain('jupiter/limit');
    expect(card).toContain('disabled until');
    expect(connectorActionCard(undefined)).toBe('');
  });

  it('buildConnectorContext returns index always, card only on selection', () => {
    expect(buildConnectorContext()).toEqual({ index: connectorCapabilityIndex() });
    const withCard = buildConnectorContext({ connectorId: 'jupiter', action: 'lend' });
    expect(withCard.index).toBeTruthy();
    expect(withCard.card).toContain('Jupiter Lend');
  });
});

describe('atom registry invariants', () => {
  it('every fact-bearing atom has a buildInput + format and a non-empty card', () => {
    for (const atom of CONNECTOR_ATOMS) {
      expect(connectorActionCard(atom).length).toBeGreaterThan(0);
      if (atom.factSpec) {
        expect(typeof atom.factSpec.buildInput).toBe('function');
        expect(typeof atom.factSpec.format).toBe('function');
        // buildInput must never throw on an empty arg bag.
        expect(() => atom.factSpec!.buildInput({})).not.toThrow();
      }
    }
  });
});

describe('AMM connector atoms (raydium / orca / meteora)', () => {
  it('resolves each liquidity atom by action key and connector alias', () => {
    expect(getConnectorAtom('raydium', 'liquidity')?.factSpec?.capability).toBe('positions');
    expect(getConnectorAtom('orca', 'whirlpool')?.action).toBe('liquidity');
    expect(getConnectorAtom('meteora', 'dlmm')?.action).toBe('liquidity');
    expect(getConnectorAtom('raydium', 'lp')?.action).toBe('liquidity');
  });

  it('intent detection needs a connector token AND an action alias', () => {
    expect(findConnectorAtomByIntent('show my orca positions')?.connectorId).toBe('orca');
    expect(findConnectorAtomByIntent('what is my raydium lp worth')?.connectorId).toBe('raydium');
    expect(findConnectorAtomByIntent('my meteora dlmm positions')?.connectorId).toBe('meteora');
    // generic position questions with no connector token must NOT hijack
    expect(findConnectorAtomByIntent('show my positions')).toBeUndefined();
    expect(findConnectorAtomByIntent('add liquidity somewhere')).toBeUndefined();
  });

  it('formatAmmLiquidity projects positions compactly and drops the connector view', () => {
    const raw = {
      connector: { id: 'orca', heavy: 'x'.repeat(400) },
      capability: 'positions',
      walletAddress: 'W',
      positions: [
        {
          whirlpoolAddress: 'Pool1111111111111111111111111111111111111111',
          inRange: true,
          liquidity: '123456',
          tokenAmounts: [
            { mint: 'So11111111111111111111111111111111111111112', amount: '1.5', symbol: 'SOL' },
            { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', amount: '40', symbol: 'USDC' },
          ],
          feesOwed: [{ mint: 'm', amount: '0.5', symbol: 'USDC' }],
        },
      ],
      totals: { positions: 1, inRange: 1, outOfRange: 0 },
    };
    const out = formatAmmLiquidity(raw, 'orca');
    expect(out.kind).toBe('orca_lp');
    expect(out.count).toBe(1);
    expect(out.inRange).toBe(1);
    const pos = (out.positions as Array<Record<string, unknown>>)[0]!;
    expect(pos.pair).toBe('SOL/USDC');
    expect(pos.inRange).toBe(true);
    expect(pos.fees).toBe('0.5 USDC');
    expect(JSON.stringify(out)).not.toContain('xxxxx');
  });

  it('formatAmmLiquidity surfaces raydium position type + per-type totals', () => {
    const raw = {
      connector: {},
      capability: 'positions',
      positions: [{ positionType: 'clmm', poolId: 'P', inRange: false, liquidity: '99', tokenAmounts: [{ mint: 'a', amount: '2', symbol: 'RAY' }] }],
      totals: { positions: 1, clmmPositions: 1, cpmmPositions: 0, farmPositions: 0 },
    };
    const out = formatAmmLiquidity(raw, 'raydium');
    expect(out.kind).toBe('raydium_lp');
    expect(out.clmm).toBe(1);
    expect((out.positions as Array<Record<string, unknown>>)[0]).toMatchObject({ type: 'clmm', inRange: false });
  });

  it('formatAmmLiquidity reports an empty wallet without inventing positions', () => {
    const out = formatAmmLiquidity({ connector: {}, capability: 'positions', positions: [], totals: { positions: 0 } }, 'meteora');
    expect(out).toMatchObject({ kind: 'meteora_lp', count: 0 });
    expect(out.note).toMatch(/No meteora liquidity positions/);
  });

  it('capability index lists the three liquidity atoms with the tool route', () => {
    const index = connectorCapabilityIndex();
    for (const id of ['raydium', 'orca', 'meteora']) {
      expect(index).toContain(`${id}/liquidity`);
      expect(index).toContain('get_connector_facts action=liquidity');
    }
  });
});

describe('lend / staking / vault connector atoms (kamino / jito / marinade / drift)', () => {
  it('resolves each atom by action key and connector alias', () => {
    expect(getConnectorAtom('kamino', 'lend')?.factSpec?.capability).toBe('positions');
    expect(getConnectorAtom('kamino', 'supply')?.action).toBe('lend');
    expect(getConnectorAtom('jito', 'stake')?.factSpec?.capability).toBe('positions');
    expect(getConnectorAtom('marinade', 'unstake')?.action).toBe('stake');
    expect(getConnectorAtom('drift', 'vault')?.factSpec?.capability).toBe('positions');
  });

  it('intent detection needs a connector token AND an action alias', () => {
    expect(findConnectorAtomByIntent('show my kamino positions')?.connectorId).toBe('kamino');
    expect(findConnectorAtomByIntent('stake some sol with jito')?.connectorId).toBe('jito');
    expect(findConnectorAtomByIntent('what is my jitosol balance')?.connectorId).toBe('jito');
    expect(findConnectorAtomByIntent('my msol and unstake tickets')?.connectorId).toBe('marinade');
    expect(findConnectorAtomByIntent('show my drift vaults')?.connectorId).toBe('drift');
    expect(findConnectorAtomByIntent('show my positions')).toBeUndefined();
  });

  it('formatKaminoLend projects supplied reserves', () => {
    const raw = {
      connector: { heavy: 'x'.repeat(300) },
      capability: 'positions',
      positions: [{ reserveMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', reserveSymbol: 'USDC', suppliedAmount: '100', currentValue: '100.5', earnedInterest: '0.5', supplyApy: 0.06 }],
      totals: { reserves: 1, totalSupplied: '100', totalEarned: '0.5' },
    };
    const out = formatKaminoLend(raw);
    expect(out).toMatchObject({ kind: 'kamino_lend', count: 1, totalSupplied: '100', totalEarned: '0.5' });
    expect((out.positions as Array<Record<string, unknown>>)[0]).toMatchObject({ asset: 'USDC', supplied: '100', apy: 0.06 });
    expect(JSON.stringify(out)).not.toContain('xxxxx');
  });

  it('formatDriftVault projects vault shares + drops zero pending withdraw', () => {
    const raw = {
      connector: {},
      capability: 'positions',
      positions: [{ vaultAddress: 'Vault1111111111111111111111111111111111111', shares: '10', valueAtSharePrice: '12.3', pendingWithdrawShares: '0' }],
      totals: { vaultCount: 1, pendingWithdrawCount: 0, totalShares: '10', totalValue: '12.3' },
    };
    const out = formatDriftVault(raw);
    expect(out).toMatchObject({ kind: 'drift_vault', count: 1, totalValue: '12.3' });
    const pos = (out.positions as Array<Record<string, unknown>>)[0]!;
    expect(pos.value).toBe('12.3');
    expect(pos.pendingWithdraw).toBeUndefined();
  });

  it('formatJitoStake projects balance + stake accounts with lamports->SOL', () => {
    const raw = {
      connector: {},
      capability: 'positions',
      jitoSol: { mint: 'J', decimals: 9, amount: '5.5', amountRaw: '5500000000' },
      stakeAccounts: [{ stakeAccount: 'Stake111111111111111111111111111111111111', lamports: '2000000000', state: 'active', eligibleForJitoDeposit: true }],
      totals: { jitoSolTokenAccounts: 1, stakeAccounts: 1, eligibleStakeAccounts: 1 },
    };
    const out = formatJitoStake(raw);
    expect(out).toMatchObject({ kind: 'jito_stake', jitoSol: '5.5', stakeAccounts: 1, eligibleStakeAccounts: 1 });
    expect((out.accounts as Array<Record<string, unknown>>)[0]).toMatchObject({ sol: 2, state: 'active', eligibleForDeposit: true });
  });

  it('formatMarinadeStake reads the snapshot envelope (mSOL + tickets)', () => {
    const raw = {
      connector: {},
      capability: 'positions',
      snapshot: {
        msolMint: 'M',
        msolBalanceRaw: '3000000000',
        msolBalance: '3',
        estimatedSolValue: '3.3',
        nativeStakeAccounts: [{ stakeAccount: 's', lamports: '1', solAmount: '0', state: 'active' }],
        unstakeTickets: [{ ticketAccount: 't', solAmount: '1.5', status: 'claimable', claimableAt: '2026-07-01' }],
      },
    };
    const out = formatMarinadeStake(raw);
    expect(out).toMatchObject({ kind: 'marinade_stake', msol: '3', estimatedSolValue: '3.3', nativeStakeAccounts: 1 });
    expect(out.unstakeTickets).toMatchObject({ count: 1, claimable: 1 });
    expect((out.tickets as Array<Record<string, unknown>>)[0]).toMatchObject({ status: 'claimable', sol: '1.5', claimableAt: '2026-07-01' });
  });

  it('format helpers report empty wallets without inventing positions', () => {
    expect(formatKaminoLend({ positions: [] })).toMatchObject({ kind: 'kamino_lend', count: 0 });
    expect(formatDriftVault({ positions: [] })).toMatchObject({ kind: 'drift_vault', count: 0 });
  });

  it('drift card states it is deprecated / read-only', () => {
    expect(connectorActionCard(getConnectorAtom('drift', 'vault'))).toMatch(/DEPRECATED|read-only/i);
  });

  it('capability index lists all four new atoms', () => {
    const index = connectorCapabilityIndex();
    expect(index).toContain('kamino/lend');
    expect(index).toContain('jito/stake');
    expect(index).toContain('marinade/stake');
    expect(index).toContain('drift/vault');
  });
});

describe('Jupiter swap quote + Lulo / Wormhole / Pyth atoms', () => {
  it('the Jupiter swap atom is now fact-bearing (live quote)', () => {
    const swap = getConnectorAtom('jupiter', 'swap');
    expect(swap?.factSpec?.capability).toBe('swap');
    // It builds the order-preview input from the swap args.
    expect(swap?.factSpec?.buildInput({ inputToken: 'SOL', outputToken: 'USDC', amount: '1' })).toMatchObject({ inputToken: 'SOL', outputToken: 'USDC', amount: '1' });
  });

  it('formatJupiterSwapQuote projects the preview', () => {
    const raw = { connector: {}, capability: 'swap', preview: { inputMint: 'So11111111111111111111111111111111111111112', outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', inAmount: '1000000000', outAmount: '180000000', otherAmountThreshold: '179000000', slippageBps: 50, priceImpactPct: 0.1, swapMode: 'ExactIn', routePlan: [{}, {}] } };
    const out = formatJupiterSwapQuote(raw);
    expect(out).toMatchObject({ kind: 'jupiter_swap_quote', inAmount: '1000000000', outAmount: '180000000', slippageBps: 50, priceImpactPct: 0.1, route: 2 });
  });

  it('resolves lulo / wormhole / pyth atoms by action + alias', () => {
    expect(getConnectorAtom('lulo', 'lend')?.factSpec?.capability).toBe('positions');
    expect(getConnectorAtom('lulo', 'protected')?.action).toBe('lend');
    expect(getConnectorAtom('wormhole', 'bridge')?.factSpec?.capability).toBe('positions');
    expect(getConnectorAtom('pyth', 'oracle')?.factSpec?.capability).toBe('oracle');
    expect(getConnectorAtom('pyth', 'price')?.action).toBe('oracle');
  });

  it('intent detection needs a connector token AND an action alias', () => {
    expect(findConnectorAtomByIntent('show my lulo positions')?.connectorId).toBe('lulo');
    expect(findConnectorAtomByIntent('what is my wormhole bridge exposure')?.connectorId).toBe('wormhole');
    expect(findConnectorAtomByIntent('pyth price of SOL')?.connectorId).toBe('pyth');
    expect(findConnectorAtomByIntent('what is the price of SOL')).toBeUndefined();
  });

  it('formatLuloLend projects per-pool-type rows', () => {
    const raw = { connector: {}, capability: 'positions', snapshot: { rows: [{ mintAddress: 'm', symbol: 'USDC', depositType: 'protected', amountUi: '500', earnedInterestUi: '2.1', apy: 0.08, withdrawableUi: '500' }] } };
    const out = formatLuloLend(raw);
    expect(out).toMatchObject({ kind: 'lulo_lend', count: 1 });
    expect((out.positions as Array<Record<string, unknown>>)[0]).toMatchObject({ asset: 'USDC', type: 'protected', amount: '500', apy: 0.08 });
  });

  it('formatWormholeBridge summarizes pending transfers', () => {
    const raw = { connector: {}, capability: 'positions', snapshot: { sourceChain: 'Solana', pendingTransfers: [{ destinationChain: 'Ethereum', state: 'ready_to_redeem', redeemed: false, nextAction: 'redeem_on_destination', destinationToken: 'USDC' }], recentTransfers: [] } };
    const out = formatWormholeBridge(raw);
    expect(out).toMatchObject({ kind: 'wormhole_bridge', sourceChain: 'Solana', pendingCount: 1 });
    expect((out.pending as Array<Record<string, unknown>>)[0]).toMatchObject({ to: 'Ethereum', state: 'ready_to_redeem', nextAction: 'redeem_on_destination' });
  });

  it('formatPythOracle reads oracle evidence (price + confidence + freshness)', () => {
    const raw = { connector: {}, capability: 'oracle', evidence: { symbol: 'SOL/USD', priceUi: '180.42', confidenceUi: '0.05', confidenceBps: 3, ageSeconds: 2, status: 'fresh' } };
    const out = formatPythOracle(raw);
    expect(out).toMatchObject({ kind: 'pyth_oracle', symbol: 'SOL/USD', price: '180.42', confidence: '0.05', status: 'fresh' });
  });

  it('empty wallets report no positions', () => {
    expect(formatLuloLend({ snapshot: { rows: [] } })).toMatchObject({ kind: 'lulo_lend', count: 0 });
    expect(formatWormholeBridge({ snapshot: { pendingTransfers: [], recentTransfers: [] } })).toMatchObject({ kind: 'wormhole_bridge' });
  });

  it('capability index lists swap + the three new connectors', () => {
    const index = connectorCapabilityIndex();
    expect(index).toContain('jupiter/swap');
    expect(index).toContain('get_connector_facts action=swap');
    expect(index).toContain('lulo/lend');
    expect(index).toContain('wormhole/bridge');
    expect(index).toContain('pyth/oracle');
  });
});
