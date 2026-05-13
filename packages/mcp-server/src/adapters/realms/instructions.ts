import type { ProposalInstructionDecoded, ProposalInstructionRaw } from './client.js';
import { SPL_GOVERNANCE_PROGRAM_ID } from './constants.js';

// Well-known mainnet program ids. We surface a name hint for instructions that
// target these programs, but we never claim to know what an unknown instruction
// will do — `decoded` stays false unless this module recognizes the program
// AND can parse the instruction data.
const KNOWN_PROGRAM_HINTS: Record<string, string> = {
  '11111111111111111111111111111111': 'system_program',
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'spl_token',
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: 'spl_token_2022',
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: 'spl_associated_token',
  ComputeBudget111111111111111111111111111111: 'compute_budget',
  Stake11111111111111111111111111111111111111: 'stake_program',
  metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s: 'metaplex_token_metadata',
  [SPL_GOVERNANCE_PROGRAM_ID.toBase58()]: 'spl_governance',
};

export function knownProgramHint(programId: string): string | undefined {
  return KNOWN_PROGRAM_HINTS[programId];
}

export function decodeInstructions(
  rawInstructions: ProposalInstructionRaw[],
): ProposalInstructionDecoded[] {
  return rawInstructions.map((raw) => {
    const hint = knownProgramHint(raw.programId);
    return {
      index: raw.index,
      programId: raw.programId,
      decoded: false,
      ...(hint !== undefined && { hint }),
    };
  });
}
