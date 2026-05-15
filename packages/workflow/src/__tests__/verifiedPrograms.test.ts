import { describe, expect, it } from 'vitest';

import { VERIFIED_PROGRAM_IDS, isVerifiedProgramId } from '../verifiedPrograms.js';

describe('VERIFIED_PROGRAM_IDS', () => {
  it('includes Solana native programs', () => {
    expect(isVerifiedProgramId('11111111111111111111111111111111')).toBe(true);
    expect(isVerifiedProgramId('ComputeBudget111111111111111111111111111111')).toBe(true);
    expect(isVerifiedProgramId('Stake11111111111111111111111111111111111111')).toBe(true);
  });

  it('includes SPL Token and Token-2022', () => {
    expect(isVerifiedProgramId('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')).toBe(true);
    expect(isVerifiedProgramId('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')).toBe(true);
    expect(isVerifiedProgramId('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')).toBe(true);
  });

  it('includes connector adapter program IDs', () => {
    // From adapters/kamino/constants.ts
    expect(isVerifiedProgramId('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD')).toBe(true);
    // From adapters/marginfi/constants.ts (also project0)
    expect(isVerifiedProgramId('MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA')).toBe(true);
    // From adapters/raydium/constants.ts (CLMM)
    expect(isVerifiedProgramId('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK')).toBe(true);
    // From adapters/orca/constants.ts
    expect(isVerifiedProgramId('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc')).toBe(true);
    // From adapters/wormhole/constants.ts
    expect(isVerifiedProgramId('wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb')).toBe(true);
    // From adapters/squads/constants.ts
    expect(isVerifiedProgramId('SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu')).toBe(true);
  });

  it('rejects unknown / random program ids', () => {
    expect(isVerifiedProgramId('UnknownPgm1111111111111111111111111111111111')).toBe(false);
    expect(isVerifiedProgramId('')).toBe(false);
    expect(isVerifiedProgramId('not-a-base58-id')).toBe(false);
  });

  it('exposes the set as readonly', () => {
    expect(VERIFIED_PROGRAM_IDS.size).toBeGreaterThan(30);
  });
});
