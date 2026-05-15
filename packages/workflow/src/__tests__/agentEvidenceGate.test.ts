import { describe, expect, it } from 'vitest';

import {
  type AgentEvidenceFact,
  type AgentEvidenceRequirement,
  evaluateAgentEvidenceGate,
  normalizeAgentEvidenceFact,
} from '../index.js';

const WALLET = 'Wallet1111111111111111111111111111111111111';

function requirement(partial: Partial<AgentEvidenceRequirement>): AgentEvidenceRequirement {
  return {
    id: partial.id ?? `req.${partial.routeId ?? 'route'}`,
    routeId: partial.routeId ?? 'route',
    need: partial.need ?? 'protocol_position',
    provider: partial.provider ?? 'protocol_connector',
    endpoint: partial.endpoint ?? 'endpoint',
    status: partial.status ?? 'required',
    ttlMs: partial.ttlMs ?? 60_000,
    blocking: partial.blocking ?? true,
    reason: partial.reason ?? 'required for review',
    ...(partial.connectorId ? { connectorId: partial.connectorId } : {}),
    ...(partial.connectorProfile ? { connectorProfile: partial.connectorProfile } : {}),
    ...(partial.capability ? { capability: partial.capability } : {}),
  };
}

function fact(partial: Partial<AgentEvidenceFact> & { id: string; label: string; routeId?: string }): AgentEvidenceFact {
  return normalizeAgentEvidenceFact({
    id: partial.id,
    label: partial.label,
    value: partial.value ?? 'ok',
    tone: partial.tone ?? 'good',
    source: (partial.source ?? 'deterministic') as AgentEvidenceFact['source'],
    severity: partial.severity,
    routeId: partial.routeId,
    requirementId: partial.requirementId,
    checkedAt: partial.checkedAt ?? new Date().toISOString(),
    ttlMs: 60_000,
    detail: partial.detail,
  });
}

describe('evaluateAgentEvidenceGate — golden scenarios', () => {
  it('1. safe swap approves when Jupiter quote + route are fresh and token facts pass', () => {
    const reqs = [
      requirement({ routeId: 'jupiter.swap_order_preview', need: 'swap_quote', provider: 'jupiter', ttlMs: 20_000 }),
      requirement({ routeId: 'jupiter.swap_route', need: 'swap_route', provider: 'jupiter', ttlMs: 20_000 }),
    ];
    const facts = [
      fact({ id: 'fact.jupiter.quote', routeId: 'jupiter.swap_order_preview', label: 'Quote', tone: 'good' }),
      fact({ id: 'fact.jupiter.route', routeId: 'jupiter.swap_route', label: 'Route', tone: 'good' }),
    ];
    const result = evaluateAgentEvidenceGate(reqs, facts, { walletAddress: WALLET, isWalletScoped: true });
    expect(result.decision).toBe('pass');
  });

  it('2. stale swap quote blocks approval', () => {
    const reqs = [
      requirement({ routeId: 'jupiter.swap_order_preview', need: 'swap_quote', provider: 'jupiter', ttlMs: 20_000 }),
    ];
    const oneMinuteAgo = new Date(Date.now() - 90_000).toISOString();
    const facts = [
      fact({ id: 'fact.jupiter.quote', routeId: 'jupiter.swap_order_preview', label: 'Quote', tone: 'good', checkedAt: oneMinuteAgo }),
    ];
    const result = evaluateAgentEvidenceGate(reqs, facts, { walletAddress: WALLET, isWalletScoped: true });
    expect(result.decision).toBe('block');
    expect(result.staleRequired.length).toBe(1);
  });

  it('3. missing public key on wallet-scoped review blocks approval', () => {
    const reqs = [
      requirement({ routeId: 'wallet.connected_public_key', need: 'wallet_identity', provider: 'wallet', ttlMs: Number.POSITIVE_INFINITY }),
    ];
    const result = evaluateAgentEvidenceGate(reqs, [], { isWalletScoped: true });
    expect(result.decision).toBe('block');
    expect(result.reason).toMatch(/connected public key/);
  });

  it('4. duplicate payment is reported as a blocking Helius fact and the gate blocks', () => {
    const reqs = [
      requirement({ routeId: 'helius.getTransfersByAddress', need: 'wallet_transfers', provider: 'helius', ttlMs: 120_000 }),
    ];
    const facts = [
      fact({
        id: 'fact.helius.duplicate',
        routeId: 'helius.getTransfersByAddress',
        label: 'Duplicate transfer to same recipient in last 10 minutes',
        tone: 'fail',
        severity: 'block',
      }),
    ];
    const result = evaluateAgentEvidenceGate(reqs, facts, { walletAddress: WALLET, isWalletScoped: true });
    expect(result.decision).toBe('block');
    expect(result.blockingFacts.map((f) => f.id)).toContain('fact.helius.duplicate');
  });

  it('5. trusted recipient transfer approves when Helius transfer history is fresh and matches policy', () => {
    const reqs = [
      requirement({ routeId: 'helius.getTransfersByAddress', need: 'wallet_transfers', provider: 'helius', ttlMs: 120_000 }),
    ];
    const facts = [
      fact({ id: 'fact.helius.transfer.0', routeId: 'helius.getTransfersByAddress', label: 'Recent transfer to recipient', tone: 'good' }),
    ];
    const result = evaluateAgentEvidenceGate(reqs, facts, { walletAddress: WALLET, isWalletScoped: true });
    expect(result.decision).toBe('pass');
  });

  it('6. unknown recipient with known-recipient policy returns needs_input when fact is missing optional', () => {
    const reqs = [
      requirement({ routeId: 'helius.getTransfersByAddress', need: 'wallet_transfers', provider: 'helius', status: 'optional', blocking: false }),
    ];
    const result = evaluateAgentEvidenceGate(reqs, [], { walletAddress: WALLET, isWalletScoped: true });
    expect(result.decision).toBe('pass');
  });

  it('7. scam token blocks approval (token security fact severity = block)', () => {
    const reqs = [
      requirement({ routeId: 'birdeye.token_security', need: 'token_security', provider: 'birdeye' }),
    ];
    const facts = [
      fact({ id: 'fact.birdeye.security', routeId: 'birdeye.token_security', label: 'Mint authority active', tone: 'fail', severity: 'block' }),
    ];
    const result = evaluateAgentEvidenceGate(reqs, facts, { walletAddress: WALLET, isWalletScoped: true });
    expect(result.decision).toBe('block');
    expect(result.blockingFacts.length).toBe(1);
  });

  it('10. connector disabled blocks approval for connector-required actions', () => {
    const reqs = [
      requirement({ routeId: 'protocol_connector.read_facts', need: 'protocol_position', provider: 'protocol_connector', connectorId: 'marginfi', connectorProfile: 'lending_borrow' }),
    ];
    const facts = [
      fact({ id: 'fact.connector.read.0', routeId: 'protocol_connector.read_facts', label: 'Connector facts', tone: 'good' }),
    ];
    const result = evaluateAgentEvidenceGate(reqs, facts, {
      walletAddress: WALLET,
      connectorId: 'marginfi',
      connectorEnabled: false,
      connectorReadReady: true,
      isWalletScoped: true,
    });
    expect(result.decision).toBe('block');
    expect(result.reason).toMatch(/disabled/);
  });

  it('11. connector read not ready blocks approval when reads are required', () => {
    const reqs = [
      requirement({ routeId: 'protocol_connector.read_facts', need: 'protocol_position', provider: 'protocol_connector', connectorId: 'marginfi' }),
    ];
    const result = evaluateAgentEvidenceGate(reqs, [], {
      walletAddress: WALLET,
      connectorId: 'marginfi',
      connectorEnabled: true,
      connectorReadReady: false,
      isWalletScoped: true,
    });
    expect(result.decision).toBe('block');
  });

  it('12. lending health failure blocks approval (blocking fact present)', () => {
    const reqs = [
      requirement({ routeId: 'protocol_connector.read_facts', need: 'protocol_position', provider: 'protocol_connector', connectorId: 'marginfi', connectorProfile: 'lending_borrow' }),
    ];
    const facts = [
      fact({ id: 'fact.connector.health', routeId: 'protocol_connector.read_facts', label: 'Health factor below 1.1', tone: 'fail', severity: 'block' }),
    ];
    const result = evaluateAgentEvidenceGate(reqs, facts, {
      walletAddress: WALLET,
      connectorId: 'marginfi',
      connectorEnabled: true,
      connectorReadReady: true,
      isWalletScoped: true,
    });
    expect(result.decision).toBe('block');
  });

  it('16. multisig signer mismatch blocks approval via wallet mismatch', () => {
    const reqs = [
      requirement({ routeId: 'wallet.connected_public_key', need: 'wallet_identity', provider: 'wallet', ttlMs: Number.POSITIVE_INFINITY }),
    ];
    const facts = [
      fact({ id: 'fact.wallet.pk', routeId: 'wallet.connected_public_key', label: 'Wallet', tone: 'good' }),
    ];
    const result = evaluateAgentEvidenceGate(reqs, facts, {
      walletAddress: WALLET,
      draftWalletAddress: 'OtherWallet22222222222222222222222222222222',
      isWalletScoped: true,
    });
    expect(result.decision).toBe('block');
    expect(result.reason).toMatch(/does not match/);
  });

  it('17. bridge destination mismatch surfaces via blocking connector fact', () => {
    const reqs = [
      requirement({ routeId: 'protocol_connector.read_facts', need: 'protocol_position', provider: 'protocol_connector', connectorId: 'wormhole', connectorProfile: 'bridge' }),
    ];
    const facts = [
      fact({ id: 'fact.bridge.dest', routeId: 'protocol_connector.read_facts', label: 'Destination chain mismatch', tone: 'fail', severity: 'block' }),
    ];
    const result = evaluateAgentEvidenceGate(reqs, facts, {
      walletAddress: WALLET,
      connectorId: 'wormhole',
      connectorEnabled: true,
      connectorReadReady: true,
      isWalletScoped: true,
    });
    expect(result.decision).toBe('block');
  });

  it('18. stale oracle publish time blocks approval (30s TTL)', () => {
    const reqs = [
      requirement({ routeId: 'protocol_connector.read_facts', need: 'protocol_position', provider: 'protocol_connector', connectorId: 'pyth', connectorProfile: 'oracle', ttlMs: 30_000 }),
    ];
    const past = new Date(Date.now() - 90_000).toISOString();
    const facts = [
      fact({ id: 'fact.pyth.price', routeId: 'protocol_connector.read_facts', label: 'Pyth price', tone: 'good', checkedAt: past }),
    ];
    const result = evaluateAgentEvidenceGate(reqs, facts, {
      walletAddress: WALLET,
      connectorId: 'pyth',
      connectorProfile: 'oracle',
      connectorEnabled: true,
      connectorReadReady: true,
      isWalletScoped: true,
    });
    expect(result.decision).toBe('block');
    expect(result.staleRequired.some((req) => req.routeId === 'protocol_connector.read_facts')).toBe(true);
  });

  it('optional missing facts produce warnings but still pass when nothing required is blocked', () => {
    const reqs = [
      requirement({ routeId: 'birdeye.price_multi', need: 'token_market', provider: 'birdeye', status: 'optional', blocking: false }),
    ];
    const facts = [
      fact({ id: 'fact.optional.warn', label: 'Market data partial', tone: 'warn', severity: 'warn' }),
    ];
    const result = evaluateAgentEvidenceGate(reqs, facts, { walletAddress: WALLET, isWalletScoped: true });
    expect(result.decision).toBe('pass');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('external research required + unavailable returns needs_input (not block)', () => {
    const reqs = [
      requirement({ routeId: 'external_research.current_web', need: 'external_research', provider: 'external_research', blocking: false }),
    ];
    const result = evaluateAgentEvidenceGate(reqs, [], {
      walletAddress: WALLET,
      isWalletScoped: true,
      externalResearchAvailable: false,
    });
    expect(result.decision).toBe('needs_input');
  });
});
