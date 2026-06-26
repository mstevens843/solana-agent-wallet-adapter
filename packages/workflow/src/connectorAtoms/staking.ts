// Liquid-staking connector atoms: Jito (JitoSOL) and Marinade (mSOL). Both read via
// connectorReadFacts capability 'positions' (wallet-level, requiresClientKey: false), but
// their envelopes differ from the AMM/lending ones — Jito returns a jitoSol balance +
// native stakeAccounts; Marinade returns a snapshot (mSOL + native stakes + unstake
// tickets). So each gets its own compact projection.

import type { ConnectorActionAtom, ConnectorFactArgs } from './types.js';
import { asArray, compact, num, obj, shortMint, solFromLamports, str } from './util.js';

const walletInput = (a: ConnectorFactArgs) => compact({ ...(a.walletAddress ? { walletAddress: a.walletAddress } : {}) });

// Jito positions envelope: { jitoSol:{amount,...}, stakeAccounts: JitoStakeAccount[], totals:{...} }.
export function formatJitoStake(raw: Record<string, unknown>): Record<string, unknown> {
  const jitoSol = obj(raw.jitoSol);
  const totals = obj(raw.totals);
  const accounts = asArray(raw.stakeAccounts);
  return compact({
    kind: 'jito_stake',
    jitoSol: str(jitoSol?.amount) ?? (num(jitoSol?.amount) !== undefined ? String(num(jitoSol?.amount)) : undefined),
    stakeAccounts: num(totals?.stakeAccounts) ?? accounts.length,
    eligibleStakeAccounts: num(totals?.eligibleStakeAccounts),
    accounts: accounts.length
      ? accounts.slice(0, 6).map((s) => compact({
        account: shortMint(str(s.stakeAccount)),
        sol: solFromLamports(s.lamports),
        state: str(s.state),
        eligibleForDeposit: typeof s.eligibleForJitoDeposit === 'boolean' ? s.eligibleForJitoDeposit : undefined,
      }))
      : undefined,
  });
}

// Marinade positions envelope: { snapshot: MarinadeWalletPositionsResult } (NO top-level positions).
export function formatMarinadeStake(raw: Record<string, unknown>): Record<string, unknown> {
  const snapshot = obj(raw.snapshot) ?? raw;
  const tickets = asArray(snapshot.unstakeTickets);
  const natives = asArray(snapshot.nativeStakeAccounts);
  return compact({
    kind: 'marinade_stake',
    msol: str(snapshot.msolBalance),
    estimatedSolValue: str(snapshot.estimatedSolValue),
    nativeStakeAccounts: natives.length || undefined,
    unstakeTickets: tickets.length
      ? { count: tickets.length, claimable: tickets.filter((t) => str(t.status) === 'claimable').length }
      : undefined,
    tickets: tickets.length
      ? tickets.slice(0, 4).map((t) => compact({ status: str(t.status), sol: str(t.solAmount), claimableAt: str(t.claimableAt) }))
      : undefined,
  });
}

export const STAKING_ATOMS: ConnectorActionAtom[] = [
  {
    connectorId: 'jito',
    action: 'stake',
    aliases: ['stake', 'staking', 'jitosol', 'liquid stake', 'position', 'positions', 'unstake', 'balance'],
    knowledge: {
      title: 'Jito Liquid Staking (JitoSOL)',
      summary: 'Stake SOL for JitoSOL (MEV-boosted liquid staking); read your JitoSOL balance and native stake accounts (incl. which are eligible to deposit into the Jito pool).',
      capabilities: ['read your JitoSOL balance + native stake accounts', 'see deposit-eligibility per stake account', 'prepare stake SOL, deposit stake account, claim receipts, unstake JitoSOL, withdraw SOL'],
      requiredParams: ['walletAddress for your positions'],
      constraints: [
        'Mainnet-only; live reads need the @solana/spl-stake-pool SDK present in the runtime (otherwise unavailable)',
        'Existing stake-account deposits use the Jito stake-deposit interceptor; JitoSOL may not be delivered immediately',
        'Write actions are prepare-only and require enabling Jito in Protocol Connectors',
      ],
      enabledByDefault: true,
    },
    factSpec: {
      readTool: 'solana_jito_wallet_positions',
      capability: 'positions',
      buildInput: walletInput,
      format: formatJitoStake,
    },
  },
  {
    connectorId: 'marinade',
    action: 'stake',
    aliases: ['stake', 'staking', 'msol', 'liquid stake', 'position', 'positions', 'unstake', 'ticket', 'tickets', 'balance'],
    knowledge: {
      title: 'Marinade Liquid Staking (mSOL)',
      summary: 'Stake SOL for mSOL (liquid staking); read your mSOL balance, native stake accounts, and delayed-unstake tickets with claimable status.',
      capabilities: ['read your mSOL balance + native stake accounts + unstake tickets', 'see which tickets are claimable', 'prepare liquid stake, instant unstake (via Jupiter), delayed unstake + claim'],
      requiredParams: ['walletAddress for your positions'],
      constraints: [
        'Mainnet-only; live reads need the @marinade.finance/marinade-ts-sdk present in the runtime (otherwise unavailable)',
        'Instant mSOL→SOL unstake refreshes a Jupiter route at approval time',
        'Native stake accounts are read-only; write actions are prepare-only and require enabling Marinade in Protocol Connectors',
      ],
      enabledByDefault: true,
    },
    factSpec: {
      readTool: 'solana_marinade_wallet_positions',
      capability: 'positions',
      buildInput: walletInput,
      format: formatMarinadeStake,
    },
  },
];
