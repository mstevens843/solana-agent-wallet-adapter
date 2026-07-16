import {
  createHeliusWebhook,
  deleteHeliusWebhook,
  listHeliusWebhooks,
  updateHeliusWebhook,
  type HeliusWebhookRecord,
} from '@solana-agent-wallet-adapter/mcp-server';

/**
 * Keeps ONE Helius webhook's `accountAddresses` in sync with the set of wallets that have a live push
 * device. One webhook for the whole app, not one per wallet: Helius caps webhooks per project but not
 * addresses per webhook.
 *
 * Reconciliation is idempotent and driven off our own DB, so it self-heals from drift — a webhook
 * deleted in the Helius dashboard, a create that half-failed, an address that never got removed.
 */

export interface HeliusWebhookSyncOptions {
  /** Public URL of our receiver, e.g. https://agentic-signer.com/api/webhooks/helius */
  webhookUrl: string;
  /** Echoed by Helius in the Authorization header of every delivery; the receiver rejects mismatches. */
  authHeader: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export interface HeliusWebhookSyncResult {
  action: 'created' | 'updated' | 'unchanged' | 'deleted' | 'skipped';
  webhookId?: string;
  addressCount: number;
  reason?: string;
}

export function heliusPushWebhookConfig(env: NodeJS.ProcessEnv = process.env): HeliusWebhookSyncOptions | undefined {
  const apiKey = env.HELIUS_API_KEY?.trim();
  const authHeader = env.HELIUS_WEBHOOK_SECRET?.trim();
  if (!apiKey || !authHeader) return undefined;
  const base = env.PUBLIC_WEB_ORIGIN?.trim() || env.RENDER_EXTERNAL_URL?.trim();
  if (!base) return undefined;
  return { webhookUrl: `${base.replace(/\/$/, '')}/api/webhooks/helius`, authHeader, env };
}

/** Our webhook is the one pointed at our receiver URL; anything else in the project is not ours. */
async function findOurWebhook(options: HeliusWebhookSyncOptions): Promise<HeliusWebhookRecord | undefined> {
  const all = await listHeliusWebhooks({ env: options.env, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
  return all.find((hook) => hook.webhookURL === options.webhookUrl);
}

export async function syncHeliusPushWebhook(
  wallets: string[],
  options: HeliusWebhookSyncOptions,
): Promise<HeliusWebhookSyncResult> {
  const addresses = [...new Set(wallets.filter(Boolean))].sort();
  const requestOptions = { env: options.env, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) };
  const existing = await findOurWebhook(options);

  if (!addresses.length) {
    // Helius rejects an empty accountAddresses, so "nobody is opted in" means deleting the webhook
    // rather than updating it to empty. Re-created on the next opt-in.
    if (!existing) return { action: 'skipped', addressCount: 0, reason: 'No opted-in wallets and no webhook to remove.' };
    await deleteHeliusWebhook(existing.webhookID, requestOptions);
    return { action: 'deleted', webhookId: existing.webhookID, addressCount: 0 };
  }

  if (!existing) {
    const created = await createHeliusWebhook(
      { webhookURL: options.webhookUrl, accountAddresses: addresses, authHeader: options.authHeader },
      requestOptions,
    );
    return { action: 'created', webhookId: created.webhookID, addressCount: addresses.length };
  }

  const current = [...new Set(existing.accountAddresses ?? [])].sort();
  if (current.length === addresses.length && current.every((value, index) => value === addresses[index])) {
    return { action: 'unchanged', webhookId: existing.webhookID, addressCount: addresses.length };
  }

  await updateHeliusWebhook(
    existing.webhookID,
    { webhookURL: options.webhookUrl, accountAddresses: addresses, authHeader: options.authHeader },
    requestOptions,
  );
  return { action: 'updated', webhookId: existing.webhookID, addressCount: addresses.length };
}
