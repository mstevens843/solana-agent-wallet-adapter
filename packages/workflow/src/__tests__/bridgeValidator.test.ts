import { describe, expect, it } from 'vitest';

import { WorkflowValidationError } from '../index.js';
import { validateSettlementQuoteRequest } from '../dev/bridge.js';

const RECIPIENT = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PAYER = 'B62iGvBp9bSXwAJqs54FX5SmHmwTGMG1L37r1WzD3CDM';

function workflowError(action: () => unknown): WorkflowValidationError {
  try {
    action();
  } catch (err) {
    expect(err).toBeInstanceOf(WorkflowValidationError);
    return err as WorkflowValidationError;
  }
  throw new Error('Expected WorkflowValidationError.');
}

describe('validateSettlementQuoteRequest', () => {
  it('returns the typed object on a happy-path request', () => {
    const result = validateSettlementQuoteRequest({
      usdAmount: '50.00',
      recipient: RECIPIENT,
      targetMint: USDC_MINT,
      payerWallet: PAYER,
      cluster: 'mainnet-beta',
      maxSlippageBps: 50,
    });
    expect(result).toEqual({
      usdAmount: '50.00',
      recipient: RECIPIENT,
      targetMint: USDC_MINT,
      payerWallet: PAYER,
      cluster: 'mainnet-beta',
      maxSlippageBps: 50,
    });
  });

  it('returns minimum-shape object when only required fields are present', () => {
    const result = validateSettlementQuoteRequest({ usdAmount: '1', recipient: RECIPIENT });
    expect(result).toEqual({ usdAmount: '1', recipient: RECIPIENT });
    expect('targetMint' in result).toBe(false);
    expect('cluster' in result).toBe(false);
  });

  it('rejects non-object body', () => {
    expect(workflowError(() => validateSettlementQuoteRequest(null))).toMatchObject({
      code: 'invalid_object',
      path: '$',
    });
    expect(workflowError(() => validateSettlementQuoteRequest([1, 2]))).toMatchObject({
      code: 'invalid_object',
    });
  });

  it('rejects missing usdAmount as invalid_decimal', () => {
    expect(workflowError(() => validateSettlementQuoteRequest({ recipient: RECIPIENT }))).toMatchObject({
      code: 'invalid_decimal',
      path: '$.usdAmount',
    });
  });

  it('rejects zero / negative / non-numeric usdAmount', () => {
    for (const bad of ['0', '0.00', '0.0', '-5', 'abc', '', '5.', '.5']) {
      expect(workflowError(() => validateSettlementQuoteRequest({ usdAmount: bad, recipient: RECIPIENT }))).toMatchObject({
        code: 'invalid_decimal',
      });
    }
  });

  it('rejects usdAmount above the dev cap', () => {
    expect(workflowError(() => validateSettlementQuoteRequest({ usdAmount: '1000001', recipient: RECIPIENT }))).toMatchObject({
      code: 'out_of_range',
      path: '$.usdAmount',
    });
  });

  it('rejects non-base58 recipient', () => {
    expect(workflowError(() => validateSettlementQuoteRequest({ usdAmount: '1', recipient: 'not-base58' }))).toMatchObject({
      code: 'invalid_pubkey',
      path: '$.recipient',
    });
  });

  it('rejects non-base58 targetMint and payerWallet', () => {
    expect(workflowError(() => validateSettlementQuoteRequest({
      usdAmount: '1', recipient: RECIPIENT, targetMint: 'nope',
    }))).toMatchObject({ code: 'invalid_pubkey', path: '$.targetMint' });

    expect(workflowError(() => validateSettlementQuoteRequest({
      usdAmount: '1', recipient: RECIPIENT, payerWallet: 'short',
    }))).toMatchObject({ code: 'invalid_pubkey', path: '$.payerWallet' });
  });

  it('rejects an unknown cluster', () => {
    expect(workflowError(() => validateSettlementQuoteRequest({
      usdAmount: '1', recipient: RECIPIENT, cluster: 'testnet',
    }))).toMatchObject({ code: 'invalid_enum', path: '$.cluster' });
  });

  it('rejects out-of-range maxSlippageBps', () => {
    expect(workflowError(() => validateSettlementQuoteRequest({
      usdAmount: '1', recipient: RECIPIENT, maxSlippageBps: -1,
    }))).toMatchObject({ code: 'out_of_range', path: '$.maxSlippageBps' });

    expect(workflowError(() => validateSettlementQuoteRequest({
      usdAmount: '1', recipient: RECIPIENT, maxSlippageBps: 5_000,
    }))).toMatchObject({ code: 'out_of_range', path: '$.maxSlippageBps' });

    expect(workflowError(() => validateSettlementQuoteRequest({
      usdAmount: '1', recipient: RECIPIENT, maxSlippageBps: 1.5,
    }))).toMatchObject({ code: 'out_of_range', path: '$.maxSlippageBps' });
  });

  it('rejects forbidden secrets injected anywhere', () => {
    expect(workflowError(() => validateSettlementQuoteRequest({
      usdAmount: '1',
      recipient: RECIPIENT,
      metadata: { privateKey: 'leaked' },
    }))).toMatchObject({ code: 'forbidden_secret' });

    expect(workflowError(() => validateSettlementQuoteRequest({
      usdAmount: '1',
      recipient: RECIPIENT,
      delegatedSigner: 'agent-wallet',
    }))).toMatchObject({ code: 'forbidden_secret' });
  });

  it('rejects unlimited approval authority', () => {
    expect(workflowError(() => validateSettlementQuoteRequest({
      usdAmount: '1',
      recipient: RECIPIENT,
      metadata: { approvalAuthority: 'unlimited' },
    }))).toMatchObject({ code: 'forbidden_authority' });
  });

  describe('payerHoldings', () => {
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const SOL = 'So11111111111111111111111111111111111111112';

    it('omits payerHoldings from the typed output when absent', () => {
      const result = validateSettlementQuoteRequest({ usdAmount: '50', recipient: RECIPIENT });
      expect('payerHoldings' in result).toBe(false);
    });

    it('accepts an empty array', () => {
      const result = validateSettlementQuoteRequest({
        usdAmount: '50',
        recipient: RECIPIENT,
        payerHoldings: [],
      });
      expect(result.payerHoldings).toEqual([]);
    });

    it('accepts a single valid holding (with usdPrice)', () => {
      const result = validateSettlementQuoteRequest({
        usdAmount: '50',
        recipient: RECIPIENT,
        payerHoldings: [
          { mint: USDC, amountRaw: '100000000', decimals: 6, usdPrice: '1.00' },
        ],
      });
      expect(result.payerHoldings).toEqual([
        { mint: USDC, amountRaw: '100000000', decimals: 6, usdPrice: '1.00' },
      ]);
    });

    it('accepts a valid holding without usdPrice', () => {
      const result = validateSettlementQuoteRequest({
        usdAmount: '50',
        recipient: RECIPIENT,
        payerHoldings: [{ mint: SOL, amountRaw: '1000000000', decimals: 9 }],
      });
      expect(result.payerHoldings).toEqual([
        { mint: SOL, amountRaw: '1000000000', decimals: 9 },
      ]);
    });

    it('rejects non-array payerHoldings', () => {
      expect(workflowError(() => validateSettlementQuoteRequest({
        usdAmount: '50', recipient: RECIPIENT, payerHoldings: 'oops',
      }))).toMatchObject({ code: 'invalid_array', path: '$.payerHoldings' });
    });

    it('rejects a holding entry that is not an object', () => {
      expect(workflowError(() => validateSettlementQuoteRequest({
        usdAmount: '50', recipient: RECIPIENT, payerHoldings: ['not-an-object'],
      }))).toMatchObject({ code: 'invalid_object', path: '$.payerHoldings[0]' });
    });

    it('rejects a holding with a missing mint', () => {
      expect(workflowError(() => validateSettlementQuoteRequest({
        usdAmount: '50', recipient: RECIPIENT,
        payerHoldings: [{ amountRaw: '100', decimals: 6 }],
      }))).toMatchObject({ code: 'invalid_pubkey', path: '$.payerHoldings[0].mint' });
    });

    it('rejects a holding whose amountRaw is a decimal', () => {
      expect(workflowError(() => validateSettlementQuoteRequest({
        usdAmount: '50', recipient: RECIPIENT,
        payerHoldings: [{ mint: USDC, amountRaw: '1.5', decimals: 6 }],
      }))).toMatchObject({ code: 'invalid_integer_string', path: '$.payerHoldings[0].amountRaw' });
    });

    it('rejects a holding whose decimals are out of range', () => {
      expect(workflowError(() => validateSettlementQuoteRequest({
        usdAmount: '50', recipient: RECIPIENT,
        payerHoldings: [{ mint: USDC, amountRaw: '1', decimals: 19 }],
      }))).toMatchObject({ code: 'out_of_range', path: '$.payerHoldings[0].decimals' });
    });

    it('rejects a holding whose usdPrice is negative', () => {
      expect(workflowError(() => validateSettlementQuoteRequest({
        usdAmount: '50', recipient: RECIPIENT,
        payerHoldings: [{ mint: USDC, amountRaw: '1', decimals: 6, usdPrice: '-1' }],
      }))).toMatchObject({ code: 'invalid_decimal', path: '$.payerHoldings[0].usdPrice' });
    });

    it('detects forbidden secrets nested inside a holding', () => {
      expect(workflowError(() => validateSettlementQuoteRequest({
        usdAmount: '50', recipient: RECIPIENT,
        payerHoldings: [{ mint: USDC, amountRaw: '1', decimals: 6, privateKey: 'leak' }],
      }))).toMatchObject({ code: 'forbidden_secret' });
    });
  });
});
