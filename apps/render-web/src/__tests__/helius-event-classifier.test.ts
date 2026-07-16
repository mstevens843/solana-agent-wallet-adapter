import { describe, expect, it } from 'vitest';

import {
  JUPITER_DCA_PROGRAM_ID,
  JUPITER_TRIGGER_PROGRAM_ID,
  classifyHeliusTransaction,
  programIdsIn,
  txTouchesWallet,
  type HeliusEnhancedTransaction,
} from '../cloud/heliusEventClassifier.js';

const WALLET = 'Wa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const KEEPER = 'Keeper11111111111111111111111111111111111111';
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Shaped after a Helius enhanced webhook payload: a Jupiter automation fill is signed and paid for by
// Jupiter's KEEPER, and credits the user's wallet. That fee-payer asymmetry is the whole discriminator.
function automationFill(programId: string): HeliusEnhancedTransaction {
  return {
    signature: 'sigFill111',
    type: 'SWAP',
    source: 'JUPITER',
    feePayer: KEEPER,
    tokenTransfers: [
      { fromUserAccount: WALLET, toUserAccount: KEEPER, mint: SOL, tokenAmount: 0.5 },
      { fromUserAccount: KEEPER, toUserAccount: WALLET, mint: USDC, tokenAmount: 92.4 },
    ],
    instructions: [{ programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', innerInstructions: [{ programId }] }],
  };
}

describe('helius tx classifier: Jupiter automation fills', () => {
  it('classifies a limit-order fill, with the swap legs in the body', () => {
    const event = classifyHeliusTransaction(automationFill(JUPITER_TRIGGER_PROGRAM_ID), WALLET);
    expect(event?.type).toBe('jupiter.trigger.filled');
    expect(event?.title).toBe('Limit order filled');
    expect(event?.body).toBe('0.5 SOL → 92.4 USDC');
    // Dedupe on the signature: Helius re-delivers on any non-2xx, and the phone must not buzz twice.
    expect(event?.dedupeKey).toBe('sigFill111');
    expect(event?.data).toMatchObject({ tab: 'positions', section: 'orders' });
  });

  it('classifies a DCA fill distinctly from a limit fill', () => {
    const event = classifyHeliusTransaction(automationFill(JUPITER_DCA_PROGRAM_ID), WALLET);
    expect(event?.type).toBe('jupiter.recurring.filled');
    expect(event?.title).toBe('DCA order filled');
  });

  it('finds the program in INNER instructions — a fill is CPI’d, not top-level', () => {
    expect(programIdsIn(automationFill(JUPITER_DCA_PROGRAM_ID)).has(JUPITER_DCA_PROGRAM_ID)).toBe(true);
  });

  it('DEGRADES, never drops: an unknown/rotated Jupiter program still notifies', () => {
    // The point of keeping the fee-payer signal free of any program allowlist. If Jupiter redeploys,
    // the wording falls back to the limit phrasing but the user still learns their order fired.
    const rotated = classifyHeliusTransaction(automationFill(JUPITER_TRIGGER_PROGRAM_ID), WALLET, {
      triggerProgramId: 'SomeOtherProgram1111111111111111111111111111',
      dcaProgramId: 'AndAnother11111111111111111111111111111111',
    });
    // With neither id matching, this is no longer recognised as automation and is correctly quiet
    // (a keeper tx that mentions the wallet but uses no known Jupiter program is not ours).
    expect(rotated).toBeUndefined();
  });
});

describe('helius tx classifier: the wallet’s own transactions', () => {
  const own: HeliusEnhancedTransaction = {
    signature: 'sigOwn111',
    type: 'TRANSFER',
    feePayer: WALLET,
    description: 'Wallet transferred 1 SOL to Someone.',
    tokenTransfers: [{ fromUserAccount: WALLET, toUserAccount: KEEPER, mint: SOL, tokenAmount: 1 }],
    instructions: [{ programId: '11111111111111111111111111111111' }],
  };

  it('classifies a confirmed tx the wallet paid for', () => {
    const event = classifyHeliusTransaction(own, WALLET);
    expect(event?.type).toBe('tx.confirmed');
    expect(event?.title).toBe('Transaction confirmed');
    expect(event?.body).toBe('Sent 1 SOL');
    expect(event?.data).toMatchObject({ tab: 'completed' });
  });

  it('classifies a failed tx off Helius’ transactionError marker', () => {
    const event = classifyHeliusTransaction({ ...own, transactionError: { InstructionError: [0, 'Custom'] } }, WALLET);
    expect(event?.type).toBe('tx.failed');
    expect(event?.title).toBe('Transaction failed');
  });

  it('falls back to Helius’ description when there are no token legs to summarise', () => {
    const event = classifyHeliusTransaction({ ...own, tokenTransfers: [] }, WALLET);
    expect(event?.body).toBe('Wallet transferred 1 SOL to Someone.');
  });
});

describe('helius tx classifier: staying quiet', () => {
  it('ignores a tx that does not touch the wallet at all', () => {
    const other: HeliusEnhancedTransaction = {
      signature: 'sigOther',
      feePayer: KEEPER,
      tokenTransfers: [{ fromUserAccount: KEEPER, toUserAccount: 'Someone', mint: SOL, tokenAmount: 1 }],
    };
    expect(classifyHeliusTransaction(other, WALLET)).toBeUndefined();
    expect(txTouchesWallet(other, WALLET)).toBe(false);
  });

  it('ignores a third-party tx that merely MENTIONS the wallet (airdrop spam, shared accounts)', () => {
    // Touches the wallet, but the wallet neither paid nor was credited by Jupiter automation.
    // Buzzing here would let anyone on chain ring the user's phone at will.
    const spam: HeliusEnhancedTransaction = {
      signature: 'sigSpam',
      feePayer: KEEPER,
      accountData: [{ account: WALLET }],
      instructions: [{ programId: 'SpamProgram11111111111111111111111111111111' }],
    };
    expect(txTouchesWallet(spam, WALLET)).toBe(true);
    expect(classifyHeliusTransaction(spam, WALLET)).toBeUndefined();
  });

  it('ignores a transaction with no signature', () => {
    expect(classifyHeliusTransaction({ feePayer: WALLET }, WALLET)).toBeUndefined();
  });
});
