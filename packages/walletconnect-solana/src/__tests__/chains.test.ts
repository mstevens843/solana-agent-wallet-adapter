import { describe, expect, it } from 'vitest';

import {
  clusterForChainId,
  isSolanaWalletConnectChainId,
  solanaWalletConnectChainId,
  walletStandardChainForCluster,
  type SolanaClusterId,
} from '../chains.js';

const CLUSTERS: readonly SolanaClusterId[] = ['mainnet-beta', 'devnet', 'testnet', 'localnet'];

// First 32 base58 chars of the published genesis hash for each Solana
// cluster. Mainnet & testnet's full hashes are public knowledge; devnet's
// is `EtWTRABZaYq6iMfeYKouRu166VU2xqaiTpoclWUEhWS` (note the `xqai` —
// letter `i` — not the digit `1`). These constants exist so the typo can
// never silently reappear.
const EXPECTED_CHAIN_IDS: Record<SolanaClusterId, string> = {
  'mainnet-beta': 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  devnet: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqai',
  testnet: 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z',
  localnet: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqai',
};

describe('solanaWalletConnectChainId', () => {
  it.each(CLUSTERS)('returns the canonical CAIP-2 id for %s', (cluster) => {
    expect(solanaWalletConnectChainId(cluster)).toBe(EXPECTED_CHAIN_IDS[cluster]);
  });

  it('all CAIP-2 chain IDs are 39 chars: 7-char prefix + 32-char base58 suffix', () => {
    for (const cluster of CLUSTERS) {
      const id = solanaWalletConnectChainId(cluster);
      expect(id.startsWith('solana:')).toBe(true);
      expect(id.length).toBe(7 + 32);
      // Base58 alphabet excludes 0, O, I, l.
      expect(id.slice(7)).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32}$/);
    }
  });
});

describe('isSolanaWalletConnectChainId', () => {
  it.each(CLUSTERS)('round-trips through %s', (cluster) => {
    expect(isSolanaWalletConnectChainId(solanaWalletConnectChainId(cluster))).toBe(true);
  });

  it('rejects the legacy typo form ending in xqa1 (was the broken devnet id)', () => {
    expect(isSolanaWalletConnectChainId('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1')).toBe(false);
  });

  it('rejects non-solana CAIP-2 chains', () => {
    expect(isSolanaWalletConnectChainId('eip155:1')).toBe(false);
  });

  it('rejects malformed strings', () => {
    expect(isSolanaWalletConnectChainId('')).toBe(false);
    expect(isSolanaWalletConnectChainId('solana:')).toBe(false);
  });
});

describe('clusterForChainId', () => {
  it.each(CLUSTERS)('returns %s for its canonical CAIP-2 id', (cluster) => {
    expect(clusterForChainId(solanaWalletConnectChainId(cluster))).toBe(
      // localnet & devnet share a genesis hash → clusterForChainId returns
      // whichever cluster's entry is found first; assert against the known map.
      cluster === 'localnet' ? 'devnet' : cluster,
    );
  });

  it('returns null for unknown chain IDs', () => {
    expect(clusterForChainId('solana:something-else')).toBe(null);
    expect(clusterForChainId('eip155:1')).toBe(null);
  });
});

describe('walletStandardChainForCluster', () => {
  it('maps cluster id to wallet-standard chain identifier', () => {
    expect(walletStandardChainForCluster('mainnet-beta')).toBe('solana:mainnet');
    expect(walletStandardChainForCluster('devnet')).toBe('solana:devnet');
    expect(walletStandardChainForCluster('testnet')).toBe('solana:testnet');
    expect(walletStandardChainForCluster('localnet')).toBe('solana:localnet');
  });
});
