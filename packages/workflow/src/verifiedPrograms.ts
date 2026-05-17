/**
 * Allowlist of Solana program IDs the agent considers known/verified for the purpose of
 * pre-sign transaction simulation. When a simulated transaction writes to an account owned
 * by a program ID that is NOT in this set, the agent treats it as a deny signal.
 *
 * IDs in this file come from:
 *   - Universally known Solana programs (system, token, etc.).
 *   - First-class connector adapter constants in packages/mcp-server/src/adapters/<name>/constants.ts.
 *
 * Conservative posture: when in doubt, leave a program out. A missing ID just means the
 * agent will surface a deny signal; the user can override via a deliberate policy if they
 * trust the protocol. A wrongly-included ID would silently approve a malicious program.
 */
export const VERIFIED_PROGRAM_IDS: ReadonlySet<string> = Object.freeze(new Set<string>([
  // ── Solana native ─────────────────────────────────────────────────────────────
  '11111111111111111111111111111111',                          // System
  'ComputeBudget111111111111111111111111111111',               // ComputeBudget
  'Stake11111111111111111111111111111111111111',               // Stake
  'Vote111111111111111111111111111111111111111',               // Vote
  // ── SPL ──────────────────────────────────────────────────────────────────────
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',               // SPL Token
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',               // SPL Token-2022
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',              // SPL Associated Token Account
  'SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy',               // SPL Stake Pool
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',               // SPL Memo v1
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',               // SPL Memo v2
  // ── Jupiter family (from packages/mcp-server/src/adapters/jupiter/constants.ts) ─
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',               // Jupiter Aggregator v6 (main swap)
  'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',               // Jupiter Aggregator v4 (legacy swap)
  'jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9',               // Jupiter Lend Earn
  'jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC',               // Jupiter Lend Liquidity
  'jupnw4B6Eqs7ft6rxpzYLJZYSnrpRgPcr589n5Kv4oc',               // Jupiter Lend Oracle
  'jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi',               // Jupiter Lend Borrow
  'jupgfSgfuAXv4B6R2Uxu85Z1qdzgju79s6MfZekN6XS',               // Jupiter Lend Flashloan
  // ── Lending / yield ──────────────────────────────────────────────────────────
  'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD',               // Kamino Lend
  'MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA',               // Marginfi v2 / Project0
  'So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo',               // Save (Solend)
  // ── DEX / liquidity ──────────────────────────────────────────────────────────
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',              // Raydium AMM v4
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',              // Raydium CPMM
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',              // Raydium CLMM
  'EhhTKczWMGQt46ynNeRX1WfeagwwJd7ufHvCDjRxjo5Q',              // Raydium Farm v3
  'CBuCnLe26faBpcBP2fktp4rp8abpcAnTWft6ZrP5Q4T',               // Raydium Farm v4
  '9KEPoZmtHUrBbhWN1v1KWLMkkvwY6WLtAVUCPRtRjP4z',              // Raydium Farm v5
  'FarmqiPv5eAj3j1GMdMCMUGXqPUvmquZtMy86QH6rzhG',              // Raydium Farm v6
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',               // Orca Whirlpools
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',               // Meteora DLMM
  // ── Staking / LST ────────────────────────────────────────────────────────────
  'MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD',               // Marinade
  '5TAiuAh3YGDbwjEruC1ZpXTJWdNDS7Ur7VeqNNiHMmGV',               // Jito Stake Pool Deposit Interceptor
  // (Jito uses SPL Stake Pool above for staking ops.)
  // ── Perps / vaults ───────────────────────────────────────────────────────────
  'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH',               // Drift
  'vAuLTsyrvSfZRuRB3XgvkPwNGgYSs9YRYymVebLKoxR',               // Drift Vaults (legacy)
  'JCNCMFXo5M5qwUPg2Utu1u6YWp3MbygxqBsBeXXJfrw',               // Drift Vaults (current)
  // ── NFT marketplaces ─────────────────────────────────────────────────────────
  'TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp',               // Tensor Marketplace (TCOMP)
  'TAMM6ub33ij1mbetoMyVBLeKY5iP41i4UPUJQGkhfsg',               // Tensor AMM
  'TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN',               // Tensor Escrow / Tensorswap
  'TL1ST2iRBzuGTqLn1KXnGdSnEow62BzPnGiqyRXhWtW',               // Tensor Whitelist
  'TFEEgwDP6nn1s8mMX2tTNPPz8j2VomkphLUmyxKm17A',               // Tensor Fees
  // ── Bridge ───────────────────────────────────────────────────────────────────
  'worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth',               // Wormhole Core Bridge
  'wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb',               // Wormhole Token Bridge
  // ── Governance / multisig ────────────────────────────────────────────────────
  'vsr2nfGVNHmSY8uxoBGqq8AQbwz3JwaEaHqGVsjCdYC',               // Realms VSR
  'SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu',                // Squads v4 (multisig)
]));

/**
 * Returns true when the program id is on the verified list.
 * Convenience wrapper so callers don't need to import the Set directly.
 */
export function isVerifiedProgramId(programId: string): boolean {
  return VERIFIED_PROGRAM_IDS.has(programId);
}
