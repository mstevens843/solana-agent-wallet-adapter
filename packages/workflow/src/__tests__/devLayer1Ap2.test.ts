import { describe, expect, it } from 'vitest';

import { WorkflowValidationError } from '../index.js';
import { validateCreateAp2InboundRequest } from '../dev/ap2.js';

function workflowError(action: () => unknown): WorkflowValidationError {
  try {
    action();
  } catch (err) {
    expect(err).toBeInstanceOf(WorkflowValidationError);
    return err as WorkflowValidationError;
  }
  throw new Error('Expected WorkflowValidationError.');
}

const RECIPIENT = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const AGENT_PUBKEY = '8ZUczUAUSZvMQdpiNPbBNXyrhzHebzMqTNa3qcc5jZ7v';
const SIGNATURE_B58 =
  '4uQeVj5tqViQh7yJrAuTeKrgEr4cAhuv9k9Y2g8e3CXyQwTvCu8eUgRPVqXuJh1XmnL3HxF8jt9pXjqfVZdLkA8R';

function intentMandate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const signedFields = {
    mandateId: '01J0AP2INBOUND01',
    mandateType: 'intent_mandate',
    protocolVersion: 'ap2/0.1',
    issuedAt: '2026-05-14T10:00:00.000Z',
    expiresAt: '2026-05-14T11:00:00.000Z',
    intent: {
      description: 'Subscription Tier B',
      cap: {
        amount: '12.50',
        tokenSymbol: 'USDC',
        tokenMint: USDC_MINT,
        recipient: RECIPIENT,
        cluster: 'mainnet-beta',
      },
    },
  };
  return {
    mandateId: '01J0AP2INBOUND01',
    mandateType: 'intent_mandate',
    protocolVersion: 'ap2/0.1',
    issuedAt: '2026-05-14T10:00:00.000Z',
    expiresAt: '2026-05-14T11:00:00.000Z',
    agent: { agentId: 'did:web:m', agentLabel: 'Acme', publicKey: AGENT_PUBKEY },
    intent: signedFields.intent,
    signature: SIGNATURE_B58,
    signedFields,
    ...overrides,
  };
}

describe('validateCreateAp2InboundRequest', () => {
  it('accepts a minimal valid request and stamps receivedAt', () => {
    const out = validateCreateAp2InboundRequest({ mandate: intentMandate() });
    expect(out.mandate.mandateType).toBe('intent_mandate');
    expect(out.mandate.mandateId).toBe('01J0AP2INBOUND01');
    expect(out.cluster).toBeUndefined();
    expect(out.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('threads through optional cluster', () => {
    const out = validateCreateAp2InboundRequest({ mandate: intentMandate(), cluster: 'devnet' });
    expect(out.cluster).toBe('devnet');
  });

  it('rejects non-object body', () => {
    expect(workflowError(() => validateCreateAp2InboundRequest('hello'))).toMatchObject({
      code: 'invalid_object',
    });
  });

  it('rejects missing mandate', () => {
    expect(workflowError(() => validateCreateAp2InboundRequest({}))).toMatchObject({
      code: 'missing_ap2_mandate',
      path: '$.mandate',
    });
  });

  it('wraps Ap2ParseError as WorkflowValidationError', () => {
    const broken = intentMandate({ mandateType: 'unknown_mandate' });
    const err = workflowError(() => validateCreateAp2InboundRequest({ mandate: broken }));
    expect(err.code.startsWith('invalid_ap2_mandate:')).toBe(true);
  });

  it('rejects forbidden secrets in mandate before parsing', () => {
    const broken = intentMandate();
    (broken as Record<string, unknown>).privateKey = 'hunter2';
    expect(workflowError(() => validateCreateAp2InboundRequest({ mandate: broken }))).toMatchObject({
      code: 'forbidden_secret',
    });
  });

  it('rejects forbidden secrets at request root', () => {
    expect(
      workflowError(() => validateCreateAp2InboundRequest({ mandate: intentMandate(), seedPhrase: 'oops' })),
    ).toMatchObject({ code: 'forbidden_secret' });
  });

  it('rejects unknown cluster strings', () => {
    expect(
      workflowError(() => validateCreateAp2InboundRequest({ mandate: intentMandate(), cluster: 'mars-1' })),
    ).toMatchObject({ code: 'invalid_cluster' });
  });
});
