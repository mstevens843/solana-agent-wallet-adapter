/**
 * Build a workflow `SimulationDigest` from a base64-encoded Solana transaction.
 *
 * Used by the review-request path to populate `context.simulationDigest` so the
 * `txGates` analyzers (`only_requested_swap`, `no_extra_transfers`,
 * `no_unrelated_instructions`) actually fire when a prepared transaction exists.
 *
 * Returns `undefined` when the transaction can't be parsed or the simulation throws —
 * the caller treats that as "no digest" rather than blocking the review. Anything we
 * couldn't simulate goes through with `txGateAtoms` reported as unresolved.
 */

import { Transaction, VersionedTransaction, type Connection } from '@solana/web3.js';

import type { SimulationDigest } from '@solana-agent-wallet-adapter/workflow';

export interface SimulationDigestOptions {
  /** Commitment to pass to simulateTransaction. Defaults to 'confirmed'. */
  commitment?: 'processed' | 'confirmed' | 'finalized';
  /** When true (default), replace the recent blockhash so older drafts simulate cleanly. */
  replaceRecentBlockhash?: boolean;
}

/**
 * Decode + simulate a transaction and return the structured digest the txGates analyzers
 * consume. Tries versioned-transaction first, falls back to legacy. Never throws.
 */
export async function buildSimulationDigestFromBase64(
  connection: Connection,
  transactionBase64: string,
  options: SimulationDigestOptions = {},
): Promise<SimulationDigest | undefined> {
  if (!transactionBase64 || typeof transactionBase64 !== 'string') return undefined;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(transactionBase64, 'base64');
  } catch {
    return undefined;
  }
  if (bytes.length === 0) return undefined;

  const commitment = options.commitment ?? 'confirmed';
  const replaceRecentBlockhash = options.replaceRecentBlockhash !== false;

  // Top-level invoked programs come from the message itself (deterministic) so they
  // populate even when simulation fails.
  let invokedPrograms: string[] = [];

  try {
    const versioned = VersionedTransaction.deserialize(bytes);
    invokedPrograms = collectVersionedPrograms(versioned);
    const result = await connection.simulateTransaction(versioned, {
      sigVerify: false,
      replaceRecentBlockhash,
      commitment,
    });
    const logs = result.value.logs ?? [];
    return {
      ok: !result.value.err,
      invokedPrograms,
      logs,
      ...(result.value.err ? { error: jsonifyErr(result.value.err) } : {}),
    };
  } catch (versionedErr) {
    try {
      const legacy = Transaction.from(bytes);
      invokedPrograms = legacy.instructions.map((ix) => ix.programId.toBase58());
      const result = await connection.simulateTransaction(legacy);
      const logs = result.value.logs ?? [];
      return {
        ok: !result.value.err,
        invokedPrograms,
        logs,
        ...(result.value.err ? { error: jsonifyErr(result.value.err) } : {}),
      };
    } catch (legacyErr) {
      // Surface a non-ok digest with the parse/simulate error so analyzers can fail-closed.
      return {
        ok: false,
        invokedPrograms,
        logs: [],
        error: legacyErr instanceof Error
          ? legacyErr.message
          : versionedErr instanceof Error
            ? versionedErr.message
            : 'unparseable transaction',
      };
    }
  }
}

function collectVersionedPrograms(tx: VersionedTransaction): string[] {
  const seen = new Set<string>();
  const message = tx.message;
  for (const ix of message.compiledInstructions) {
    const key = message.staticAccountKeys[ix.programIdIndex];
    if (key) seen.add(key.toBase58());
  }
  return Array.from(seen);
}

function jsonifyErr(err: unknown): string {
  if (err === null || err === undefined) return 'unknown';
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Function type the planner accepts to do simulation-on-demand. */
export type TransactionSimulator = (transactionBase64: string) => Promise<SimulationDigest | undefined>;

/** Build a simulator closure bound to a Connection — pass this to BridgeAiPlanner. */
export function makeTransactionSimulator(connection: Connection, options: SimulationDigestOptions = {}): TransactionSimulator {
  return (txBase64) => buildSimulationDigestFromBase64(connection, txBase64, options);
}
