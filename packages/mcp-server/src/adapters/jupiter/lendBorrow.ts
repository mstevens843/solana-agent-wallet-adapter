import { AdapterError } from '../types.js';
import type { AgentWalletConfig } from '../../config.js';

import {
  DEFAULT_JUPITER_MAX_BORROW_LTV_BPS,
  DEFAULT_JUPITER_MIN_BORROW_HEALTH_RATIO,
  JUPITER_ADAPTER_ID,
} from './constants.js';
import {
  getJupiterLendClient,
  type JupiterLendBorrowHealthPreview,
  type JupiterLendBorrowPositionSnapshot,
  type JupiterLendBorrowVaultSnapshot,
} from './lendClient.js';

export interface ListBorrowVaultsInput {
  vaultId?: number;
  supplyMint?: string;
  borrowMint?: string;
  includeUnavailable?: boolean;
}

export interface BorrowPositionsInput {
  walletAddress: string;
  vaultId?: number;
  positionId?: number;
}

export interface BorrowHealthPreviewInput {
  walletAddress: string;
  vaultId: number;
  positionId?: number;
  collateralDelta?: string;
  debtDelta?: string;
  minHealthRatio?: number;
  maxLtvBps?: number;
}

export async function listBorrowVaults(
  config: AgentWalletConfig,
  walletAddress: string,
  input: ListBorrowVaultsInput,
): Promise<JupiterLendBorrowVaultSnapshot[]> {
  const client = await getJupiterLendClient(walletAddress);
  return client.getBorrowVaults(input);
}

export async function getBorrowVaultDetail(
  config: AgentWalletConfig,
  walletAddress: string,
  vaultId: number,
): Promise<JupiterLendBorrowVaultSnapshot> {
  if (!Number.isFinite(vaultId)) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'vaultId must be a number to read a Jupiter Lend Borrow vault.');
  }
  const client = await getJupiterLendClient(walletAddress);
  return client.getBorrowVaultDetail({ vaultId });
}

export async function getBorrowPositions(
  config: AgentWalletConfig,
  input: BorrowPositionsInput,
): Promise<JupiterLendBorrowPositionSnapshot[]> {
  if (!input.walletAddress.trim()) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'walletAddress is required to read Jupiter Lend Borrow positions.');
  }
  const client = await getJupiterLendClient(input.walletAddress);
  const positions = await client.getBorrowPositions(input);
  return positions.filter((position) => position.owner === input.walletAddress);
}

export async function previewBorrowHealth(
  config: AgentWalletConfig,
  input: BorrowHealthPreviewInput,
): Promise<JupiterLendBorrowHealthPreview> {
  if (!input.walletAddress.trim()) {
    throw new AdapterError(JUPITER_ADAPTER_ID, 'invalid_request', 'walletAddress is required to preview Jupiter Lend Borrow health.');
  }
  const client = await getJupiterLendClient(input.walletAddress);
  const minHealthRatio = input.minHealthRatio ?? configuredMinHealthRatio(config);
  const maxLtvBps = input.maxLtvBps ?? configuredMaxLtvBps(config);
  return client.previewBorrowHealth({
    walletAddress: input.walletAddress,
    vaultId: input.vaultId,
    ...(input.positionId !== undefined ? { positionId: input.positionId } : {}),
    ...(input.collateralDelta !== undefined ? { collateralDelta: input.collateralDelta } : {}),
    ...(input.debtDelta !== undefined ? { debtDelta: input.debtDelta } : {}),
    minHealthRatio,
    ...(maxLtvBps !== undefined ? { maxLtvBps } : {}),
  });
}

export function assertBorrowHealthPreviewAllowed(preview: JupiterLendBorrowHealthPreview): void {
  if (!preview.blocked) return;
  const after = preview.after;
  const reason = preview.warnings.length > 0
    ? preview.warnings.join(' ')
    : after.healthRatio !== null && after.healthRatio < preview.minHealthRatio
      ? `Projected Jupiter Borrow health ratio ${after.healthRatioText} is below minimum ${preview.minHealthRatio}.`
      : after.liquidationStatus === 'liquidated' || after.liquidationStatus === 'liquidatable'
        ? 'Jupiter Borrow position is at or past liquidation threshold.'
        : 'Projected Jupiter Borrow health is unsafe.';
  throw new AdapterError(JUPITER_ADAPTER_ID, 'health_check_failed', reason);
}

export function configuredMinHealthRatio(config: AgentWalletConfig): number {
  const configured = config.connectors?.jupiter?.minBorrowHealthRatio;
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_JUPITER_MIN_BORROW_HEALTH_RATIO;
}

export function configuredMaxLtvBps(config: AgentWalletConfig): number | undefined {
  const configured = config.connectors?.jupiter?.maxBorrowLtvBps;
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return Math.min(Math.max(configured, 0), 10_000);
  }
  return DEFAULT_JUPITER_MAX_BORROW_LTV_BPS;
}
