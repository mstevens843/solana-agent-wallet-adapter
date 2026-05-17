/**
 * Deterministic transaction-gate analyzers.
 *
 * Each gate is a pure function over a SimulationDigest (extracted from the
 * RPC `simulateTransaction` response) + a TxGateContext (allowlists and
 * action-type hints). The reviewer LLM no longer has to interpret raw
 * simulation output for these gates — the analyzer returns a structured
 * pass/fail outcome with the rule that decided it.
 *
 * Posture: fail-closed. When inputs are missing, ambiguous, or the
 * simulation itself errored, the gate returns `pass: false` with a reason
 * explaining what was unverifiable, NOT a silent pass.
 *
 * Out of scope (per current design):
 *   - `no_unknown_recipients` — the project does not yet store an "allowed
 *     recipients" list per wallet, so this gate would always fail-closed
 *     until that store exists. Skipped here.
 */

import type { TxGateRule } from './agentAtoms.js';

/* -------------------------------------------------------------------------- */
/* Inputs                                                                     */
/* -------------------------------------------------------------------------- */

export interface SimulationDigest {
  /** True when the RPC reported the simulation succeeded (no `err`). */
  ok: boolean;
  /** Program ids invoked at the top level of the transaction's message. */
  invokedPrograms: ReadonlyArray<string>;
  /** Program ids invoked anywhere (top-level + CPI), derived from program-id logs.
   *  Optional — fall back to `invokedPrograms` when not available. */
  invokedAndInnerPrograms?: ReadonlyArray<string>;
  /** Program logs from the simulation. Used to count transfer instructions. */
  logs: ReadonlyArray<string>;
  /** Optional RPC error string when simulation failed. */
  error?: string;
}

export interface TxGateContext {
  /** Programs the caller considers expected for the action type. */
  allowedPrograms: ReadonlySet<string>;
  /** Set of swap entrypoint program ids (e.g. Jupiter Aggregator). When the action is a swap,
   *  `only_requested_swap` requires at least one of these to be invoked. */
  swapProgramIds?: ReadonlySet<string>;
  /** Whether the draft action is a swap. Affects the interpretation of `no_extra_transfers`. */
  isSwap?: boolean;
  /** When the action is an SPL transfer, the expected count of SPL transfers (typically 1). */
  expectedSplTransfers?: number;
  /** When the action involves SOL movement, the expected count of System Program transfers. */
  expectedSolTransfers?: number;
}

export interface TxGateOutcome {
  rule: TxGateRule;
  pass: boolean;
  reason: string;
  /** Optional structured detail for UX/audit. */
  detail?: Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/* Log parsing helpers                                                        */
/* -------------------------------------------------------------------------- */

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const SPL_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SPL_TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/** Match "Program <id> invoke [<depth>]" lines and capture the program id. */
const PROGRAM_INVOKE_RE = /Program\s+([1-9A-HJ-NP-Za-km-z]{32,44})\s+invoke\s*\[/;

/** Match "Instruction: <Name>" log lines and capture the instruction name. */
const INSTRUCTION_LOG_RE = /Program log:\s*Instruction:\s*([A-Za-z][A-Za-z0-9]*)\b/;

/** A single (program, instruction-name) pair extracted from the logs in order. */
interface InstructionEvent {
  program: string;
  instruction: string;
}

/**
 * Walk the simulation logs and pair each `Instruction: <Name>` log line with its
 * enclosing program invoke. Stack-based to handle CPIs: the most recently invoked
 * program is the one that emitted the next `Instruction:` log.
 */
function extractInstructionEvents(logs: ReadonlyArray<string>): InstructionEvent[] {
  const stack: string[] = [];
  const events: InstructionEvent[] = [];
  for (const line of logs) {
    const invoke = PROGRAM_INVOKE_RE.exec(line);
    if (invoke && invoke[1]) {
      stack.push(invoke[1]);
      continue;
    }
    if (/Program\s+[1-9A-HJ-NP-Za-km-z]{32,44}\s+success/.test(line) || /Program\s+[1-9A-HJ-NP-Za-km-z]{32,44}\s+failed/.test(line)) {
      stack.pop();
      continue;
    }
    const instr = INSTRUCTION_LOG_RE.exec(line);
    if (instr && instr[1] && stack.length > 0) {
      events.push({ program: stack[stack.length - 1]!, instruction: instr[1] });
    }
  }
  return events;
}

function countSystemSolTransfers(logs: ReadonlyArray<string>): number {
  const events = extractInstructionEvents(logs);
  return events.filter((evt) => evt.program === SYSTEM_PROGRAM_ID && /^Transfer$/i.test(evt.instruction)).length;
}

function countSplTransfers(logs: ReadonlyArray<string>): number {
  const events = extractInstructionEvents(logs);
  return events.filter((evt) =>
    (evt.program === SPL_TOKEN_PROGRAM_ID || evt.program === SPL_TOKEN_2022_PROGRAM_ID) &&
    /^Transfer(Checked)?$/i.test(evt.instruction),
  ).length;
}

function programIdsFromLogs(logs: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  for (const line of logs) {
    const match = PROGRAM_INVOKE_RE.exec(line);
    if (match && match[1]) seen.add(match[1]);
  }
  return Array.from(seen);
}

/** Returns the union of explicit `invokedAndInnerPrograms` (if provided) or log-derived ids,
 *  combined with the top-level `invokedPrograms`. */
function programIdsFromDigest(digest: SimulationDigest): string[] {
  const all = new Set<string>(digest.invokedPrograms);
  if (digest.invokedAndInnerPrograms) {
    for (const id of digest.invokedAndInnerPrograms) all.add(id);
  } else {
    for (const id of programIdsFromLogs(digest.logs)) all.add(id);
  }
  return Array.from(all);
}

/* -------------------------------------------------------------------------- */
/* Gate analyzers                                                             */
/* -------------------------------------------------------------------------- */

function failClosed(rule: TxGateRule, reason: string, detail?: Record<string, unknown>): TxGateOutcome {
  return { rule, pass: false, reason, detail };
}

function failedSimulationOutcome(rule: TxGateRule, digest: SimulationDigest): TxGateOutcome | undefined {
  if (digest.ok) return undefined;
  return failClosed(rule, `Simulation failed; cannot verify gate. RPC error: ${digest.error ?? 'unknown'}`);
}

/**
 * `no_unrelated_instructions` — every program invoked (top-level + CPI) must be on the
 * caller-supplied allowlist. Includes inner instructions, so a malicious CPI to an
 * unknown program is blocked even if the top-level message looks safe.
 */
export function noUnrelatedInstructions(digest: SimulationDigest, ctx: TxGateContext): TxGateOutcome {
  const rule: TxGateRule = 'no_unrelated_instructions';
  const simFail = failedSimulationOutcome(rule, digest);
  if (simFail) return simFail;
  const allPrograms = programIdsFromDigest(digest);
  const unknown = allPrograms.filter((id) => !ctx.allowedPrograms.has(id));
  if (unknown.length > 0) {
    return failClosed(rule, `Found unrelated program${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}.`, {
      unknownPrograms: unknown,
    });
  }
  return { rule, pass: true, reason: 'Only allowlisted programs were invoked.' };
}

/**
 * `no_extra_transfers` — counts System Program SOL transfers and SPL Token transfers, then
 * compares to the caller-stated expectation.
 *
 * Heuristics by action type:
 *   - For a SWAP: at most TWO System Program transfers (input wrap + output unwrap), unless
 *     the caller overrides via `expectedSolTransfers`. Any additional SOL transfer indicates
 *     value leaving the wallet outside the swap path.
 *   - For non-swap (transfer_sol/transfer_spl): use `expectedSolTransfers` / `expectedSplTransfers`
 *     directly (defaults to 1 of the matching kind).
 */
export function noExtraTransfers(digest: SimulationDigest, ctx: TxGateContext): TxGateOutcome {
  const rule: TxGateRule = 'no_extra_transfers';
  const simFail = failedSimulationOutcome(rule, digest);
  if (simFail) return simFail;

  const solCount = countSystemSolTransfers(digest.logs);
  const splCount = countSplTransfers(digest.logs);

  const expectedSol = ctx.expectedSolTransfers ?? (ctx.isSwap ? 2 : 0);
  const expectedSpl = ctx.expectedSplTransfers; // undefined → don't gate on SPL count

  const violations: string[] = [];
  if (solCount > expectedSol) {
    violations.push(`SOL transfers: observed ${solCount}, expected at most ${expectedSol}.`);
  }
  if (typeof expectedSpl === 'number' && splCount > expectedSpl) {
    violations.push(`SPL transfers: observed ${splCount}, expected at most ${expectedSpl}.`);
  }

  if (violations.length > 0) {
    return failClosed(rule, violations.join(' '), { solCount, splCount, expectedSol, expectedSpl });
  }
  return {
    rule,
    pass: true,
    reason: `SOL transfers ${solCount}/${expectedSol}, SPL transfers ${splCount}${typeof expectedSpl === 'number' ? `/${expectedSpl}` : ''}.`,
    detail: { solCount, splCount, expectedSol, expectedSpl },
  };
}

/**
 * `only_requested_swap` — composite gate.
 *   1. The simulation succeeded.
 *   2. At least one of the swap entrypoint programs was invoked.
 *   3. No unrelated programs were invoked.
 *   4. No extra transfers beyond the swap envelope.
 */
export function onlyRequestedSwap(digest: SimulationDigest, ctx: TxGateContext): TxGateOutcome {
  const rule: TxGateRule = 'only_requested_swap';
  const simFail = failedSimulationOutcome(rule, digest);
  if (simFail) return simFail;
  if (!ctx.swapProgramIds || ctx.swapProgramIds.size === 0) {
    return failClosed(rule, 'No swap program allowlist supplied; cannot verify a swap was the intent.');
  }
  const all = programIdsFromDigest(digest);
  const swapInvoked = all.some((id) => ctx.swapProgramIds!.has(id));
  if (!swapInvoked) {
    return failClosed(rule, 'No allowlisted swap program was invoked.', { invokedPrograms: all });
  }
  const unrelated = noUnrelatedInstructions(digest, ctx);
  if (!unrelated.pass) {
    return failClosed(rule, `Unrelated programs detected: ${unrelated.reason}`, unrelated.detail);
  }
  const transfers = noExtraTransfers(digest, { ...ctx, isSwap: true });
  if (!transfers.pass) {
    return failClosed(rule, `Extra transfers detected: ${transfers.reason}`, transfers.detail);
  }
  return { rule, pass: true, reason: 'Swap program invoked with no unrelated programs or extra transfers.' };
}

/* -------------------------------------------------------------------------- */
/* Dispatcher                                                                 */
/* -------------------------------------------------------------------------- */

export const TX_GATE_ANALYZERS: Readonly<Record<Exclude<TxGateRule, 'no_unknown_recipients'>, (digest: SimulationDigest, ctx: TxGateContext) => TxGateOutcome>> = Object.freeze({
  only_requested_swap: onlyRequestedSwap,
  no_extra_transfers: noExtraTransfers,
  no_unrelated_instructions: noUnrelatedInstructions,
});

/** Run the analyzer for a single rule. Returns undefined for unsupported rules. */
export function analyzeTxGate(rule: TxGateRule, digest: SimulationDigest, ctx: TxGateContext): TxGateOutcome | undefined {
  if (rule === 'no_unknown_recipients') return undefined; // not implemented yet (no allowed-recipient store)
  const fn = TX_GATE_ANALYZERS[rule];
  return fn ? fn(digest, ctx) : undefined;
}

/**
 * Run every supported tx-gate atom against a single simulation digest and return
 * outcomes keyed by atomId. Unsupported rules (currently only `no_unknown_recipients`)
 * are silently omitted from the result.
 */
export function analyzeTxGateAtoms(
  atoms: ReadonlyArray<{ id: string; rule: TxGateRule }>,
  digest: SimulationDigest,
  ctx: TxGateContext,
): Record<string, TxGateOutcome> {
  const out: Record<string, TxGateOutcome> = {};
  for (const atom of atoms) {
    const outcome = analyzeTxGate(atom.rule, digest, ctx);
    if (outcome) out[atom.id] = outcome;
  }
  return out;
}
