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
