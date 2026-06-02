import { describe, expect, it } from 'vitest';

import {
  analyzeTxGate,
  analyzeTxGateAtoms,
  noExtraTransfers,
  noUnrelatedInstructions,
  onlyRequestedSwap,
  type SimulationDigest,
  type TxGateContext,
} from '../txGates.js';

const SYSTEM = '11111111111111111111111111111111';
const COMPUTE = 'ComputeBudget111111111111111111111111111111';
const SPL_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const JUPITER_AGGREGATOR = 'JUP6Lkbpx6mUwBmYDPDgyARyZHbphoenzefdNzqovxN3'; // Jupiter v6
const SCAM_PROGRAM = 'AttackerXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

const SWAP_ALLOWLIST: ReadonlySet<string> = new Set([SYSTEM, COMPUTE, SPL_TOKEN, ATA, JUPITER_AGGREGATOR]);
const SWAP_ENTRYPOINTS: ReadonlySet<string> = new Set([JUPITER_AGGREGATOR]);

function digest(partial: Partial<SimulationDigest>): SimulationDigest {
  return {
    ok: true,
    invokedPrograms: [],
    logs: [],
    ...partial,
  };
}

const cleanSwapDigest = digest({
  invokedPrograms: [COMPUTE, ATA, JUPITER_AGGREGATOR],
  invokedAndInnerPrograms: [COMPUTE, ATA, JUPITER_AGGREGATOR, SPL_TOKEN, SYSTEM],
  logs: [
    `Program ${COMPUTE} invoke [1]`,
    `Program ${COMPUTE} success`,
    `Program ${ATA} invoke [1]`,
    `Program ${SYSTEM} invoke [2]`,
    'Program log: Instruction: Transfer', // wrap SOL
    `Program ${SYSTEM} success`,
    `Program ${ATA} success`,
    `Program ${JUPITER_AGGREGATOR} invoke [1]`,
    `Program ${SPL_TOKEN} invoke [2]`,
    'Program log: Instruction: TransferChecked', // input → pool
    `Program ${SPL_TOKEN} success`,
    `Program ${SPL_TOKEN} invoke [2]`,
    'Program log: Instruction: TransferChecked', // pool → output
    `Program ${SPL_TOKEN} success`,
    `Program ${JUPITER_AGGREGATOR} success`,
    `Program ${SYSTEM} invoke [1]`,
    'Program log: Instruction: Transfer', // unwrap SOL
    `Program ${SYSTEM} success`,
  ],
});

const swapCtx: TxGateContext = {
  allowedPrograms: SWAP_ALLOWLIST,
  swapProgramIds: SWAP_ENTRYPOINTS,
  isSwap: true,
};

describe('noUnrelatedInstructions', () => {
  it('passes when every invoked program is on the allowlist', () => {
    const outcome = noUnrelatedInstructions(cleanSwapDigest, swapCtx);
    expect(outcome).toMatchObject({ rule: 'no_unrelated_instructions', pass: true });
  });

  it('fails when a non-allowlisted top-level program is invoked', () => {
    const dirty = digest({
      invokedPrograms: [COMPUTE, JUPITER_AGGREGATOR, SCAM_PROGRAM],
      logs: [`Program ${SCAM_PROGRAM} invoke [1]`, `Program ${SCAM_PROGRAM} success`],
    });
    const outcome = noUnrelatedInstructions(dirty, swapCtx);
    expect(outcome.pass).toBe(false);
    expect(outcome.reason).toContain(SCAM_PROGRAM);
    expect(outcome.detail?.unknownPrograms).toContain(SCAM_PROGRAM);
  });

  it('fails when an unknown program is invoked via CPI (inner instruction)', () => {
    const cpi = digest({
      invokedPrograms: [JUPITER_AGGREGATOR],
      logs: [
        `Program ${JUPITER_AGGREGATOR} invoke [1]`,
        `Program ${SCAM_PROGRAM} invoke [2]`,
        `Program ${SCAM_PROGRAM} success`,
        `Program ${JUPITER_AGGREGATOR} success`,
      ],
    });
    const outcome = noUnrelatedInstructions(cpi, swapCtx);
    expect(outcome.pass).toBe(false);
    expect(outcome.detail?.unknownPrograms).toContain(SCAM_PROGRAM);
  });

  it('fails closed when simulation itself failed', () => {
    const failed = digest({ ok: false, error: 'BlockhashNotFound', invokedPrograms: [JUPITER_AGGREGATOR] });
    const outcome = noUnrelatedInstructions(failed, swapCtx);
    expect(outcome.pass).toBe(false);
    expect(outcome.reason).toMatch(/Simulation failed/);
  });
});

describe('noExtraTransfers', () => {
  it('passes on a clean swap with 2 wrap/unwrap SOL transfers and 2 SPL transfers', () => {
    const outcome = noExtraTransfers(cleanSwapDigest, swapCtx);
    expect(outcome.pass).toBe(true);
    expect(outcome.detail).toMatchObject({ solCount: 2, splCount: 2, expectedSol: 2 });
  });

  it('fails when the swap envelope includes an extra System transfer beyond wrap/unwrap', () => {
    const sneaky = digest({
      ...cleanSwapDigest,
      logs: [
        ...cleanSwapDigest.logs,
        // Extra unauthorized SOL transfer (e.g. to attacker).
        `Program ${SYSTEM} invoke [1]`,
        'Program log: Instruction: Transfer',
        `Program ${SYSTEM} success`,
      ],
    });
    const outcome = noExtraTransfers(sneaky, swapCtx);
    expect(outcome.pass).toBe(false);
    expect(outcome.detail).toMatchObject({ solCount: 3, expectedSol: 2 });
  });

  it('passes a SOL transfer action with expectedSolTransfers=1', () => {
    const transferOnly = digest({
      invokedPrograms: [COMPUTE, SYSTEM],
      logs: [
        `Program ${COMPUTE} invoke [1]`,
        `Program ${COMPUTE} success`,
        `Program ${SYSTEM} invoke [1]`,
        'Program log: Instruction: Transfer',
        `Program ${SYSTEM} success`,
      ],
    });
    const outcome = noExtraTransfers(transferOnly, { allowedPrograms: new Set([SYSTEM, COMPUTE]), expectedSolTransfers: 1 });
    expect(outcome.pass).toBe(true);
  });

  it('fails an SPL transfer action that does an extra SPL transfer (skim attack)', () => {
    const skim = digest({
      invokedPrograms: [SPL_TOKEN],
      logs: [
        `Program ${SPL_TOKEN} invoke [1]`,
        'Program log: Instruction: Transfer',
        `Program ${SPL_TOKEN} success`,
        `Program ${SPL_TOKEN} invoke [1]`,
        'Program log: Instruction: Transfer',
        `Program ${SPL_TOKEN} success`,
      ],
    });
    const outcome = noExtraTransfers(skim, { allowedPrograms: new Set([SPL_TOKEN]), expectedSplTransfers: 1 });
    expect(outcome.pass).toBe(false);
    expect(outcome.detail).toMatchObject({ splCount: 2, expectedSpl: 1 });
  });

  it('does not miscount System Program CreateAccount as a Transfer', () => {
    const allocate = digest({
      invokedPrograms: [SYSTEM],
      logs: [
        `Program ${SYSTEM} invoke [1]`,
        'Program log: Instruction: CreateAccount',
        `Program ${SYSTEM} success`,
      ],
    });
    const outcome = noExtraTransfers(allocate, { allowedPrograms: new Set([SYSTEM]) });
    expect(outcome.detail).toMatchObject({ solCount: 0 });
  });
});

describe('onlyRequestedSwap', () => {
  it('passes a clean Jupiter-routed swap', () => {
    const outcome = onlyRequestedSwap(cleanSwapDigest, swapCtx);
    expect(outcome.pass).toBe(true);
  });

  it('fails if no swap entrypoint was invoked', () => {
    const noSwap = digest({
      invokedPrograms: [COMPUTE, SYSTEM],
      logs: [`Program ${SYSTEM} invoke [1]`, 'Program log: Instruction: Transfer', `Program ${SYSTEM} success`],
    });
    const outcome = onlyRequestedSwap(noSwap, swapCtx);
    expect(outcome.pass).toBe(false);
    expect(outcome.reason).toMatch(/swap program/i);
  });

  it('fails if simulation has a non-allowlisted CPI', () => {
    const cpi = digest({
      invokedPrograms: [JUPITER_AGGREGATOR],
      logs: [
        `Program ${JUPITER_AGGREGATOR} invoke [1]`,
        `Program ${SCAM_PROGRAM} invoke [2]`,
        `Program ${SCAM_PROGRAM} success`,
        `Program ${JUPITER_AGGREGATOR} success`,
      ],
    });
    const outcome = onlyRequestedSwap(cpi, swapCtx);
    expect(outcome.pass).toBe(false);
    expect(outcome.reason).toMatch(/Unrelated programs/);
  });

  it('fails closed when no swap entrypoint set is provided', () => {
    const outcome = onlyRequestedSwap(cleanSwapDigest, { allowedPrograms: SWAP_ALLOWLIST });
    expect(outcome.pass).toBe(false);
  });
});

describe('analyzeTxGate dispatcher', () => {
  it('routes each supported rule to the right analyzer', () => {
    expect(analyzeTxGate('only_requested_swap', cleanSwapDigest, swapCtx)?.pass).toBe(true);
    expect(analyzeTxGate('no_extra_transfers', cleanSwapDigest, swapCtx)?.pass).toBe(true);
    expect(analyzeTxGate('no_unknown_recipients', cleanSwapDigest, swapCtx)?.pass).toBe(false);
    expect(analyzeTxGate('no_unrelated_instructions', cleanSwapDigest, swapCtx)?.pass).toBe(true);
  });

  it('fails no_unknown_recipients closed until recipient context is available', () => {
    const outcome = analyzeTxGate('no_unknown_recipients', cleanSwapDigest, swapCtx);
    expect(outcome).toMatchObject({
      rule: 'no_unknown_recipients',
      pass: false,
    });
    expect(outcome?.reason).toMatch(/cannot verify/i);
  });
});

describe('analyzeTxGateAtoms (batch)', () => {
  it('runs every supported atom and keys outcomes by atomId', () => {
    const atoms = [
      { id: 'atom.tx_gate.only_requested_swap', rule: 'only_requested_swap' as const },
      { id: 'atom.tx_gate.no_extra_transfers', rule: 'no_extra_transfers' as const },
      { id: 'atom.tx_gate.no_unrelated_instructions', rule: 'no_unrelated_instructions' as const },
      { id: 'atom.tx_gate.no_unknown_recipients', rule: 'no_unknown_recipients' as const },
    ];
    const outcomes = analyzeTxGateAtoms(atoms, cleanSwapDigest, swapCtx);
    expect(Object.keys(outcomes).sort()).toEqual([
      'atom.tx_gate.no_extra_transfers',
      'atom.tx_gate.no_unknown_recipients',
      'atom.tx_gate.no_unrelated_instructions',
      'atom.tx_gate.only_requested_swap',
    ]);
    expect(outcomes['atom.tx_gate.no_unknown_recipients']?.pass).toBe(false);
    expect(outcomes['atom.tx_gate.only_requested_swap']?.pass).toBe(true);
    expect(outcomes['atom.tx_gate.no_extra_transfers']?.pass).toBe(true);
    expect(outcomes['atom.tx_gate.no_unrelated_instructions']?.pass).toBe(true);
  });
});
