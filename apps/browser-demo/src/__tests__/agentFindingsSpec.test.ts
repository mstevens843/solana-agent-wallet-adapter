import { describe, expect, it } from 'vitest';

import { reviewEvidenceRows } from '../agentReviewPresentation.js';
import {
  DEFAULT_SPEC,
  FINDINGS_SPEC,
  findingsSpecFor,
} from '../agentFindingsSpec.js';

const SAMPLE_FACTS = {
  route: {
    state: 'checked' as const,
    message: 'SOL -> USDC; exact venue route resolves from the Jupiter quote.',
  },
  quote: {
    state: 'missing' as const,
    message: 'No quote fetched in the browser yet for this draft; this is not user input.',
  },
  protocol: {
    state: 'ok' as const,
    message: 'Browser swaps execute through Jupiter; Jupiter chooses the venue route when the quote/order is fetched.',
  },
  protocolConnector: {
    state: 'ok' as const,
    message: 'Kamino connector is enabled for mainnet-beta.',
  },
  tokenMint: {
    state: 'checked' as const,
    message: 'Token SOL is in the local token map',
  },
  simulation: {
    state: 'missing' as const,
    message: 'Transaction simulation runs after the wallet signs and broadcasts.',
  },
  limits: {
    state: 'ok' as const,
    message: 'Max slippage 50 bps (0.50%)',
  },
  recipient: {
    state: 'ok' as const,
    message: 'Recipient is a known wallet.',
  },
  schedule: {
    state: 'checked' as const,
    message: 'Repeat schedule: weekly, mon, max 12 occurrences.',
  },
};

describe('findingsSpecFor', () => {
  it('returns the default spec for unknown action types', () => {
    expect(findingsSpecFor('totally_unknown')).toBe(DEFAULT_SPEC);
    expect(findingsSpecFor(undefined)).toBe(DEFAULT_SPEC);
  });

  it('exposes a swap-shaped slot list for swap', () => {
    expect(findingsSpecFor('swap').slots).toEqual([
      'protocol',
      'route',
      'quote',
      'tokenMint',
      'limits',
      'simulation',
    ]);
  });

  it('classifies kamino_deposit with a single-role token and no swap slots', () => {
    const spec = findingsSpecFor('kamino_deposit');
    expect(spec.singleTokenRole).toBe(true);
    expect(spec.slots).not.toContain('route');
    expect(spec.slots).not.toContain('quote');
    expect(spec.slots).not.toContain('protocol');
    expect(spec.slots).not.toContain('limits');
    expect(spec.slots).toContain('protocolConnector');
    expect(spec.slots).toContain('tokenMint');
    expect(spec.slots).toContain('simulation');
    expect(spec.labels?.tokenMint).toBe('Supply token');
  });

  it('classifies kamino_withdraw with a Redeem-token label', () => {
    expect(findingsSpecFor('kamino_withdraw').labels?.tokenMint).toBe('Redeem token');
  });

  it('covers the first-class connector action types we ship from the connector drafting forms', () => {
    const required = [
      'swap',
      'kamino_deposit',
      'kamino_withdraw',
      'drift_vault_deposit',
      'drift_vault_request_withdraw',
      'drift_vault_cancel_withdraw',
      'drift_vault_complete_withdraw',
      'transfer_sol',
      'transfer_spl',
      'recurring_payment',
      'blink_action',
      'read_only',
      'manual_review',
    ];
    for (const actionType of required) {
      expect(FINDINGS_SPEC[actionType], `missing spec for ${actionType}`).toBeDefined();
    }
  });
});

describe('reviewEvidenceRows with per-template findings spec', () => {
  it('suppresses route/quote/protocol/limits rows for kamino_deposit even when the facts are populated', () => {
    const rows = reviewEvidenceRows({
      status: 'denied',
      facts: SAMPLE_FACTS,
    }, { actionType: 'kamino_deposit' });

    const labels = rows.map((row) => row.label);
    expect(labels).not.toContain('Route');
    expect(labels).not.toContain('Quote');
    expect(labels).not.toContain('Protocol');
    expect(labels).not.toContain('Limits');
  });

  it('renders the kamino_deposit findings as Connector + Supply token + Simulation', () => {
    const rows = reviewEvidenceRows({
      status: 'approved',
      facts: {
        protocolConnector: SAMPLE_FACTS.protocolConnector,
        tokenMint: SAMPLE_FACTS.tokenMint,
        simulation: SAMPLE_FACTS.simulation,
      },
    }, { actionType: 'kamino_deposit' });

    expect(rows.map((row) => row.label)).toEqual([
      'Connector',
      'Supply token',
      'Simulation',
    ]);
  });

  it('renders the full swap slot order for a swap draft', () => {
    const rows = reviewEvidenceRows({
      status: 'approved',
      facts: SAMPLE_FACTS,
    }, { actionType: 'swap' });

    const labels = rows.map((row) => row.label);
    expect(labels).toContain('Protocol');
    expect(labels).toContain('Route');
    expect(labels).toContain('Quote');
    expect(labels).toContain('Token mint');
    expect(labels).toContain('Limits');
    expect(labels).toContain('Simulation');
  });

  it('renders schedule + recipient + tokenMint for recurring_payment but not swap slots', () => {
    const rows = reviewEvidenceRows({
      status: 'approved',
      facts: {
        recipient: SAMPLE_FACTS.recipient,
        tokenMint: SAMPLE_FACTS.tokenMint,
        schedule: SAMPLE_FACTS.schedule,
        simulation: SAMPLE_FACTS.simulation,
        route: SAMPLE_FACTS.route,
      },
    }, { actionType: 'recurring_payment' });

    const labels = rows.map((row) => row.label);
    expect(labels).toContain('Recipient');
    expect(labels).toContain('Token mint');
    expect(labels).toContain('Schedule');
    expect(labels).toContain('Simulation');
    expect(labels).not.toContain('Route');
  });

  it('falls back to default spec for an unknown action type', () => {
    const rows = reviewEvidenceRows({
      status: 'approved',
      facts: {
        protocolConnector: SAMPLE_FACTS.protocolConnector,
        tokenMint: SAMPLE_FACTS.tokenMint,
        simulation: SAMPLE_FACTS.simulation,
        route: SAMPLE_FACTS.route,
      },
    }, { actionType: 'totally_unknown_action' });

    const labels = rows.map((row) => row.label);
    expect(labels).toEqual(['Connector', 'Token mint', 'Simulation']);
  });
});
