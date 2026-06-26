import { describe, expect, it } from 'vitest';

import { compactHeliusAsset } from '../helius.js';

describe('compactHeliusAsset', () => {
  it('projects a DAS NFT asset into the compact chat shape', () => {
    const out = compactHeliusAsset({
      id: 'Mint1111111111111111111111111111111111111111',
      interface: 'V1_NFT',
      content: {
        metadata: { name: 'Cool NFT #1', symbol: 'COOL', attributes: [{ trait_type: 'Background', value: 'Blue' }] },
        links: { image: 'https://img.example/1.png' },
      },
      grouping: [{ group_key: 'collection', group_value: 'Coll1111111111111111111111111111111111111111' }],
      royalty: { basis_points: 500, percent: 0.05 },
      creators: [{ address: 'Creator11111111111111111111111111111111111', share: 100, verified: true }],
      compression: { compressed: false },
      ownership: { frozen: false },
    });

    expect(out).toMatchObject({
      mint: 'Mint1111111111111111111111111111111111111111',
      name: 'Cool NFT #1',
      symbol: 'COOL',
      collection: 'Coll1111111111111111111111111111111111111111',
      image: 'https://img.example/1.png',
      interface: 'V1_NFT',
      compressed: false,
      frozen: false,
      royaltyPct: 5,
    });
    expect(out.attributes).toHaveLength(1);
    expect(out.creators?.[0]).toMatchObject({ address: 'Creator11111111111111111111111111111111111', share: 100, verified: true });
  });

  it('flags compressed assets and tolerates sparse metadata', () => {
    const out = compactHeliusAsset({
      id: 'cMint',
      compression: { compressed: true },
    });
    expect(out.mint).toBe('cMint');
    expect(out.compressed).toBe(true);
    expect(out.name).toBeUndefined();
    expect(out.attributes).toBeUndefined();
  });

  it('derives royalty % from percent when basis_points is absent', () => {
    const out = compactHeliusAsset({ id: 'm', royalty: { percent: 0.075 } });
    expect(out.royaltyPct).toBe(7.5);
  });
});
