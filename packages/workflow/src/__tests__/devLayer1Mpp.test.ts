import { describe, expect, it } from 'vitest';

import { WorkflowValidationError } from '../index.js';
import { validateCreateMppRequest } from '../dev/mpp.js';

const RECIPIENT = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function challenge(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: 'mpp/0.1',
    nonce: 'mpp_nonce_1',
    amount: '2.50',
    currency: 'USDC',
    resourceUrl: 'https://merchant.example/resource/123',
    expiresAt: '2020-01-01T00:00:00.000Z',
    paymentMethods: [
      {
        kind: 'solana-spl',
        mint: USDC_MINT,
        recipient: RECIPIENT,
        network: 'devnet',
      },
    ],
    merchant: { id: 'merchant_1', name: 'Acme' },
    ...overrides,
  };
}

function workflowError(action: () => unknown): WorkflowValidationError {
  try {
    action();
  } catch (err) {
    expect(err).toBeInstanceOf(WorkflowValidationError);
    return err as WorkflowValidationError;
  }
  throw new Error('Expected WorkflowValidationError.');
}

describe('validateCreateMppRequest', () => {
  it('parses a well-shaped request without applying wall-clock expiry policy', () => {
    const out = validateCreateMppRequest({ challenge: challenge(), cluster: 'devnet', agentLabel: 'Acme Agent' });
    expect(out.challenge.nonce).toBe('mpp_nonce_1');
    expect(out.challenge.expiresAt).toBe('2020-01-01T00:00:00.000Z');
    expect(out.cluster).toBe('devnet');
    expect(out.agentLabel).toBe('Acme Agent');
    expect(out.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('rejects missing challenges and forbidden secrets', () => {
    expect(workflowError(() => validateCreateMppRequest({}))).toMatchObject({
      code: 'missing_mpp_challenge',
      path: '$.challenge',
    });
    expect(workflowError(() => validateCreateMppRequest({ challenge: { ...challenge(), privateKey: 'nope' } }))).toMatchObject({
      code: 'forbidden_secret',
    });
  });

  it('wraps parser failures and validates optional cluster', () => {
    expect(workflowError(() => validateCreateMppRequest({ challenge: challenge({ amount: '0' }) })).code)
      .toMatch(/^invalid_mpp_challenge:/);
    expect(workflowError(() => validateCreateMppRequest({ challenge: challenge(), cluster: 'mars-1' }))).toMatchObject({
      code: 'invalid_cluster',
    });
  });
});
