import * as anchor from '@coral-xyz/anchor';
import { IDL } from '@drift-labs/vaults-sdk';
import { Connection, PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import { convertLegacyAnchorIdl } from '../../adapters/drift/legacyIdl.js';

const FAKE_PROGRAM_ID = new PublicKey('vAuLTsyrvSfZRuRB3XgvkPwNGgYSs9YRYymVebLKoxR');

type AnyIdl = Record<string, unknown> & {
  instructions?: Array<Record<string, unknown> & { args: Array<Record<string, unknown>>; accounts: Array<Record<string, unknown>> }>;
  accounts?: Array<Record<string, unknown>>;
  events?: Array<Record<string, unknown>>;
  types?: Array<Record<string, unknown> & { type: Record<string, unknown> & { fields?: Array<Record<string, unknown>> } }>;
};

describe('convertLegacyAnchorIdl', () => {
  it('rewraps string defined into { name } shape and renames publicKey to pubkey', () => {
    const legacy = {
      version: '0.1.0',
      name: 'sample',
      instructions: [
        {
          name: 'doThing',
          accounts: [
            { name: 'vault', isMut: true, isSigner: false },
            { name: 'signer', isMut: false, isSigner: true },
          ],
          args: [
            { name: 'params', type: { defined: 'DoThingParams' } },
            { name: 'owner', type: 'publicKey' },
          ],
        },
      ],
      types: [
        {
          name: 'DoThingParams',
          type: {
            kind: 'struct',
            fields: [
              { name: 'amount', type: 'u64' },
              { name: 'authority', type: 'publicKey' },
              { name: 'maybe', type: { option: { defined: 'Inner' } } },
            ],
          },
        },
        {
          name: 'Inner',
          type: {
            kind: 'struct',
            fields: [{ name: 'tag', type: 'u8' }],
          },
        },
      ],
    };

    const converted = convertLegacyAnchorIdl(legacy) as AnyIdl;
    const ix = converted.instructions![0]!;
    expect(ix.args[0]).toEqual({ name: 'params', type: { defined: { name: 'DoThingParams' } } });
    expect(ix.args[1]).toEqual({ name: 'owner', type: 'pubkey' });
    expect(ix.accounts[0]).toMatchObject({ name: 'vault', writable: true, signer: false });
    expect(ix.accounts[1]).toMatchObject({ name: 'signer', writable: false, signer: true });
    expect(ix.accounts[0]).not.toHaveProperty('isMut');
    expect(ix.accounts[1]).not.toHaveProperty('isSigner');
    expect(ix.discriminator).toHaveLength(8);

    const params = converted.types!.find((t) => t.name === 'DoThingParams')!;
    const fields = params.type.fields!;
    expect(fields[1]).toEqual({ name: 'authority', type: 'pubkey' });
    expect(fields[2]).toEqual({ name: 'maybe', type: { option: { defined: { name: 'Inner' } } } });
  });

  it('promotes embedded account struct definitions into types[] and adds discriminators', () => {
    const legacy = {
      instructions: [],
      accounts: [
        {
          name: 'Vault',
          type: {
            kind: 'struct',
            fields: [{ name: 'manager', type: 'publicKey' }],
          },
        },
      ],
      types: [],
    };

    const converted = convertLegacyAnchorIdl(legacy) as AnyIdl;
    const account = converted.accounts![0]!;
    expect(account).not.toHaveProperty('type');
    expect(account.discriminator).toHaveLength(8);
    const moved = converted.types!.find((t) => t.name === 'Vault')!;
    expect(moved).toBeDefined();
    expect(moved.type.fields![0]).toEqual({ name: 'manager', type: 'pubkey' });
  });

  it('promotes events into types[] and assigns discriminators', () => {
    const legacy = {
      instructions: [],
      events: [
        {
          name: 'VaultRecord',
          fields: [
            { name: 'ts', type: 'i64', index: false },
            { name: 'vault', type: 'publicKey', index: false },
            { name: 'action', type: { defined: 'VaultDepositorAction' }, index: false },
          ],
        },
      ],
      types: [],
    };

    const converted = convertLegacyAnchorIdl(legacy) as AnyIdl;
    const event = converted.events![0]!;
    expect(event).not.toHaveProperty('fields');
    expect(event.discriminator).toHaveLength(8);
    const moved = converted.types!.find((t) => t.name === 'VaultRecord')!;
    expect(moved).toBeDefined();
    const fields = moved.type.fields!;
    expect(fields[1]).toMatchObject({ name: 'vault', type: 'pubkey' });
    expect(fields[2]).toMatchObject({ name: 'action', type: { defined: { name: 'VaultDepositorAction' } } });
  });

  it('does not mutate the input IDL', () => {
    const legacy = {
      instructions: [
        {
          name: 'noop',
          accounts: [{ name: 'a', isMut: true, isSigner: false }],
          args: [{ name: 'amount', type: 'u64' }],
        },
      ],
      accounts: [],
      types: [],
    };
    const snapshot = JSON.stringify(legacy);
    convertLegacyAnchorIdl(legacy);
    expect(JSON.stringify(legacy)).toEqual(snapshot);
  });
});

describe('convertLegacyAnchorIdl against real Drift Vaults IDL', () => {
  const converted = convertLegacyAnchorIdl({
    ...(IDL as unknown as Record<string, unknown>),
    address: FAKE_PROGRAM_ID.toBase58(),
  }) as AnyIdl;

  it('strips every legacy "publicKey" string type', () => {
    expect(JSON.stringify(converted)).not.toContain('"publicKey"');
  });

  it('rewraps every defined-type reference into the { name } shape', () => {
    expect(JSON.stringify(converted)).not.toMatch(/"defined":"/);
  });

  it('assigns 8-byte discriminators to every instruction, account, and event', () => {
    for (const ix of converted.instructions ?? []) {
      expect((ix.discriminator as number[]).length).toBe(8);
    }
    for (const acc of converted.accounts ?? []) {
      expect((acc.discriminator as number[]).length).toBe(8);
      expect(acc).not.toHaveProperty('type');
    }
    for (const evt of converted.events ?? []) {
      expect((evt.discriminator as number[]).length).toBe(8);
      expect(evt).not.toHaveProperty('fields');
    }
  });

  it('moves every account and event struct into types[]', () => {
    const typeNames = new Set((converted.types ?? []).map((t) => t.name as string));
    for (const acc of converted.accounts ?? []) {
      expect(typeNames.has(acc.name as string)).toBe(true);
    }
    for (const evt of converted.events ?? []) {
      expect(typeNames.has(evt.name as string)).toBe(true);
    }
  });

  it('constructs an anchor.Program without throwing (regression for "Type not found: params")', () => {
    const wallet = {
      publicKey: FAKE_PROGRAM_ID,
      signTransaction: async (tx: unknown) => tx as never,
      signAllTransactions: async (txs: unknown[]) => txs as never,
    };
    const provider = new anchor.AnchorProvider(
      new Connection('http://localhost:8899'),
      wallet as never,
      { commitment: 'confirmed' },
    );
    expect(() => new anchor.Program(converted as never, provider)).not.toThrow();
  });
});
