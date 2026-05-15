import { afterEach, describe, expect, it } from 'vitest';

import type { Connection } from '@solana/web3.js';

import {
  getOrcaClient,
  resetLoadOrcaSdkForTesting,
  resetOrcaClientFactory,
  setLoadOrcaSdkForTesting,
  type LoadedOrcaSdk,
} from '../../adapters/orca/client.js';

const WALLET = 'GgwYwf8XtAQRtu1ZUv9hY1Zk1wkJpz3DCH7jQAjmGGGV';
const WHIRLPOOL = 'HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBmZvaaA9NA';
const TOKEN_A = 'So11111111111111111111111111111111111111112';
const TOKEN_B = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const POSITION_ADDRESS = 'F4SFjVxXbCM86KqyXuUFzXKSBg6PB6m9aV1QxqLGFZye';

interface SignerCapture {
  feePayerCalls: unknown[];
  openPositionAuthorities: unknown[];
  increasePositionAuthorities: unknown[];
  decreasePositionAuthorities: unknown[];
  harvestPositionAuthorities: unknown[];
  noopSignerInvocations: Array<{ address: string; signer: unknown }>;
}

function fakeWhirlpoolAccount() {
  return {
    address: WHIRLPOOL,
    data: {
      whirlpoolsConfig: '2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ',
      tokenMintA: TOKEN_A,
      tokenMintB: TOKEN_B,
      tokenVaultA: TOKEN_A,
      tokenVaultB: TOKEN_B,
      tickSpacing: 8,
      feeRate: 400,
      tickCurrentIndex: 64,
      sqrtPrice: 18_446_744_073_709_551_616n,
      liquidity: 1_000_000n,
      rewardInfos: [],
    },
  };
}

function fakePositionAccount() {
  return {
    address: POSITION_ADDRESS,
    data: {
      positionMint: TOKEN_A,
      whirlpool: WHIRLPOOL,
      liquidity: 1_000_000n,
      tickLowerIndex: 56,
      tickUpperIndex: 80,
      feeOwedA: 0n,
      feeOwedB: 0n,
      rewardInfos: [],
    },
  };
}

function fakeConnection(): Connection {
  return {
    rpcEndpoint: 'https://fake',
    async getLatestBlockhash() {
      return { blockhash: 'FakeBlockhash11111111111111111111111111111111', lastValidBlockHeight: 1000 };
    },
    async getParsedAccountInfo(_address: unknown) {
      return {
        value: {
          data: { parsed: { info: { decimals: 9 } } },
        },
      };
    },
    async getAccountInfo() {
      return { owner: { toBase58: () => 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc' } };
    },
    async getSlot() {
      return 280_000_000;
    },
  } as unknown as Connection;
}

function buildFakeSdk(capture: SignerCapture): LoadedOrcaSdk {
  const kit = {
    address: (value: string) => value,
    blockhash: (value: string) => value,
    createSolanaRpc: (endpoint: string) => ({ endpoint }),
    createNoopSigner: (address: string) => {
      const signer = { __id: capture.noopSignerInvocations.length, address };
      capture.noopSignerInvocations.push({ address, signer });
      return signer;
    },
    createTransactionMessage: () => ({ instructions: [], feePayer: undefined as unknown }),
    setTransactionMessageFeePayerSigner: (signer: unknown, message: any) => {
      capture.feePayerCalls.push(signer);
      return { ...message, feePayer: signer };
    },
    setTransactionMessageLifetimeUsingBlockhash: (lifetime: unknown, message: any) => ({
      ...message,
      lifetime,
    }),
    appendTransactionMessageInstructions: (instructions: unknown[], message: any) => ({
      ...message,
      instructions: [...(message.instructions ?? []), ...instructions],
    }),
    partiallySignTransactionMessageWithSigners: async (message: any) => ({ message }),
    getBase64EncodedWireTransaction: () => 'fake-base64',
  };

  const orca = {
    openPositionInstructions: async (
      _rpc: unknown,
      _whirlpool: unknown,
      _param: unknown,
      _lowerPrice: unknown,
      _upperPrice: unknown,
      _slippage: unknown,
      authority: unknown,
    ) => {
      capture.openPositionAuthorities.push(authority);
      return {
        instructions: [{ programAddress: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc' }],
        quote: { tokenMaxA: 0n, tokenMaxB: 0n },
        positionMint: TOKEN_A,
      };
    },
    increaseLiquidityInstructions: async (
      _rpc: unknown,
      _positionMint: unknown,
      _param: unknown,
      _slippage: unknown,
      authority: unknown,
    ) => {
      capture.increasePositionAuthorities.push(authority);
      return {
        instructions: [{ programAddress: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc' }],
        quote: { tokenMaxA: 0n, tokenMaxB: 0n },
      };
    },
    decreaseLiquidityInstructions: async (
      _rpc: unknown,
      _positionMint: unknown,
      _param: unknown,
      _slippage: unknown,
      authority: unknown,
    ) => {
      capture.decreasePositionAuthorities.push(authority);
      return {
        instructions: [{ programAddress: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc' }],
        quote: { tokenMinA: 0n, tokenMinB: 0n },
      };
    },
    harvestPositionInstructions: async (
      _rpc: unknown,
      _positionMint: unknown,
      authority: unknown,
    ) => {
      capture.harvestPositionAuthorities.push(authority);
      return {
        instructions: [
          {
            programAddress: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
            __identity: 'CollectFees',
          },
        ],
        feesQuote: { feeOwedA: 0n, feeOwedB: 0n },
        rewardsQuote: { rewards: [] },
      };
    },
    fetchPositionsForOwner: async () => [],
  };

  const whirlpoolsClient = {
    fetchWhirlpool: async () => fakeWhirlpoolAccount(),
    fetchPosition: async () => fakePositionAccount(),
    getPositionAddress: async () => [POSITION_ADDRESS, 255],
    identifyWhirlpoolInstruction: (instruction: any) => instruction.__identity,
    WhirlpoolInstruction: {
      UpdateFeesAndRewards: 'UpdateFeesAndRewards',
      CollectFees: 'CollectFees',
      CollectFeesV2: 'CollectFeesV2',
      CollectReward: 'CollectReward',
      CollectRewardV2: 'CollectRewardV2',
    },
  };

  const whirlpoolsCore = {
    tickIndexToPrice: () => 1,
    sqrtPriceToPrice: () => 1,
  };

  return {
    orca: orca as unknown as LoadedOrcaSdk['orca'],
    kit: kit as unknown as LoadedOrcaSdk['kit'],
    whirlpoolsClient: whirlpoolsClient as unknown as LoadedOrcaSdk['whirlpoolsClient'],
    whirlpoolsCore: whirlpoolsCore as unknown as LoadedOrcaSdk['whirlpoolsCore'],
  };
}

function makeCapture(): SignerCapture {
  return {
    feePayerCalls: [],
    openPositionAuthorities: [],
    increasePositionAuthorities: [],
    decreasePositionAuthorities: [],
    harvestPositionAuthorities: [],
    noopSignerInvocations: [],
  };
}

afterEach(() => {
  resetLoadOrcaSdkForTesting();
  resetOrcaClientFactory();
});

describe('OrcaSdkClient signer identity (regression for #5508000)', () => {
  it('shares the same signer between openPositionInstructions and the fee-payer slot', async () => {
    const capture = makeCapture();
    setLoadOrcaSdkForTesting(async () => buildFakeSdk(capture));

    const result = await getOrcaClient().buildIncreaseLiquidityTransaction(fakeConnection(), {
      walletAddress: WALLET,
      whirlpoolAddress: WHIRLPOOL,
      tokenAAmount: '0.02',
      maxTokenBAmount: '2',
      lowerTick: 0,
      upperTick: 128,
      slippageBps: 100,
    });

    expect(result.transactionBase64).toBe('fake-base64');
    expect(capture.openPositionAuthorities).toHaveLength(1);
    expect(capture.feePayerCalls).toHaveLength(1);
    expect(capture.feePayerCalls[0]).toBe(capture.openPositionAuthorities[0]);
    const walletSignerCount = capture.noopSignerInvocations.filter((entry) => entry.address === WALLET).length;
    expect(walletSignerCount).toBe(1);
  });

  it('shares the same signer for add-to-existing-position increases', async () => {
    const capture = makeCapture();
    setLoadOrcaSdkForTesting(async () => buildFakeSdk(capture));

    await getOrcaClient().buildIncreaseLiquidityTransaction(fakeConnection(), {
      walletAddress: WALLET,
      whirlpoolAddress: WHIRLPOOL,
      positionMint: TOKEN_A,
      tokenAAmount: '0.01',
      slippageBps: 100,
    });

    expect(capture.increasePositionAuthorities).toHaveLength(1);
    expect(capture.feePayerCalls).toHaveLength(1);
    expect(capture.feePayerCalls[0]).toBe(capture.increasePositionAuthorities[0]);
  });

  it('shares the same signer for decrease liquidity builds', async () => {
    const capture = makeCapture();
    setLoadOrcaSdkForTesting(async () => buildFakeSdk(capture));

    await getOrcaClient().buildDecreaseLiquidityTransaction(fakeConnection(), {
      walletAddress: WALLET,
      whirlpoolAddress: WHIRLPOOL,
      positionMint: TOKEN_A,
      liquidityPercent: 0.5,
      slippageBps: 100,
    });

    expect(capture.decreasePositionAuthorities).toHaveLength(1);
    expect(capture.feePayerCalls).toHaveLength(1);
    expect(capture.feePayerCalls[0]).toBe(capture.decreasePositionAuthorities[0]);
  });

  it('shares the same signer for collect-fees harvest builds', async () => {
    const capture = makeCapture();
    setLoadOrcaSdkForTesting(async () => buildFakeSdk(capture));

    await getOrcaClient().buildCollectFeesTransaction(fakeConnection(), {
      walletAddress: WALLET,
      positionMint: TOKEN_A,
      whirlpoolAddress: WHIRLPOOL,
    });

    expect(capture.harvestPositionAuthorities).toHaveLength(1);
    expect(capture.feePayerCalls).toHaveLength(1);
    expect(capture.feePayerCalls[0]).toBe(capture.harvestPositionAuthorities[0]);
  });
});
