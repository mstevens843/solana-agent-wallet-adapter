import { isVerifiedProgramId } from '@solana-agent-wallet-adapter/workflow';

export type SimulationOutcomeState = 'ok' | 'checked' | 'warn' | 'missing' | 'fail';

export interface SimulationEvidenceFinding {
  label: string;
  value: string;
  tone: 'good' | 'warn' | 'fail' | 'neutral';
  severity: 'info' | 'warn' | 'block';
}

export interface SimulationEvaluationResult {
  state: SimulationOutcomeState;
  summary: string;
  detail: Record<string, unknown>;
}

export interface SimulationInputs {
  result: {
    err: unknown;
    logs: string[] | null | undefined;
    accounts?: Array<{ owner?: string | null; lamports?: number; data?: unknown } | null> | null;
    unitsConsumed?: number | null;
  };
  preWalletLamports: number | null;
  postWalletLamports: number | null;
  walletAddress: string;
  planSolLamports: number | null;
  preTokenAccounts?: Array<{ pubkey: string; owner: string }>;
  postTokenAccounts?: Array<{ pubkey: string; owner: string | null }>;
  writableProgramIds: string[];
}

const SOL_FEE_BUFFER_LAMPORTS = 10_000;
const SOL_DRIFT_TOLERANCE_FRACTION = 0.02;

const STATE_RANK: Record<SimulationOutcomeState, number> = {
  ok: 0,
  checked: 1,
  warn: 2,
  missing: 2,
  fail: 3,
};

function stateForRank(rank: number): SimulationOutcomeState {
  if (rank >= 3) return 'fail';
  if (rank >= 2) return 'warn';
  if (rank >= 1) return 'checked';
  return 'ok';
}

/**
 * Pure evaluator: feed in a simulated transaction's result plus expected wallet outflow,
 * receive a structured verdict. Used by the agent's `enrichSimulationFactsForAgent` to
 * turn raw RPC simulation output into evidence rows the gate can reason over.
 *
 * Block rules (any one triggers `state: 'fail'`):
 *   1. The simulator returned an error (tx would revert).
 *   2. The transaction writes to a program not on the verified allowlist.
 *   3. Wallet SOL outflow exceeds the plan amount + reasonable fee/slippage.
 *   4. A token account owned by the wallet has its owner flipped away from the wallet.
 */
export function evaluateSimulationOutcome(input: SimulationInputs): SimulationEvaluationResult {
  const findings: SimulationEvidenceFinding[] = [];
  let topStateRank = 0;
  const setTop = (state: SimulationOutcomeState): void => {
    const rank = STATE_RANK[state];
    if (rank > topStateRank) topStateRank = rank;
  };

  if (input.result.err !== null && input.result.err !== undefined) {
    const errSummary = typeof input.result.err === 'string' ? input.result.err : JSON.stringify(input.result.err);
    findings.push({
      label: 'Simulation error',
      value: `Transaction would fail: ${errSummary}`,
      tone: 'fail',
      severity: 'block',
    });
    setTop('fail');
  }

  const unknownWritablePrograms = input.writableProgramIds.filter((id) => !isVerifiedProgramId(id));
  if (unknownWritablePrograms.length > 0) {
    findings.push({
      label: 'Unknown writable program(s)',
      value: `Transaction writes to ${unknownWritablePrograms.length} program(s) not on the verified list: ${unknownWritablePrograms.join(', ')}`,
      tone: 'fail',
      severity: 'block',
    });
    setTop('fail');
  }

  if (input.preWalletLamports !== null && input.postWalletLamports !== null) {
    const delta = input.postWalletLamports - input.preWalletLamports;
    const expectedOutflow = (input.planSolLamports ?? 0) + SOL_FEE_BUFFER_LAMPORTS;
    const actualOutflow = Math.max(0, -delta);
    const tolerance = Math.max(expectedOutflow * SOL_DRIFT_TOLERANCE_FRACTION, SOL_FEE_BUFFER_LAMPORTS);
    if (actualOutflow > expectedOutflow + tolerance) {
      findings.push({
        label: 'Wallet SOL balance drift',
        value: `Simulation drains ${(actualOutflow / 1e9).toFixed(6)} SOL, more than the plan amount + fee (${(expectedOutflow / 1e9).toFixed(6)} SOL) by ${((actualOutflow - expectedOutflow) / 1e9).toFixed(6)} SOL.`,
        tone: 'fail',
        severity: 'block',
      });
      setTop('fail');
    }
  }

  if (input.preTokenAccounts && input.postTokenAccounts) {
    const preOwnerByPubkey = new Map(input.preTokenAccounts.map((entry) => [entry.pubkey, entry.owner]));
    const flipped: string[] = [];
    for (const post of input.postTokenAccounts) {
      const preOwner = preOwnerByPubkey.get(post.pubkey);
      if (preOwner === input.walletAddress && post.owner && post.owner !== input.walletAddress) {
        flipped.push(post.pubkey);
      }
    }
    if (flipped.length > 0) {
      findings.push({
        label: 'Token account ownership flip',
        value: `Transaction transfers ownership of ${flipped.length} token account(s) away from the connected wallet: ${flipped.join(', ')}`,
        tone: 'fail',
        severity: 'block',
      });
      setTop('fail');
    }
  }

  if (findings.length === 0) {
    findings.push({
      label: 'Simulation passed',
      value: 'No simulation errors, all writable programs verified, balance changes within expected bounds.',
      tone: 'good',
      severity: 'info',
    });
  }

  const topState = stateForRank(topStateRank);
  const summary = topState === 'fail'
    ? `Simulation blocked: ${findings.find((f) => f.severity === 'block')?.label ?? 'unknown reason'}`
    : 'Simulation passed all safety checks.';

  return {
    state: topState,
    summary,
    detail: {
      findings,
      writableProgramIds: input.writableProgramIds,
      unknownWritableProgramIds: unknownWritablePrograms,
      ...(typeof input.result.unitsConsumed === 'number' ? { unitsConsumed: input.result.unitsConsumed } : {}),
      ...(Array.isArray(input.result.logs) ? { logsTail: input.result.logs.slice(-5) } : {}),
    },
  };
}
