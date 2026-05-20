import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  type AccountMeta as Web3AccountMeta,
  type Connection,
} from '@solana/web3.js';

/**
 * Bridge between `@solana/kit` instruction objects (returned by the Rise SDK) and `@solana/web3.js` transactions
 * (consumed by Agentic's signing infrastructure). We duck-type the kit Instruction shape rather than importing the
 * type directly because the workspace pins `@solana/kit@2.3.0` for Kamino compatibility while Rise depends on
 * `@solana/kit@^4.0.0`; the runtime objects share the same JSON-compatible shape across both major versions.
 *
 * `@solana/kit` Instruction:
 * ```
 * { programAddress: Address;  // string-branded
 *   accounts?: IAccountMeta[];
 *   data?: Uint8Array; }
 *
 * IAccountMeta { address: Address; role: AccountRole }
 * AccountRole enum: 0=READONLY, 1=WRITABLE, 2=READONLY_SIGNER, 3=WRITABLE_SIGNER
 * ```
 */

/** Minimal kit Instruction shape that the bridge accepts. Compatible with kit v2 / v4 / v5. */
export interface KitInstructionLike {
  programAddress: string;
  accounts?: KitAccountMetaLike[];
  data?: Uint8Array;
}

export interface KitAccountMetaLike {
  address: string;
  role: number; // AccountRole numeric: 0 / 1 / 2 / 3
}

const ROLE_READONLY = 0;
const ROLE_WRITABLE = 1;
const ROLE_READONLY_SIGNER = 2;
const ROLE_WRITABLE_SIGNER = 3;

/**
 * Convert a single `@solana/kit` Instruction into a `@solana/web3.js` TransactionInstruction.
 * Maps numeric `AccountRole` values to `(isSigner, isWritable)` booleans.
 */
export function kitInstructionToWeb3js(ix: KitInstructionLike): TransactionInstruction {
  const programId = new PublicKey(ix.programAddress);
  const keys: Web3AccountMeta[] = (ix.accounts ?? []).map((meta) => {
    const isSigner = meta.role === ROLE_READONLY_SIGNER || meta.role === ROLE_WRITABLE_SIGNER;
    const isWritable = meta.role === ROLE_WRITABLE || meta.role === ROLE_WRITABLE_SIGNER;
    return {
      pubkey: new PublicKey(meta.address),
      isSigner,
      isWritable,
    };
  });
  const data = ix.data ? Buffer.from(ix.data) : Buffer.alloc(0);
  return new TransactionInstruction({ programId, keys, data });
}

/**
 * Build a legacy (non-versioned) unsigned `Transaction` from one or more kit instructions, set fee payer = authority,
 * and serialize to a base64 string suitable for the prepared-action inbox.
 *
 * The transaction is intentionally unsigned: the wallet performs signing via `ctx.signAndBroadcast(transactionBase64)`.
 * We use `requireAllSignatures: false` and `verifySignatures: false` so unsigned serialization succeeds.
 *
 * @param ixs Kit instructions in execution order (typically a single instruction, but supports batched flows like
 *            deposit/withdraw which may emit token-account-create + actual op).
 * @param authority Base58-encoded fee payer (and primary signer) public key.
 * @param connection web3.js Connection for fetching the latest blockhash.
 */
export async function buildPhoenixTransactionBase64(
  ixs: readonly KitInstructionLike[],
  authority: string,
  connection: Connection,
): Promise<string> {
  if (ixs.length === 0) {
    throw new Error('buildPhoenixTransactionBase64: at least one instruction is required.');
  }
  const feePayer = new PublicKey(authority);
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer, recentBlockhash: blockhash });
  for (const ix of ixs) {
    tx.add(kitInstructionToWeb3js(ix));
  }
  // Unsigned: wallet signs at execute time.
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

/**
 * Coerce an arbitrary Rise-instruction-builder return value into the kit Instruction array we forward to the bridge.
 *
 * Rise's instruction builders return varying shapes (`PlaceMarketOrderIx`, `DepositIxsResult`, etc.). They all expose
 * either a single `.instruction` or an `.instructions` array of kit-shaped instructions. This helper normalizes both.
 */
export function instructionsFromRiseResult(
  result: unknown,
): KitInstructionLike[] {
  if (!result || typeof result !== 'object') {
    throw new Error('instructionsFromRiseResult: expected an object with `instruction` or `instructions`.');
  }
  const obj = result as Record<string, unknown>;
  if (Array.isArray(obj.instructions)) {
    return obj.instructions.filter(isInstructionLike);
  }
  if (Array.isArray(obj.ixs)) {
    return obj.ixs.filter(isInstructionLike);
  }
  if (isInstructionLike(obj.instruction)) {
    return [obj.instruction];
  }
  if (isInstructionLike(obj.ix)) {
    return [obj.ix];
  }
  if (isInstructionLike(obj)) {
    // Some builders return the bare Instruction.
    return [obj as unknown as KitInstructionLike];
  }
  throw new Error(
    'instructionsFromRiseResult: result has neither .instruction(s) nor .ix(s) nor a direct Instruction shape.',
  );
}

function isInstructionLike(value: unknown): value is KitInstructionLike {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as Record<string, unknown>).programAddress === 'string',
  );
}
