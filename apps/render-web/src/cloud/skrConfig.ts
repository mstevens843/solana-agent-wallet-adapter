/**
 * Shared accessor for the deployment-level $SKR (Solana Mobile Seeker) config.
 *
 * Every consumer in `apps/render-web/src/cloud/` that gates behavior on $SKR
 * support reads through these helpers so a malformed `SKR_TOKEN_MINT` env var
 * is treated as "not configured" everywhere consistently — never as a partial
 * enablement where some surfaces advertise $SKR and others fail at runtime.
 *
 * The base58 regex matches Solana's canonical pubkey alphabet at the typical
 * 32-44 char length range; the stricter `new PublicKey(raw)` validation lives
 * in `packages/mcp-server/src/config.ts:SKR_MINT` and logs a warning at
 * deployment startup when the env var is malformed.
 */
const SOLANA_BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function readSkrMint(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.SKR_TOKEN_MINT ?? '').trim();
  return SOLANA_BASE58_RE.test(raw) ? raw : '';
}

export function readSkrDecimals(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = (env.SKR_TOKEN_DECIMALS ?? '').trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 18 ? n : undefined;
}

export function isSkrSkillBountyActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.SKR_SKILL_BOUNTY_ACTIVE ?? '').trim().toLowerCase() === 'true';
}

export function isSkrSessionDefaultActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.SKR_SESSION_DEFAULT ?? '').trim().toLowerCase() === 'true';
}
