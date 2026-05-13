import type { AgentWalletConfig } from '../../config.js';

import { jupiterFetchJson } from './client.js';
import { requireTriggerEnabled, requireValidJwt } from './triggerAuth.js';

export interface TriggerVaultSnapshot {
  walletAddress: string;
  vaultAddress?: string;
  vaultId?: string;
  custody: 'privy';
  balances?: Record<string, unknown>;
  registered: boolean;
  raw: Record<string, unknown>;
}

export interface ReadVaultInput {
  walletAddress: string;
}

export async function readVault(
  config: AgentWalletConfig,
  input: ReadVaultInput,
): Promise<TriggerVaultSnapshot> {
  requireTriggerEnabled(config);
  const jwt = requireValidJwt(input.walletAddress, config);
  const body = await jupiterFetchJson(config, 'trigger', '/vault', {
    method: 'GET',
    searchParams: { walletAddress: input.walletAddress },
    bearerToken: jwt.jwt,
  });
  return normalizeVault(input.walletAddress, body);
}

export interface PrepareRegisterVaultInput {
  walletAddress: string;
}

export interface PrepareRegisterVaultResult {
  walletAddress: string;
  transactionBase64?: string;
  vaultSnapshot: TriggerVaultSnapshot;
  raw: Record<string, unknown>;
}

export async function prepareRegisterVault(
  config: AgentWalletConfig,
  input: PrepareRegisterVaultInput,
): Promise<PrepareRegisterVaultResult> {
  requireTriggerEnabled(config);
  const jwt = requireValidJwt(input.walletAddress, config);
  const body = await jupiterFetchJson(config, 'trigger', '/vault/register', {
    method: 'GET',
    bearerToken: jwt.jwt,
  });
  const transactionBase64 = optionalString(body, 'transaction') ?? optionalString(body, 'transactionBase64');
  return {
    walletAddress: input.walletAddress,
    ...(transactionBase64 !== undefined && { transactionBase64 }),
    vaultSnapshot: normalizeVault(input.walletAddress, body.vault as Record<string, unknown> | undefined ?? body),
    raw: body,
  };
}

function normalizeVault(walletAddress: string, body: Record<string, unknown>): TriggerVaultSnapshot {
  const vaultAddress =
    optionalString(body, 'vaultPubkey') ??
    optionalString(body, 'vaultAddress') ??
    optionalString(body, 'vault_address');
  const vaultId = optionalString(body, 'vaultId') ?? optionalString(body, 'vault_id') ?? optionalString(body, 'privyVaultId');
  const balances = (body.balances as Record<string, unknown> | undefined) ?? undefined;
  const registered = Boolean(vaultAddress) || body.registered === true;
  const snapshot: TriggerVaultSnapshot = {
    walletAddress: optionalString(body, 'userPubkey') ?? walletAddress,
    custody: 'privy',
    registered,
    raw: body,
  };
  if (vaultAddress) snapshot.vaultAddress = vaultAddress;
  if (vaultId) snapshot.vaultId = vaultId;
  if (balances) snapshot.balances = balances;
  return snapshot;
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}
