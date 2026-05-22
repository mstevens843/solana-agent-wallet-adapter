/**
 * Cloud workspace deletion — Play Store data-deletion compliance flow.
 *
 * Endpoints (verified against apps/render-web/src/cloud/router.ts:897-903):
 *   POST /api/cloud-workspace/delete-intent  → {nonce, message, domain, issuedAt, expiresAt, walletAddress}
 *   POST /api/cloud-workspace/delete         → consumes nonce + verifies signed envelope, then deletes everything
 *
 * Both calls require an authenticated session AND a wallet signature over the
 * server-issued message. The runSignedRequest helper handles the
 * intent → wallet sign → submit roundtrip.
 *
 *   solana-agent-wallet cloud-workspace delete                      # prints usage hint
 *   solana-agent-wallet cloud-workspace delete --confirm             # opens wallet host to sign
 */
import type { ParsedArgs } from '../shared/types.js';
import { runSignedRequest } from '../auth/signedRequest.js';

export async function dispatchCloudWorkspace(parsed: ParsedArgs): Promise<unknown> {
  const sub = parsed.positionals[1];
  if (sub !== 'delete') {
    throw new Error(`Unknown cloud-workspace subcommand: ${sub ?? ''}. Try: delete`);
  }
  const confirmed = parsed.positionals.includes('--confirm');
  if (!confirmed) {
    return {
      message: 'Run with --confirm to permanently delete your Agentic cloud workspace, audit history, and connector secrets.',
      docs: 'https://agentic-signer.com/delete-account',
      requiresWalletSignature: true,
    };
  }
  return runSignedRequest(parsed.options, {
    intent: {
      path: '/api/cloud-workspace/delete-intent',
      body: {},
      label: 'Cloud workspace delete intent',
    },
    finalize: {
      path: '/api/cloud-workspace/delete',
      method: 'POST',
      label: 'Cloud workspace delete',
    },
    summary: 'Delete entire Agentic cloud workspace',
  });
}
