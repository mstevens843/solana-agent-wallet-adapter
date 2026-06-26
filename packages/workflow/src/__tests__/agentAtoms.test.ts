import { describe, expect, it, vi } from 'vitest';

import { extractAtoms, extractAtomsWithLlmFallback, looksLikePolicyWithoutAtoms, type AgentAtom } from '../agentAtoms.js';

function ids(atoms: AgentAtom[]): string[] {
  return atoms.map((atom) => atom.id);
}

function byType<T extends AgentAtom['type']>(atoms: AgentAtom[], type: T): Extract<AgentAtom, { type: T }>[] {
  return atoms.filter((atom): atom is Extract<AgentAtom, { type: T }> => atom.type === type);
}

describe('extractAtoms', () => {
  it('returns no atoms for empty input', () => {
    expect(extractAtoms({ text: '' })).toEqual({ atoms: [], consumedSpans: [] });
    expect(extractAtoms({})).toEqual({ atoms: [], consumedSpans: [] });
  });

  it('extracts a single price atom with the right subject/op/value', () => {
    const { atoms } = extractAtoms({ text: 'SOL must be above $80' });
    expect(atoms).toHaveLength(1);
    expect(atoms[0]).toMatchObject({ type: 'price', subject: 'SOL', op: 'gt', value: 80, unit: 'USD' });
  });

  it('extracts multiple price atoms with different operators', () => {
    const { atoms } = extractAtoms({ text: 'SOL above $80 and BTC below $40000' });
    const prices = byType(atoms, 'price');
    expect(prices).toHaveLength(2);
    expect(prices.find((a) => a.subject === 'SOL')).toMatchObject({ op: 'gt', value: 80 });
    expect(prices.find((a) => a.subject === 'BTC')).toMatchObject({ op: 'lt', value: 40000 });
  });

  it('extracts a market_regime fear_and_greed atom', () => {
    const { atoms } = extractAtoms({ text: 'BTC Fear & Greed must be above 20' });
    const regimes = byType(atoms, 'market_regime');
    expect(regimes).toEqual([
      expect.objectContaining({ subject: 'fear_and_greed', op: 'gt', value: 20 }),
    ]);
  });

  it('extracts BTC dominance and total market cap atoms with SI suffixes', () => {
    const { atoms } = extractAtoms({ text: 'Approve only if BTC dominance is above 50 and total market cap above $2T' });
    const regimes = byType(atoms, 'market_regime');
    expect(regimes).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject: 'btc_dominance', op: 'gt', value: 50 }),
      expect.objectContaining({ subject: 'total_market_cap', op: 'gt', value: 2e12 }),
    ]));
  });

  it('extracts token_audit atoms for mint and freeze authority disabled', () => {
    const { atoms } = extractAtoms({ text: 'token gates: mint authority disabled, freeze authority disabled' });
    const audits = byType(atoms, 'token_audit');
    expect(audits).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'mint_authority_disabled', expected: true }),
      expect.objectContaining({ field: 'freeze_authority_disabled', expected: true }),
    ]));
  });

  it('extracts a token_age atom and converts unit to seconds', () => {
    const { atoms } = extractAtoms({ text: 'token age above 24h' });
    const ages = byType(atoms, 'token_age');
    expect(ages).toEqual([expect.objectContaining({ op: 'gt', value: 24 * 3_600 })]);
  });

  it('handles days, weeks, and months for token age', () => {
    expect(byType(extractAtoms({ text: 'age above 7 days' }).atoms, 'token_age')[0]?.value).toBe(7 * 86_400);
    expect(byType(extractAtoms({ text: 'age above 2 weeks' }).atoms, 'token_age')[0]?.value).toBe(14 * 86_400);
    expect(byType(extractAtoms({ text: 'age above 6 months' }).atoms, 'token_age')[0]?.value).toBe(6 * 30 * 86_400);
  });

  it('extracts all four tx_gate rules', () => {
    const { atoms } = extractAtoms({
      text: 'only executes the requested swap, no extra transfers, no unknown recipients, no unrelated instructions',
    });
    const gates = byType(atoms, 'tx_gate').map((atom) => atom.rule);
    expect(gates).toEqual(expect.arrayContaining([
      'only_requested_swap',
      'no_extra_transfers',
      'no_unknown_recipients',
      'no_unrelated_instructions',
    ]));
  });

  it('classifies off-chain priced items as external_price (helium phone plan < $20)', () => {
    const { atoms } = extractAtoms({ text: 'And only approve if helium phone plan is less than $20 dollars.' });
    const ext = byType(atoms, 'external_price');
    expect(ext).toEqual([
      expect.objectContaining({ op: 'lt', value: 20, unit: 'USD' }),
    ]);
    expect(ext[0]!.subject).toContain('helium');
  });

  it('classifies Helium Mobile cheapest-plan wording as a single external_price atom', () => {
    const variants = [
      "Only approve if Helium Mobile monthly phone plan's cheapest plan is less than $20.",
      "Only approve if Helium monthly phone plan is less than $20.",
      "Approve only if the Helium Mobile cheapest plan is under $20/month.",
    ];

    for (const text of variants) {
      const { atoms } = extractAtoms({ text });
      const ext = byType(atoms, 'external_price');
      expect(ext, text).toEqual([
        expect.objectContaining({ op: 'lt', value: 20, unit: 'USD' }),
      ]);
      expect(ext[0]!.subject, text).toContain('helium');
      expect(ext[0]!.subject, text).not.toMatch(/\b(approve|deny|reject|if)\b/);
    }
  });

  it('does NOT double-classify a crypto-symbol threshold as external_price', () => {
    const { atoms } = extractAtoms({ text: 'SOL above $80' });
    // SOL is a known symbol → only the price atom; nothing in external_price.
    expect(byType(atoms, 'external_price')).toHaveLength(0);
    expect(byType(atoms, 'price')).toHaveLength(1);
  });

  it('extracts all atoms for the full mixed policy NOTE in stable order', () => {
    const { atoms } = extractAtoms({
      text: [
        'Run my pre-signing policy for this swap.',
        'Market gates: BTC Fear & Greed must be above 20. SOL must be above $80.',
        'Token gates: mint authority disabled. freeze authority disabled. token age above 24h.',
        'Transaction gates: only executes the requested swap. no extra transfers. no unknown recipients. no unrelated instructions.',
        'And only approve if helium phone plan is less than $20.',
      ].join('\n'),
      knownTokenSymbols: ['SOL', 'USDC'],
    });

    const factTypes = atoms.map((atom) => atom.type);
    expect(factTypes).toEqual(expect.arrayContaining([
      'token_audit', 'token_audit', 'token_age', 'market_regime', 'price', 'tx_gate', 'external_price',
    ]));

    expect(ids(atoms)).toEqual(expect.arrayContaining([
      'atom.token_audit.mint_authority_disabled.true',
      'atom.token_audit.freeze_authority_disabled.true',
      'atom.market_regime.fear_and_greed.gt.20',
      'atom.price.sol.gt.80',
      'atom.tx_gate.only_requested_swap',
      'atom.tx_gate.no_extra_transfers',
      'atom.tx_gate.no_unknown_recipients',
      'atom.tx_gate.no_unrelated_instructions',
    ]));

    // helium external-price atom present
    expect(atoms.some((atom) => atom.type === 'external_price' && atom.subject.includes('helium'))).toBe(true);
  });

  it('produces deterministic ids for the same input', () => {
    const note = 'SOL above $80 and mint authority disabled';
    const first = ids(extractAtoms({ text: note }).atoms).sort();
    const second = ids(extractAtoms({ text: note }).atoms).sort();
    expect(first).toEqual(second);
  });

  it('records consumedSpans for each atom so later passes can skip them', () => {
    const { atoms, consumedSpans } = extractAtoms({ text: 'SOL above $80' });
    expect(atoms).toHaveLength(1);
    expect(consumedSpans).toHaveLength(1);
    expect(consumedSpans[0]!.end).toBeGreaterThan(consumedSpans[0]!.start);
  });
});

describe('extractAtoms — external_state', () => {
  it('extracts a network_outage atom with expected=false when phrased as "no outage"', () => {
    const { atoms } = extractAtoms({ text: 'Approve only if there is no Solana network outage right now.' });
    const state = byType(atoms, 'external_state');
    expect(state.length).toBeGreaterThanOrEqual(1);
    expect(state[0]).toMatchObject({ kind: 'network_outage', expected: false });
  });

  it('extracts an exploit atom from "deny if exploit"', () => {
    const { atoms } = extractAtoms({ text: 'Deny if there was a Jupiter exploit in the last 30 days.' });
    const state = byType(atoms, 'external_state');
    expect(state.some((s) => s.kind === 'exploit')).toBe(true);
  });

  it('extracts paused_withdrawals', () => {
    const { atoms } = extractAtoms({ text: 'Deny if any major Solana DEX has paused withdrawals today.' });
    expect(byType(atoms, 'external_state').some((s) => s.kind === 'paused_withdrawals')).toBe(true);
  });
});

describe('extractAtoms — external_event', () => {
  it('extracts a scheduled_upgrade atom with a window when "next 24h" is specified', () => {
    const { atoms } = extractAtoms({ text: 'Approve only if Solana is not scheduled for a mainnet upgrade in the next 24h.' });
    const events = byType(atoms, 'external_event');
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]).toMatchObject({ kind: 'scheduled_upgrade', window: 'within', windowSeconds: 24 * 3_600, expected: false });
  });

  it('extracts a governance_vote atom', () => {
    const { atoms } = extractAtoms({ text: 'Reject if the team\'s most recent governance vote was rejected.' });
    expect(byType(atoms, 'external_event').some((e) => e.kind === 'governance_vote')).toBe(true);
  });
});

describe('extractAtoms — external_identity', () => {
  it('extracts sanctions_list (defaults expected=false — user wants NOT on the list)', () => {
    const { atoms } = extractAtoms({ text: 'Deny if the recipient is on the OFAC sanctions list.' });
    const ids = byType(atoms, 'external_identity');
    expect(ids[0]).toMatchObject({ kind: 'sanctions_list', expected: false });
  });

  it('extracts sec_action', () => {
    const { atoms } = extractAtoms({ text: 'Deny if there is an active SEC enforcement action against the token issuer.' });
    expect(byType(atoms, 'external_identity').some((i) => i.kind === 'sec_action')).toBe(true);
  });

  it('extracts kyc_status with expected=true (defaults to wanting KYC complete)', () => {
    const { atoms } = extractAtoms({ text: 'Approve only if KYC status is complete.' });
    const ids = byType(atoms, 'external_identity');
    expect(ids[0]).toMatchObject({ kind: 'kyc_status', expected: true });
  });
});

describe('extractAtoms — tradfi_price', () => {
  it('extracts SPY above $500', () => {
    const { atoms } = extractAtoms({ text: 'Approve only if SPY is above 500.' });
    const tradfi = byType(atoms, 'tradfi_price');
    expect(tradfi[0]).toMatchObject({ subject: 'SPY', op: 'gt', value: 500 });
  });

  it('extracts gold and FX pairs', () => {
    const { atoms } = extractAtoms({ text: 'Approve if GLD > 180. EUR/USD must be above 1.10.' });
    const tradfi = byType(atoms, 'tradfi_price');
    expect(tradfi.some((t) => t.subject === 'GLD' && t.value === 180)).toBe(true);
    expect(tradfi.some((t) => t.subject === 'EUR/USD' && Math.abs(t.value - 1.10) < 1e-9)).toBe(true);
  });

  it('does NOT route tradfi tickers through the crypto price extractor', () => {
    const { atoms } = extractAtoms({ text: 'SPY > 500' });
    expect(byType(atoms, 'price')).toHaveLength(0);
    expect(byType(atoms, 'tradfi_price')).toHaveLength(1);
  });
});

describe('extractAtoms — time_fact', () => {
  it('extracts business day, holiday, and market_open', () => {
    const { atoms } = extractAtoms({
      text: 'Approve only if today is a business day, not a holiday, and during market hours.',
    });
    const t = byType(atoms, 'time_fact');
    expect(t.some((f) => f.kind === 'is_business_day')).toBe(true);
    expect(t.some((f) => f.kind === 'is_us_holiday')).toBe(true);
    expect(t.some((f) => f.kind === 'is_market_open')).toBe(true);
  });
});

describe('extractAtoms — network_metric', () => {
  it('extracts TPS threshold', () => {
    const { atoms } = extractAtoms({ text: 'Approve only if Solana TPS is above 1000.' });
    const m = byType(atoms, 'network_metric');
    expect(m[0]).toMatchObject({ metric: 'tps', op: 'gt', value: 1000 });
  });

  it('extracts validator jailed (no operator/value, just a flag)', () => {
    const { atoms } = extractAtoms({ text: 'Approve only if the validator is not jailed.' });
    const m = byType(atoms, 'network_metric');
    expect(m.some((x) => x.metric === 'validator_jailed')).toBe(true);
  });

  it('extracts slot_height threshold', () => {
    const { atoms } = extractAtoms({ text: 'Deny if slot height is below 300000000.' });
    const m = byType(atoms, 'network_metric');
    expect(m[0]).toMatchObject({ metric: 'slot_height', op: 'lt', value: 300_000_000 });
  });
});

describe('extractAtoms — Tier 1: wallet_balance / token_balance / relative_amount / tx_fee / network_congestion', () => {
  it('extracts wallet_balance from "SOL balance above 1"', () => {
    const { atoms } = extractAtoms({ text: 'Approve only if SOL balance above 1.' });
    const wb = byType(atoms, 'wallet_balance');
    expect(wb[0]).toMatchObject({ subject: 'SOL', op: 'gt', value: 1, unit: 'SOL' });
  });

  it('extracts wallet_balance from "leave at least 0.5 SOL"', () => {
    const { atoms } = extractAtoms({ text: 'Leave at least 0.5 SOL for fees.' });
    const wb = byType(atoms, 'wallet_balance');
    expect(wb[0]).toMatchObject({ op: 'gte', value: 0.5, unit: 'SOL' });
  });

  it('extracts token_balance from "USDC balance above 100"', () => {
    const { atoms } = extractAtoms({ text: 'Approve only if USDC balance is above 100 tokens.' });
    const tb = byType(atoms, 'token_balance');
    expect(tb[0]).toMatchObject({ subject: 'USDC', op: 'gt', value: 100, unit: 'tokens' });
  });

  it('extracts relative_amount from "more than 10% of my wallet"', () => {
    const { atoms } = extractAtoms({ text: 'Deny if this swap is more than 10% of my wallet.' });
    const ra = byType(atoms, 'relative_amount');
    expect(ra[0]).toMatchObject({ op: 'gt', basis: 'wallet' });
    expect(ra[0]!.fraction).toBeCloseTo(0.10, 5);
  });

  it('extracts relative_amount with sol_balance basis from "more than 25% of my SOL"', () => {
    const { atoms } = extractAtoms({ text: 'Deny if amount is over 25% of my SOL balance.' });
    const ra = byType(atoms, 'relative_amount');
    expect(ra[0]).toMatchObject({ op: 'gt', basis: 'sol_balance' });
    expect(ra[0]!.fraction).toBeCloseTo(0.25, 5);
  });

  it('extracts tx_fee from "fee above $1"', () => {
    const { atoms } = extractAtoms({ text: 'Deny if transaction fee above $1.' });
    const tf = byType(atoms, 'tx_fee');
    expect(tf[0]).toMatchObject({ op: 'gt', value: 1, unit: 'USD' });
  });

  it('extracts network_congestion from "priority fee above 100k"', () => {
    const { atoms } = extractAtoms({ text: 'Deny if median priority fee is above 100k.' });
    const nc = byType(atoms, 'network_congestion');
    expect(nc[0]).toMatchObject({ op: 'gt', value: 100_000, unit: 'microlamports' });
  });

  it('extracts network_congestion from qualitative "network is congested"', () => {
    const { atoms } = extractAtoms({ text: 'Deny if the network is congested.' });
    const nc = byType(atoms, 'network_congestion');
    expect(nc[0]).toMatchObject({ op: 'gt', value: 250_000 });
  });
});

describe('extractAtoms — Tier 2: token_supply / mint_decimals / wallet_age / recipient_known / token_held_duration', () => {
  it('extracts token_supply with SI suffix', () => {
    const { atoms } = extractAtoms({ text: 'Approve only if token supply is above 1M.' });
    const ts = byType(atoms, 'token_supply');
    expect(ts[0]).toMatchObject({ op: 'gt', value: 1_000_000 });
  });

  it('extracts mint_decimals', () => {
    const { atoms } = extractAtoms({ text: 'Deny if decimals = 0.' });
    const md = byType(atoms, 'mint_decimals');
    expect(md[0]).toMatchObject({ op: 'eq', value: 0 });
  });

  it('extracts wallet_age_onchain from "wallet age above 7 days"', () => {
    const { atoms } = extractAtoms({ text: 'Approve only if wallet age above 7 days.' });
    const wa = byType(atoms, 'wallet_age_onchain');
    expect(wa[0]).toMatchObject({ op: 'gt', value: 7 * 86_400 });
  });

  it('extracts wallet_age_onchain from "wallet was created less than 30 days ago"', () => {
    const { atoms } = extractAtoms({ text: 'Deny if my wallet was created less than 30 days ago.' });
    const wa = byType(atoms, 'wallet_age_onchain');
    expect(wa[0]).toMatchObject({ op: 'lt', value: 30 * 86_400 });
  });

  it('extracts recipient_known with expected=false for "new address"', () => {
    const { atoms } = extractAtoms({ text: 'Deny if recipient is a new address.' });
    const rk = byType(atoms, 'recipient_known');
    expect(rk[0]).toMatchObject({ expected: false });
  });

  it('extracts recipient_known with expected=true for "sent to before"', () => {
    const { atoms } = extractAtoms({ text: 'Approve only if I have sent to this recipient before.' });
    const rk = byType(atoms, 'recipient_known');
    expect(rk[0]).toMatchObject({ expected: true });
  });

  it('extracts token_held_duration', () => {
    const { atoms } = extractAtoms({ text: 'Approve only if I have held JUP for more than 7 days.' });
    const thd = byType(atoms, 'token_held_duration');
    expect(thd[0]).toMatchObject({ subject: 'JUP', op: 'gt', value: 7 * 86_400 });
  });
});

describe('extractAtoms — Tier 3: required_signatures / instruction_count / writability / rent / epoch_warmup', () => {
  it('extracts required_signatures from "signatures > 1"', () => {
    const { atoms } = extractAtoms({ text: 'Deny if required signatures > 1.' });
    const rs = byType(atoms, 'required_signatures');
    expect(rs[0]).toMatchObject({ op: 'gt', value: 1 });
  });

  it('extracts required_signatures from "more than one signer"', () => {
    const { atoms } = extractAtoms({ text: 'Deny if more than one signer.' });
    const rs = byType(atoms, 'required_signatures');
    expect(rs[0]).toMatchObject({ op: 'gt', value: 1 });
  });

  it('extracts instruction_count', () => {
    const { atoms } = extractAtoms({ text: 'Deny if tx has more than 8 instructions.' });
    const ic = byType(atoms, 'instruction_count');
    expect(ic[0]).toMatchObject({ op: 'gt', value: 8 });
  });

  it('extracts account_writability_count', () => {
    const { atoms } = extractAtoms({ text: 'Deny if more than 5 writable accounts.' });
    const aw = byType(atoms, 'account_writability_count');
    expect(aw[0]).toMatchObject({ op: 'gt', value: 5 });
  });

  it('extracts rent_exempt_required', () => {
    const { atoms } = extractAtoms({ text: 'Deny if rent above 0.01 SOL.' });
    const re = byType(atoms, 'rent_exempt_required');
    expect(re[0]).toMatchObject({ op: 'gt', value: 0.01, unit: 'SOL' });
  });

  it('maps "first 5% of epoch" → network_metric epoch_progress_pct lt 5', () => {
    const { atoms } = extractAtoms({ text: 'Deny if we are in the first 5% of a new epoch.' });
    const nm = byType(atoms, 'network_metric');
    const epoch = nm.find((a) => a.metric === 'epoch_progress_pct');
    expect(epoch).toMatchObject({ op: 'lt', value: 5 });
  });

  it('maps bare "epoch warmup" → epoch_progress_pct lt 5 (default 5%)', () => {
    const { atoms } = extractAtoms({ text: 'Deny during epoch warmup.' });
    const nm = byType(atoms, 'network_metric');
    expect(nm.some((a) => a.metric === 'epoch_progress_pct' && a.op === 'lt')).toBe(true);
  });
});

describe('looksLikePolicyWithoutAtoms', () => {
  it('returns false when atoms were extracted', () => {
    expect(looksLikePolicyWithoutAtoms('SOL above $80', [{ id: 'x', type: 'price', rawText: '', subject: 'SOL', op: 'gt', value: 80, unit: 'USD' }])).toBe(false);
  });

  it('returns true for clear policy-like text with no atoms', () => {
    expect(looksLikePolicyWithoutAtoms('approve only if it is a low-cap meme coin under $100', [])).toBe(true);
    expect(looksLikePolicyWithoutAtoms('deny when the token is newer than a week', [])).toBe(true);
  });

  it('returns false for prose that is neither conditional nor comparative', () => {
    expect(looksLikePolicyWithoutAtoms('please prepare the swap and review it', [])).toBe(false);
  });
});

describe('extractAtomsWithLlmFallback', () => {
  it('returns regex atoms when the regex extractor succeeds (no LLM call)', async () => {
    const llm = vi.fn(async () => [] as AgentAtom[]);
    const result = await extractAtomsWithLlmFallback({ text: 'SOL above $80' }, { llm });
    expect(result.atoms).toHaveLength(1);
    expect(llm).not.toHaveBeenCalled();
  });

  it('calls the LLM when regex returns nothing AND text looks policy-like', async () => {
    const llm = vi.fn(async () => [
      { id: 'atom.token_audit.is_verified.true', type: 'token_audit', rawText: 'verified', field: 'is_verified', expected: true },
    ] as AgentAtom[]);
    const result = await extractAtomsWithLlmFallback(
      { text: 'approve only if the token is a verified low-cap meme coin under $100' },
      { llm },
    );
    expect(llm).toHaveBeenCalledOnce();
    expect(result.atoms).toHaveLength(1);
  });

  it('skips the LLM when text does not look policy-like', async () => {
    const llm = vi.fn(async () => [{ id: 'x', type: 'price' }] as unknown as AgentAtom[]);
    await extractAtomsWithLlmFallback({ text: 'please prepare a swap' }, { llm });
    expect(llm).not.toHaveBeenCalled();
  });

  it('swallows LLM errors and returns the regex result', async () => {
    const llm = vi.fn(async () => { throw new Error('rate limited'); });
    const result = await extractAtomsWithLlmFallback(
      { text: 'approve only if the token is a verified meme coin under $100' },
      { llm },
    );
    expect(result.atoms).toHaveLength(0);
  });

  it('deduplicates atoms returned by the LLM by id', async () => {
    const llm = vi.fn(async () => [
      { id: 'a', type: 'price', rawText: '', subject: 'X', op: 'gt', value: 1, unit: 'USD' },
      { id: 'a', type: 'price', rawText: '', subject: 'X', op: 'gt', value: 1, unit: 'USD' },
      { id: 'b', type: 'tx_gate', rawText: '', rule: 'no_extra_transfers' },
    ] as AgentAtom[]);
    const result = await extractAtomsWithLlmFallback(
      { text: 'approve only if X > $1' },
      { llm },
    );
    // Both regex and llm-merging dedup paths produce 2 unique atoms here. Regex may catch
    // X > $1 if X is a known symbol; if not, LLM merges its 2 unique ids.
    expect(new Set(result.atoms.map((atom) => atom.id)).size).toBe(result.atoms.length);
  });
});

/* -------------------------------------------------------------------------- */
/* Tier S/A/C: drain defenses, spending governance, temporal policy            */
/* -------------------------------------------------------------------------- */

describe('extractAtoms — Tier S drain defenses', () => {
  it('extracts sets_authority from "no authority changes"', () => {
    const { atoms } = extractAtoms({ text: 'deny if tx changes any authority' });
    const sa = byType(atoms, 'sets_authority');
    expect(sa).toHaveLength(1);
    expect(sa[0]).toMatchObject({ expected: false });
  });

  it('extracts sets_authority from "no mint authority changes"', () => {
    const { atoms } = extractAtoms({ text: 'no mint authority changes' });
    expect(byType(atoms, 'sets_authority').length).toBeGreaterThan(0);
  });

  it('extracts delegates_token with onlyUnlimited=true for "no unlimited approvals"', () => {
    const { atoms } = extractAtoms({ text: 'no unlimited approvals' });
    const dt = byType(atoms, 'delegates_token');
    expect(dt).toHaveLength(1);
    expect(dt[0]).toMatchObject({ expected: false, onlyUnlimited: true });
  });

  it('extracts delegates_token general form for "no token approvals"', () => {
    const { atoms } = extractAtoms({ text: 'no token approvals' });
    const dt = byType(atoms, 'delegates_token');
    expect(dt.length).toBeGreaterThan(0);
    expect(dt[0]).toMatchObject({ expected: false });
    expect(dt[0]!.onlyUnlimited).toBeFalsy();
  });

  it('extracts closes_account from "no account closures"', () => {
    const { atoms } = extractAtoms({ text: 'no account closures' });
    expect(byType(atoms, 'closes_account')).toHaveLength(1);
    expect(byType(atoms, 'closes_account')[0]).toMatchObject({ expected: false });
  });

  it('extracts closes_account from "deny if tx closes any account"', () => {
    const { atoms } = extractAtoms({ text: 'deny if tx closes any account' });
    expect(byType(atoms, 'closes_account').length).toBeGreaterThan(0);
  });
});

describe('extractAtoms — Tier A spending governance', () => {
  it('extracts daily_outflow_sum from "daily outflow below $500"', () => {
    const { atoms } = extractAtoms({ text: 'daily outflow below $500' });
    const dof = byType(atoms, 'daily_outflow_sum');
    expect(dof).toHaveLength(1);
    expect(dof[0]).toMatchObject({ op: 'lt', value: 500, unit: 'USD', windowSeconds: 86_400 });
  });

  it('extracts daily_outflow_sum from "24h outflow under 5 SOL"', () => {
    const { atoms } = extractAtoms({ text: '24h outflow under 5 SOL' });
    const dof = byType(atoms, 'daily_outflow_sum');
    expect(dof).toHaveLength(1);
    expect(dof[0]).toMatchObject({ op: 'lt', value: 5, unit: 'SOL' });
  });

  it('extracts daily_outflow_sum from "spent less than 5 SOL today"', () => {
    const { atoms } = extractAtoms({ text: 'spent less than 5 SOL today' });
    const dof = byType(atoms, 'daily_outflow_sum');
    expect(dof.length).toBeGreaterThan(0);
    expect(dof[0]).toMatchObject({ op: 'lt', value: 5, unit: 'SOL' });
  });

  it('extracts cooldown_since_last_tx from "last tx > 1 min ago"', () => {
    const { atoms } = extractAtoms({ text: 'last tx > 1 min ago' });
    const cd = byType(atoms, 'cooldown_since_last_tx');
    expect(cd).toHaveLength(1);
    expect(cd[0]).toMatchObject({ op: 'gt', value: 60 });
  });

  it('extracts cooldown_since_last_tx from "cooldown 30s"', () => {
    const { atoms } = extractAtoms({ text: 'cooldown 30s' });
    const cd = byType(atoms, 'cooldown_since_last_tx');
    expect(cd).toHaveLength(1);
    expect(cd[0]).toMatchObject({ op: 'gte', value: 30 });
  });

  it('extracts cooldown_since_last_tx from "at least 60s between txs"', () => {
    const { atoms } = extractAtoms({ text: 'at least 60s between txs' });
    const cd = byType(atoms, 'cooldown_since_last_tx');
    expect(cd.length).toBeGreaterThan(0);
    expect(cd[0]).toMatchObject({ op: 'gte', value: 60 });
  });

  it('extracts recent_blockhash_age_ms from "blockhash < 50s"', () => {
    const { atoms } = extractAtoms({ text: 'blockhash < 50s' });
    const bh = byType(atoms, 'recent_blockhash_age_ms');
    expect(bh).toHaveLength(1);
    expect(bh[0]).toMatchObject({ op: 'lt', value: 50_000 });
  });

  it('extracts recent_blockhash_age_ms from "no stale blockhash"', () => {
    const { atoms } = extractAtoms({ text: 'no stale blockhash' });
    const bh = byType(atoms, 'recent_blockhash_age_ms');
    expect(bh.length).toBeGreaterThan(0);
    expect(bh[0]).toMatchObject({ op: 'lt', value: 60_000 });
  });
});

describe('extractAtoms — Tier C temporal policy', () => {
  it('extracts time_of_day from "between 9am and 5pm"', () => {
    const { atoms } = extractAtoms({ text: 'only between 9am and 5pm' });
    const tod = byType(atoms, 'time_of_day');
    expect(tod).toHaveLength(1);
    expect(tod[0]).toMatchObject({ start: 9, end: 17, expected: true });
  });

  it('extracts time_of_day from "trading hours only"', () => {
    const { atoms } = extractAtoms({ text: 'trading hours only' });
    const tod = byType(atoms, 'time_of_day');
    expect(tod.length).toBeGreaterThan(0);
    expect(tod[0]).toMatchObject({ start: 9, end: 17, expected: true });
  });

  it('extracts time_of_day from "no trades after 5pm"', () => {
    const { atoms } = extractAtoms({ text: 'no trades after 5pm' });
    const tod = byType(atoms, 'time_of_day');
    expect(tod.length).toBeGreaterThan(0);
    // "no trades after 5pm" → allowed window is [0, 5pm); the inWindow comparison gives true
    // when current time falls within the allowed range.
    expect(tod[0]).toMatchObject({ start: 0, end: 17 });
  });

  it('extracts day_of_week_window from "no weekends"', () => {
    const { atoms } = extractAtoms({ text: 'no weekends' });
    const dow = byType(atoms, 'day_of_week_window');
    expect(dow).toHaveLength(1);
    expect(dow[0]).toMatchObject({ allowedDays: [1, 2, 3, 4, 5], expected: true });
  });

  it('extracts day_of_week_window from "only weekdays"', () => {
    const { atoms } = extractAtoms({ text: 'only weekdays' });
    const dow = byType(atoms, 'day_of_week_window');
    expect(dow.length).toBeGreaterThan(0);
    expect(dow[0]).toMatchObject({ allowedDays: [1, 2, 3, 4, 5] });
  });

  it('extracts day_of_week_window from "only Mon-Fri"', () => {
    const { atoms } = extractAtoms({ text: 'only Mon-Fri' });
    const dow = byType(atoms, 'day_of_week_window');
    expect(dow.length).toBeGreaterThan(0);
    expect(dow[0]?.allowedDays).toEqual([1, 2, 3, 4, 5]);
  });

  it('extracts day_of_week_window from "no Sat/Sun"', () => {
    const { atoms } = extractAtoms({ text: 'no Sat/Sun' });
    const dow = byType(atoms, 'day_of_week_window');
    expect(dow.length).toBeGreaterThan(0);
    expect(new Set(dow[0]?.allowedDays ?? [])).toEqual(new Set([1, 2, 3, 4, 5]));
  });

  it('extracts day_of_week_window from "no Saturdays and Sundays"', () => {
    const { atoms } = extractAtoms({ text: 'no Saturdays and Sundays' });
    const dow = byType(atoms, 'day_of_week_window');
    expect(dow.length).toBeGreaterThan(0);
    expect(new Set(dow[0]?.allowedDays ?? [])).toEqual(new Set([1, 2, 3, 4, 5]));
  });

  it('extracts day_of_week_window from "only Mon, Wed, Fri"', () => {
    const { atoms } = extractAtoms({ text: 'only Mon, Wed, Fri' });
    const dow = byType(atoms, 'day_of_week_window');
    expect(dow.length).toBeGreaterThan(0);
    expect(dow[0]?.allowedDays).toEqual([1, 3, 5]);
  });

  it('extracts day_of_week_window from "only Mon and Wed and Fri"', () => {
    const { atoms } = extractAtoms({ text: 'only Mon and Wed and Fri' });
    const dow = byType(atoms, 'day_of_week_window');
    expect(dow.length).toBeGreaterThan(0);
    expect(dow[0]?.allowedDays).toEqual([1, 3, 5]);
  });
});

describe('token_metric extraction', () => {
  function metric(text: string) {
    return byType(extractAtoms({ text }).atoms, 'token_metric');
  }

  it('extracts liquidity / market cap / fdv / volume USD gates with k/m/b suffixes', () => {
    expect(metric('approve only if liquidity > $100k')[0]).toMatchObject({ field: 'liquidity', op: 'gt', value: 100_000 });
    expect(metric('deny if market cap is below $1M')[0]).toMatchObject({ field: 'market_cap', op: 'lt', value: 1_000_000 });
    expect(metric('only if fdv above $5m')[0]).toMatchObject({ field: 'fdv', op: 'gt', value: 5_000_000 });
    expect(metric('require 24h volume over $50k')[0]).toMatchObject({ field: 'volume_24h', op: 'gt', value: 50_000 });
  });

  it('extracts holder count + top-holder concentration', () => {
    expect(metric('approve only if holders > 1000')[0]).toMatchObject({ field: 'holder_count', op: 'gt', value: 1000 });
    expect(metric('only if more than 2,500 holders')[0]).toMatchObject({ field: 'holder_count', value: 2500 });
    expect(metric('deny if top holder owns more than 20%')[0]).toMatchObject({ field: 'top_holder_pct', op: 'gt', value: 20 });
    expect(metric('top 10 holders below 50%')[0]).toMatchObject({ field: 'top_holder_pct', op: 'lt', value: 50 });
  });

  it('encodes 24h price change as the approve-safe threshold', () => {
    expect(metric('approve only if not down more than 25% today')[0]).toMatchObject({ field: 'price_change_24h', op: 'gte', value: -25 });
    expect(metric('only if up at least 5%')[0]).toMatchObject({ field: 'price_change_24h', op: 'gte', value: 5 });
  });

  it('maps organic score label to a numeric threshold', () => {
    expect(metric('approve only if organic score is high')[0]).toMatchObject({ field: 'organic_score', op: 'gte', value: 70 });
    expect(metric('require organic score above 60')[0]).toMatchObject({ field: 'organic_score', op: 'gt', value: 60 });
  });

  it('does NOT hijack "total market cap" (that stays a market_regime atom)', () => {
    const { atoms } = extractAtoms({ text: 'approve only if total crypto market cap is above $2T' });
    expect(byType(atoms, 'token_metric')).toHaveLength(0);
    expect(byType(atoms, 'market_regime').some((a) => a.subject === 'total_market_cap')).toBe(true);
  });

  it('produces stable ids', () => {
    expect(metric('liquidity > $100k')[0]?.id).toBe('atom.token_metric.liquidity.gt.100000');
  });
});

describe('coin_metric extraction', () => {
  function metric(text: string) {
    return byType(extractAtoms({ text }).atoms, 'coin_metric');
  }

  it('extracts market-cap rank from "rank < N" and "top N by market cap"', () => {
    expect(metric('approve only if market cap rank < 100')[0]).toMatchObject({ field: 'market_cap_rank', op: 'lt', value: 100 });
    expect(metric('only if ranked under 50')[0]).toMatchObject({ field: 'market_cap_rank', op: 'lt', value: 50 });
    expect(metric('require it to be in the top 100 by market cap')[0]).toMatchObject({ field: 'market_cap_rank', op: 'lte', value: 100 });
  });

  it('does NOT also create a token_metric market_cap atom for "market cap rank"', () => {
    const { atoms } = extractAtoms({ text: 'approve only if market cap rank < 100' });
    expect(byType(atoms, 'token_metric').filter((a) => a.field === 'market_cap')).toHaveLength(0);
    expect(byType(atoms, 'coin_metric')).toHaveLength(1);
  });

  it('encodes ATH distance as a signed % threshold', () => {
    expect(metric('approve only if down at least 50% from its ATH')[0]).toMatchObject({ field: 'ath_change_pct', op: 'lte', value: -50 });
    expect(metric('deny if within 10% of all-time high')[0]).toMatchObject({ field: 'ath_change_pct', op: 'gte', value: -10 });
  });

  it('extracts max / circulating supply with suffixes', () => {
    expect(metric('only if max supply under 1B')[0]).toMatchObject({ field: 'max_supply', op: 'lt', value: 1_000_000_000 });
    expect(metric('require circulating supply over 500m')[0]).toMatchObject({ field: 'circulating_supply', op: 'gt', value: 500_000_000 });
  });

  it('produces stable ids', () => {
    expect(metric('market cap rank < 100')[0]?.id).toBe('atom.coin_metric.market_cap_rank.lt.100');
  });
});
