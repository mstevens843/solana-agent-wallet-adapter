import { describe, expect, it } from 'vitest';

import { evaluateSimulationOutcome, type SimulationInputs } from '../simulationOutcome.js';

const WALLET = 'Wallet1111111111111111111111111111111111111';
const VERIFIED_PROGRAM = '11111111111111111111111111111111'; // System program
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const UNKNOWN_PROGRAM = 'UnknownProgram11111111111111111111111111111';

function baseInput(overrides: Partial<SimulationInputs> = {}): SimulationInputs {
  return {
    result: { err: null, logs: ['ok'], accounts: null, unitsConsumed: 1500 },
    preWalletLamports: null,
    postWalletLamports: null,
    walletAddress: WALLET,
    planSolLamports: null,
    writableProgramIds: [VERIFIED_PROGRAM],
    ...overrides,
  };
}

describe('evaluateSimulationOutcome', () => {
  it('happy path: ok state when all checks pass', () => {
    const out = evaluateSimulationOutcome(baseInput());
    expect(out.state).toBe('ok');
    expect(out.summary).toMatch(/passed/i);
    expect((out.detail.findings as Array<{ severity: string }>).every((f) => f.severity === 'info')).toBe(true);
  });

  it('rule 1: tx revert → state fail + block finding', () => {
    const out = evaluateSimulationOutcome(baseInput({
      result: { err: { InstructionError: [0, 'Custom(6000)'] }, logs: ['x'], accounts: null, unitsConsumed: 100 },
    }));
    expect(out.state).toBe('fail');
    const findings = out.detail.findings as Array<{ label: string; severity: string }>;
    expect(findings.some((f) => f.label === 'Simulation error' && f.severity === 'block')).toBe(true);
  });

  it('rule 2: unknown writable program → state fail + block finding', () => {
    const out = evaluateSimulationOutcome(baseInput({
      writableProgramIds: [VERIFIED_PROGRAM, UNKNOWN_PROGRAM],
    }));
    expect(out.state).toBe('fail');
    const findings = out.detail.findings as Array<{ label: string; severity: string; value: string }>;
    const unknown = findings.find((f) => f.label === 'Unknown writable program(s)');
    expect(unknown).toBeDefined();
    expect(unknown?.severity).toBe('block');
    expect(unknown?.value).toContain(UNKNOWN_PROGRAM);
  });

  it('rule 3: wallet SOL outflow exceeds plan + fee tolerance → state fail', () => {
    // Plan says send 0.5 SOL (500_000_000 lamports). Simulation shows 2 SOL outflow.
    const out = evaluateSimulationOutcome(baseInput({
      preWalletLamports: 5_000_000_000,
      postWalletLamports: 3_000_000_000,
      planSolLamports: 500_000_000,
    }));
    expect(out.state).toBe('fail');
    const findings = out.detail.findings as Array<{ label: string; severity: string }>;
    expect(findings.some((f) => f.label === 'Wallet SOL balance drift' && f.severity === 'block')).toBe(true);
  });

  it('rule 3: small drift within tolerance does not fail', () => {
    // Plan says send 0.5 SOL (500_000_000). Simulation shows 0.5 SOL + 5000 lamports fee.
    const out = evaluateSimulationOutcome(baseInput({
      preWalletLamports: 5_000_000_000,
      postWalletLamports: 5_000_000_000 - 500_000_000 - 5_000,
      planSolLamports: 500_000_000,
    }));
    expect(out.state).toBe('ok');
  });

  it('rule 4: token account ownership flipped away from wallet → state fail', () => {
    const ata = 'AtaToken11111111111111111111111111111111111';
    const out = evaluateSimulationOutcome(baseInput({
      preTokenAccounts: [{ pubkey: ata, owner: WALLET }],
      postTokenAccounts: [{ pubkey: ata, owner: 'Attacker1111111111111111111111111111111111' }],
    }));
    expect(out.state).toBe('fail');
    const findings = out.detail.findings as Array<{ label: string; severity: string; value: string }>;
    const flip = findings.find((f) => f.label === 'Token account ownership flip');
    expect(flip).toBeDefined();
    expect(flip?.severity).toBe('block');
    expect(flip?.value).toContain(ata);
  });

  it('rule 4: same owner → no flip flagged', () => {
    const ata = 'AtaToken11111111111111111111111111111111111';
    const out = evaluateSimulationOutcome(baseInput({
      preTokenAccounts: [{ pubkey: ata, owner: WALLET }],
      postTokenAccounts: [{ pubkey: ata, owner: WALLET }],
    }));
    expect(out.state).toBe('ok');
  });

  it('multiple block findings co-exist; top state is fail', () => {
    const out = evaluateSimulationOutcome(baseInput({
      result: { err: 'BlockhashNotFound', logs: null, accounts: null, unitsConsumed: 0 },
      writableProgramIds: [UNKNOWN_PROGRAM],
    }));
    expect(out.state).toBe('fail');
    const findings = out.detail.findings as Array<{ severity: string }>;
    expect(findings.filter((f) => f.severity === 'block').length).toBeGreaterThanOrEqual(2);
  });

  it('verified writable programs (System, Token) pass cleanly', () => {
    const out = evaluateSimulationOutcome(baseInput({
      writableProgramIds: [VERIFIED_PROGRAM, TOKEN_PROGRAM],
    }));
    expect(out.state).toBe('ok');
  });

  it('includes logs tail and unitsConsumed in detail when present', () => {
    const out = evaluateSimulationOutcome(baseInput({
      result: { err: null, logs: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], accounts: null, unitsConsumed: 8000 },
    }));
    expect(out.detail.unitsConsumed).toBe(8000);
    expect(out.detail.logsTail).toEqual(['c', 'd', 'e', 'f', 'g']);
  });
});
