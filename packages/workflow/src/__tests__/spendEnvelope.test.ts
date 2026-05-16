import { describe, expect, it } from 'vitest';

import {
  envelopeNextEvent,
  envelopeProtocolBadge,
  envelopeRemaining,
  envelopeStatus,
  type SpendEnvelope,
} from '../spendEnvelope.js';

describe('spendEnvelope helpers', () => {
  it('maps active approvals to needs_approval with protocol badges', () => {
    const envelope: SpendEnvelope = {
      kind: 'one-time',
      action: {
        id: 'approval_1',
        walletAddress: 'wallet',
        kind: 'transfer_spl',
        status: 'ready',
        summary: 'Pay merchant',
        params: {},
        dueAt: '2026-05-16T10:00:00.000Z',
        createdAt: '2026-05-16T09:00:00.000Z',
        updatedAt: '2026-05-16T09:00:00.000Z',
        amount: '2',
        token: 'USDC',
        metadata: { connectorId: 'mpp' },
      },
    };

    expect(envelopeStatus(envelope)).toBe('needs_approval');
    expect(envelopeProtocolBadge(envelope)).toEqual({ id: 'mpp', label: 'MPP' });
    expect(envelopeRemaining(envelope).label).toBe('2 USDC');
  });

  it('reports recurring schedule next run and remaining occurrences', () => {
    const envelope: SpendEnvelope = {
      kind: 'recurring',
      schedule: {
        id: 'recurring_1',
        status: 'active',
        walletAddress: 'wallet',
        cluster: 'devnet',
        token: 'SOL',
        recipient: 'recipient',
        amount: '0.1',
        cadence: 'interval_days',
        createdAt: '2026-05-16T09:00:00.000Z',
        updatedAt: '2026-05-16T09:00:00.000Z',
        maxOccurrences: 5,
        occurrencesCreated: 2,
        nextDueAt: '2026-05-17T09:00:00.000Z',
      },
    };

    expect(envelopeStatus(envelope)).toBe('active');
    expect(envelopeProtocolBadge(envelope)).toEqual({ id: 'scheduler', label: 'Scheduler' });
    expect(envelopeRemaining(envelope)).toMatchObject({
      label: '0.1 SOL per run, 3 left',
      remainingOccurrences: 3,
    });
    expect(envelopeNextEvent(envelope)).toEqual({ label: 'Next run', at: '2026-05-17T09:00:00.000Z' });
  });

  it('subtracts streaming spend from cap', () => {
    const envelope: SpendEnvelope = {
      kind: 'streaming',
      session: {
        id: 'stream_1',
        walletAddress: 'wallet',
        cluster: 'devnet',
        tokenMint: 'mint',
        delegatePubkey: 'delegate',
        ephemeralSignerPubkey: 'delegate',
        capAmount: '10.50',
        spentAmount: '3.25',
        expiresAt: '2026-05-16T12:00:00.000Z',
        status: 'active',
        createdAt: '2026-05-16T09:00:00.000Z',
        updatedAt: '2026-05-16T09:00:00.000Z',
        metadata: { tokenSymbol: 'USDC' },
      },
    };

    expect(envelopeStatus(envelope)).toBe('active');
    expect(envelopeProtocolBadge(envelope)).toEqual({ id: 'spl-delegate', label: 'SPL Delegate' });
    expect(envelopeRemaining(envelope)).toMatchObject({
      label: '7.25 USDC remaining',
      remaining: '7.25',
    });
  });

  it('uses a shortened mint for non-USDC streaming sessions without token metadata', () => {
    const envelope: SpendEnvelope = {
      kind: 'streaming',
      session: {
        id: 'stream_2',
        walletAddress: 'wallet',
        cluster: 'devnet',
        tokenMint: 'So11111111111111111111111111111111111111112',
        delegatePubkey: 'delegate',
        ephemeralSignerPubkey: 'delegate',
        capAmount: '5',
        spentAmount: '1.5',
        expiresAt: '2026-05-16T12:00:00.000Z',
        status: 'active',
        createdAt: '2026-05-16T09:00:00.000Z',
        updatedAt: '2026-05-16T09:00:00.000Z',
      },
    };

    expect(envelopeRemaining(envelope)).toMatchObject({
      label: '3.5 So11...1112 remaining',
      token: 'So11...1112',
      remaining: '3.5',
    });
  });
});
