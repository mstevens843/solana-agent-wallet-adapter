import { describe, expect, it } from 'vitest';

import { mandateToApprovalParams } from '../mapper.js';
import {
  SOL_NATIVE_MINT,
  type Ap2IntentMandate,
  type Ap2PaymentMandate,
  type Ap2VerifiedAgent,
} from '../types.js';

const WALLET = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const AGENT_PUBKEY = '8ZUczUAUSZvMQdpiNPbBNXyrhzHebzMqTNa3qcc5jZ7v';

const AGENT: Ap2VerifiedAgent = {
  agentId: 'did:web:merchant.example',
  agentLabel: 'Acme',
  publicKey: AGENT_PUBKEY,
};

function intentMandate(): Ap2IntentMandate {
  return {
    mandateId: '01J0AP2INTENT01',
    mandateType: 'intent_mandate',
    protocolVersion: 'ap2/0.1',
    issuedAt: '2026-05-14T10:00:00.000Z',
    expiresAt: '2026-05-14T11:00:00.000Z',
    agent: AGENT,
    intent: {
      description: 'Subscription Tier B',
      cap: {
        amount: '12.50',
        tokenSymbol: 'USDC',
        tokenMint: USDC_MINT,
        recipient: WALLET,
        cluster: 'mainnet-beta',
        memo: 'order#123',
      },
      maxRuns: 1,
    },
    signature: '11111111111111111111111111111111',
    signedFields: {},
  };
}

function solPaymentMandate(): Ap2PaymentMandate {
  return {
    mandateId: '01J0AP2PAYMENT01',
    mandateType: 'payment_mandate',
    protocolVersion: 'ap2/0.1',
    issuedAt: '2026-05-14T10:00:00.000Z',
    expiresAt: '2026-05-14T11:00:00.000Z',
    intentMandateId: '01J0AP2INTENT01',
    agent: AGENT,
    payment: {
      amount: '0.05',
      tokenSymbol: 'SOL',
      tokenMint: SOL_NATIVE_MINT,
      recipient: WALLET,
      cluster: 'devnet',
    },
    signature: '11111111111111111111111111111111',
    signedFields: {},
  };
}

describe('mandateToApprovalParams', () => {
  it('maps a USDC IntentMandate to a transfer_spl approval', () => {
    const mandate = intentMandate();
    const result = mandateToApprovalParams(mandate, AGENT, WALLET);
    expect(result.kind).toBe('transfer_spl');
    expect(result.amount).toBe('12.50');
    expect(result.token).toBe('USDC');
    expect(result.recipient).toBe(WALLET);
    expect(result.cluster).toBe('mainnet-beta');
    expect(result.summary).toContain('Acme');
    expect(result.summary).toContain('12.50 USDC');
    expect(result.params).toMatchObject({
      fromAddress: WALLET,
      toAddress: WALLET,
      amount: '12.50',
      tokenMint: USDC_MINT,
      memo: 'order#123',
    });
    expect(result.metadata).toMatchObject({
      connectorId: 'ap2',
      operation: 'inbound_payment',
      actionSource: 'ap2_inbound',
      ap2MandateId: '01J0AP2INTENT01',
      ap2MandateType: 'intent_mandate',
      ap2VerifiedAgent: {
        agentId: AGENT.agentId,
        agentLabel: AGENT.agentLabel,
        publicKey: AGENT_PUBKEY,
        verified: true,
      },
    });
    expect(result.metadata.actionProposal).toBe(mandate);
  });

  it('emits ap2VerifiedAgent with publicKey + verified:true so the Agent 9 badge matches', () => {
    const result = mandateToApprovalParams(intentMandate(), AGENT, WALLET);
    const agentMeta = result.metadata.ap2VerifiedAgent as {
      agentId: string;
      agentLabel: string;
      publicKey: string;
      verified: boolean;
    };
    expect(agentMeta.verified).toBe(true);
    expect(agentMeta.publicKey).toBe(AGENT_PUBKEY);
  });

  it('maps a SOL PaymentMandate to a transfer_sol approval', () => {
    const mandate = solPaymentMandate();
    const result = mandateToApprovalParams(mandate, AGENT, WALLET);
    expect(result.kind).toBe('transfer_sol');
    expect(result.cluster).toBe('devnet');
    expect(result.params).not.toHaveProperty('memo');
    expect(result.metadata).toMatchObject({
      ap2MandateType: 'payment_mandate',
      ap2IntentMandateId: '01J0AP2INTENT01',
    });
  });

  it('treats tokenSymbol "sol" case-insensitively as native', () => {
    const mandate = solPaymentMandate();
    mandate.payment.tokenSymbol = 'sol';
    mandate.payment.tokenMint = 'NotTheNativeMint11111111111111111111111111';
    const result = mandateToApprovalParams(mandate, AGENT, WALLET);
    expect(result.kind).toBe('transfer_sol');
  });

  it('omits ap2IntentMandateId for IntentMandates', () => {
    const result = mandateToApprovalParams(intentMandate(), AGENT, WALLET);
    expect(result.metadata).not.toHaveProperty('ap2IntentMandateId');
  });
});
