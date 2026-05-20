import { describe, expect, it, vi } from 'vitest';

import { PublicKey, Transaction, type Connection } from '@solana/web3.js';

import {
  buildPhoenixTransactionBase64,
  instructionsFromRiseResult,
  kitInstructionToWeb3js,
  type KitAccountMetaLike,
  type KitInstructionLike,
} from '../../../adapters/phoenix/instructionBridge.js';

const PUBKEY_A = '11111111111111111111111111111111';
const PUBKEY_B = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const PUBKEY_C = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const PROGRAM_ID = 'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY';

// Valid base58 strings (no 0/O/I/l). 32-byte equivalent for legacy Message header.
const VALID_BLOCKHASH = 'GwY7VR4hHvBfStcAd3rJ4FuFiF5KFRDavBKwjkqsdYkS';

function makeMockConnection(blockhash = VALID_BLOCKHASH): Connection {
  return {
    getLatestBlockhash: vi.fn(async () => ({ blockhash, lastValidBlockHeight: 1000 })),
  } as unknown as Connection;
}

describe('kitInstructionToWeb3js', () => {
  it('maps program address + empty accounts + empty data', () => {
    const ix = kitInstructionToWeb3js({ programAddress: PROGRAM_ID });
    expect(ix.programId.toBase58()).toBe(PROGRAM_ID);
    expect(ix.keys).toEqual([]);
    expect(ix.data.length).toBe(0);
  });

  it('maps READONLY (role=0) → isSigner=false, isWritable=false', () => {
    const ix = kitInstructionToWeb3js({
      programAddress: PROGRAM_ID,
      accounts: [{ address: PUBKEY_A, role: 0 }],
    });
    expect(ix.keys).toEqual([
      { pubkey: new PublicKey(PUBKEY_A), isSigner: false, isWritable: false },
    ]);
  });

  it('maps WRITABLE (role=1) → isSigner=false, isWritable=true', () => {
    const ix = kitInstructionToWeb3js({
      programAddress: PROGRAM_ID,
      accounts: [{ address: PUBKEY_A, role: 1 }],
    });
    expect(ix.keys[0]).toMatchObject({ isSigner: false, isWritable: true });
  });

  it('maps READONLY_SIGNER (role=2) → isSigner=true, isWritable=false', () => {
    const ix = kitInstructionToWeb3js({
      programAddress: PROGRAM_ID,
      accounts: [{ address: PUBKEY_A, role: 2 }],
    });
    expect(ix.keys[0]).toMatchObject({ isSigner: true, isWritable: false });
  });

  it('maps WRITABLE_SIGNER (role=3) → isSigner=true, isWritable=true', () => {
    const ix = kitInstructionToWeb3js({
      programAddress: PROGRAM_ID,
      accounts: [{ address: PUBKEY_A, role: 3 }],
    });
    expect(ix.keys[0]).toMatchObject({ isSigner: true, isWritable: true });
  });

  it('preserves data as Buffer with correct bytes', () => {
    const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const ix = kitInstructionToWeb3js({ programAddress: PROGRAM_ID, data });
    expect(ix.data).toEqual(Buffer.from(data));
  });

  it('preserves account order across multiple accounts', () => {
    const accounts: KitAccountMetaLike[] = [
      { address: PUBKEY_A, role: 1 },
      { address: PUBKEY_B, role: 0 },
      { address: PUBKEY_C, role: 3 },
    ];
    const ix = kitInstructionToWeb3js({ programAddress: PROGRAM_ID, accounts });
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([PUBKEY_A, PUBKEY_B, PUBKEY_C]);
    expect(ix.keys.map((k) => k.isSigner)).toEqual([false, false, true]);
    expect(ix.keys.map((k) => k.isWritable)).toEqual([true, false, true]);
  });
});

describe('buildPhoenixTransactionBase64', () => {
  it('serializes a single-instruction unsigned transaction with fee payer + blockhash set', async () => {
    const connection = makeMockConnection();
    const ixs: KitInstructionLike[] = [
      {
        programAddress: PROGRAM_ID,
        accounts: [{ address: PUBKEY_A, role: 3 }],
        data: new Uint8Array([1, 2, 3]),
      },
    ];
    const base64 = await buildPhoenixTransactionBase64(ixs, PUBKEY_A, connection);
    expect(typeof base64).toBe('string');
    expect(base64.length).toBeGreaterThan(0);
    // Round-trip: deserialize and verify.
    const tx = Transaction.from(Buffer.from(base64, 'base64'));
    expect(tx.feePayer?.toBase58()).toBe(PUBKEY_A);
    expect(tx.instructions).toHaveLength(1);
    expect(tx.instructions[0]!.programId.toBase58()).toBe(PROGRAM_ID);
  });

  it('assembles multiple instructions in order', async () => {
    const connection = makeMockConnection();
    const ixs: KitInstructionLike[] = [
      { programAddress: PROGRAM_ID, data: new Uint8Array([1]) },
      { programAddress: PUBKEY_B, data: new Uint8Array([2]) },
      { programAddress: PUBKEY_C, data: new Uint8Array([3]) },
    ];
    const base64 = await buildPhoenixTransactionBase64(ixs, PUBKEY_A, connection);
    const tx = Transaction.from(Buffer.from(base64, 'base64'));
    expect(tx.instructions).toHaveLength(3);
    expect(tx.instructions.map((i) => i.data[0])).toEqual([1, 2, 3]);
  });

  it('throws on empty instruction array', async () => {
    const connection = makeMockConnection();
    await expect(buildPhoenixTransactionBase64([], PUBKEY_A, connection)).rejects.toThrow(/at least one instruction/);
  });

  it('fetches latest blockhash before serializing', async () => {
    const getLatestBlockhash = vi.fn(async () => ({ blockhash: VALID_BLOCKHASH, lastValidBlockHeight: 42 }));
    const connection = { getLatestBlockhash } as unknown as Connection;
    const ixs: KitInstructionLike[] = [{ programAddress: PROGRAM_ID }];
    await buildPhoenixTransactionBase64(ixs, PUBKEY_A, connection);
    expect(getLatestBlockhash).toHaveBeenCalledTimes(1);
  });
});

describe('instructionsFromRiseResult', () => {
  it('extracts a single instruction from { instruction: ... }', () => {
    const result = { instruction: { programAddress: PROGRAM_ID } };
    expect(instructionsFromRiseResult(result)).toEqual([{ programAddress: PROGRAM_ID }]);
  });

  it('extracts an array from { instructions: [...] }', () => {
    const result = {
      instructions: [
        { programAddress: PROGRAM_ID },
        { programAddress: PUBKEY_B },
      ],
    };
    expect(instructionsFromRiseResult(result)).toHaveLength(2);
  });

  it('extracts from { ixs: [...] } variant', () => {
    const result = { ixs: [{ programAddress: PROGRAM_ID }] };
    expect(instructionsFromRiseResult(result)).toHaveLength(1);
  });

  it('accepts a bare Instruction shape', () => {
    const result = { programAddress: PROGRAM_ID };
    expect(instructionsFromRiseResult(result)).toEqual([result]);
  });

  it('throws on unrecognized shape', () => {
    expect(() => instructionsFromRiseResult({ random: 'object' })).toThrow(/neither .instruction/);
  });

  it('throws on non-object input', () => {
    expect(() => instructionsFromRiseResult(null)).toThrow();
    expect(() => instructionsFromRiseResult('string')).toThrow();
  });
});
