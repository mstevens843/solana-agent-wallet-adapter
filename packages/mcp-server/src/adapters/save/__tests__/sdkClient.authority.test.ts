import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Keypair, PublicKey } from '@solana/web3.js';

const SOLEND_MAIN_POOL_BASE58 = '4UpD2fh7xH3VP9QQaXtsS1YY3bxzWhtfpks7FatyKvdY';
const SOLEND_PROGRAM_BASE58 = 'So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const WALLET = 'GgwYwf8XtAQRtu1ZUv9hY1Zk1wkJpz3DCH7jQAjmGGGV';

interface CapturedPool {
  address: string;
  authorityAddress: string;
  owner: string;
  reserves: Array<{ address: string; mintAddress: string }>;
}

const capturedPools: CapturedPool[] = [];

const reservePubkey = Keypair.generate().publicKey;
const liquidityPubkey = Keypair.generate().publicKey;
const cTokenMintPubkey = Keypair.generate().publicKey;
const cTokenSupplyPubkey = Keypair.generate().publicKey;
const pythOraclePubkey = Keypair.generate().publicKey;
const switchboardOraclePubkey = Keypair.generate().publicKey;
const feeReceiverPubkey = Keypair.generate().publicKey;

vi.mock('@solendprotocol/solend-sdk', () => {
  const fakeAction = {
    async getLegacyTransactions() {
      return {
        lendingTxn: {
          feePayer: undefined as unknown,
          recentBlockhash: undefined as unknown,
        },
      };
    },
  };

  const SolendActionCore = {
    buildDepositTxns: vi.fn(async (pool: CapturedPool) => {
      capturedPools.push(pool);
      return fakeAction;
    }),
    buildWithdrawTxns: vi.fn(async (pool: CapturedPool) => {
      capturedPools.push(pool);
      return fakeAction;
    }),
    buildBorrowTxns: vi.fn(async (pool: CapturedPool) => {
      capturedPools.push(pool);
      return fakeAction;
    }),
    buildRepayTxns: vi.fn(async (pool: CapturedPool) => {
      capturedPools.push(pool);
      return fakeAction;
    }),
  };

  return {
    SolendActionCore,
    parseReserve: () => ({
      info: {
        liquidity: {
          supplyPubkey: liquidityPubkey,
          pythOracle: pythOraclePubkey,
          switchboardOracle: switchboardOraclePubkey,
          mintPubkey: new PublicKey(SOL_MINT),
          mintDecimals: 9,
        },
        collateral: {
          mintPubkey: cTokenMintPubkey,
          supplyPubkey: cTokenSupplyPubkey,
        },
        config: {
          feeReceiver: feeReceiverPubkey,
        },
      },
    }),
    MAIN_POOL_ADDRESS: new PublicKey(SOLEND_MAIN_POOL_BASE58),
    SOLEND_PRODUCTION_PROGRAM_ID: new PublicKey(SOLEND_PROGRAM_BASE58),
    fetchPoolMetadata: vi.fn().mockRejectedValue(new Error('mocked: skip metadata enrichment')),
  };
});

describe('buildSaveSdkClient — pool.authorityAddress derivation', () => {
  beforeEach(() => {
    capturedPools.length = 0;
  });

  it('passes a non-empty authorityAddress (the lending-market PDA) to the SDK builder', async () => {
    const { buildSaveSdkClient } = await import('../sdkClient.js');
    const { resetSaveClientFactory } = await import('../client.js');

    const connection = {
      async getProgramAccounts() {
        return [
          {
            pubkey: reservePubkey,
            account: {
              data: Buffer.alloc(619),
              owner: new PublicKey(SOLEND_PROGRAM_BASE58),
              lamports: 0,
              executable: false,
            },
          },
        ];
      },
      async getLatestBlockhash() {
        return { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 0 };
      },
    } as unknown as import('@solana/web3.js').Connection;

    try {
      const client = buildSaveSdkClient({ rpcUrl: 'http://127.0.0.1:0' });
      await client.buildDepositTransaction(connection, {
        walletAddress: WALLET,
        reserveMint: SOL_MINT,
        amountRaw: 10_000_000n,
        depositCollateral: true,
      });
    } finally {
      resetSaveClientFactory();
    }

    expect(capturedPools).toHaveLength(1);
    const pool = capturedPools[0]!;
    expect(pool.address).toBe(SOLEND_MAIN_POOL_BASE58);
    expect(pool.authorityAddress).not.toBe('');

    const [expectedAuthority] = PublicKey.findProgramAddressSync(
      [new PublicKey(SOLEND_MAIN_POOL_BASE58).toBytes()],
      new PublicKey(SOLEND_PROGRAM_BASE58),
    );
    // Must match the same PDA every Solend instruction derives. An empty
    // authorityAddress would crash the SDK with "Invalid public key input"
    // before the wallet ever sees a transaction.
    expect(pool.authorityAddress).toBe(expectedAuthority.toBase58());
  });
});
