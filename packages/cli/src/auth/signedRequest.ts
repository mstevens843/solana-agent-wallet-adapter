/**
 * Helper for "signed write" flows where the server requires a wallet signature
 * over a server-issued message. Used by:
 *   - profile publish / takedown (apps/render-web /api/agents/profile)
 *   - cloud-workspace delete  (/api/cloud-workspace/delete)
 *
 * Pattern:
 *   1. POST /<intent-endpoint> with the action payload → server returns a
 *      one-shot {nonce, message, domain, issuedAt, expiresAt, ...} envelope.
 *   2. Open the wallet host to sign `message`, collect the signature via
 *      loopback callback (signMessageViaWalletHost).
 *   3. Submit the final request with the SignedProof envelope merged into the
 *      caller's extra body fields.
 *
 * BYTE-PRESERVATION CONTRACT:
 * For flows where the server's signed message includes a hash of a payload
 * (e.g. profile publish hashes the agent-card payload), the bytes of that
 * payload MUST be identical between the intent POST and the finalize POST.
 * Callers can guarantee this by passing a pre-serialized `bodyJson` string
 * for both intent and finalize, so the helper never re-serializes the object
 * graph. If only `body` (object) is provided, JSON.stringify is used twice —
 * fine for bodies the server doesn't hash, but unsafe for hashed payloads.
 */
import type { GlobalOptions, JsonRecord } from '../shared/types.js';
import { renderWebRequest, type RenderWebRequestOptions } from '../http/index.js';
import { signMessageViaWalletHost, type SignedProof, type WalletHostSigningPath } from './nonceFlow.js';
import { isRecord } from '../shared/util.js';

export interface IntentResponse extends JsonRecord {
  nonce?: string;
  message?: string;
  domain?: string;
  issuedAt?: string;
  expiresAt?: string;
  walletAddress?: string;
}

export interface RunSignedRequestOptions {
  intent: {
    /** API path, e.g. `/api/agents/profile-intent` */
    path: string;
    method?: 'POST' | 'PUT' | 'GET';
    body?: JsonRecord;
    /**
     * Pre-serialized intent body. When provided, used verbatim instead of
     * stringifying `body`. Required when the server hashes part of the body
     * (e.g. profile publish hashes the payload).
     */
    bodyJson?: string;
    label?: string;
  };
  finalize: {
    path: string;
    method: 'POST' | 'PUT' | 'DELETE';
    /** Extra body fields merged with the SignedProof envelope. */
    body?: JsonRecord;
    /**
     * Pre-serialized JSON fragments to MERGE BYTE-FOR-BYTE into the final
     * body alongside the SignedProof envelope. The proof fields take
     * precedence on key collision. Example: `{ payload: '<exact-bytes>' }`.
     */
    bodyFragments?: Record<string, string>;
    label?: string;
  };
  /** Summary string shown to the user in the wallet-host UI. */
  summary?: string;
  /** When true, do not open the browser automatically. */
  noOpen?: boolean;
  /** Override default 5-minute timeout for the wallet-host roundtrip. */
  timeoutMs?: number;
  /** Route/copy for the focused wallet-host signing page. */
  walletHost?: {
    path?: WalletHostSigningPath;
    openLabel?: string;
  };
}

/**
 * Run the intent → sign → submit roundtrip and return the server's final
 * response.
 */
export async function runSignedRequest<TFinal = unknown>(
  options: GlobalOptions,
  reqOptions: RunSignedRequestOptions,
): Promise<TFinal> {
  const intentInit: RequestInit = {
    method: reqOptions.intent.method ?? 'POST',
  };
  if (reqOptions.intent.bodyJson !== undefined) {
    intentInit.body = reqOptions.intent.bodyJson;
  } else if (reqOptions.intent.body !== undefined) {
    intentInit.body = JSON.stringify(reqOptions.intent.body);
  }
  const intentReqOptions: RenderWebRequestOptions = {
    label: reqOptions.intent.label ?? 'Render-web intent',
    requireAuth: true,
  };
  const intent = await renderWebRequest<IntentResponse>(
    options,
    reqOptions.intent.path,
    intentInit,
    intentReqOptions,
  );
  if (!intent.nonce || !intent.message) {
    throw new Error(`Server intent (${reqOptions.intent.path}) did not return nonce+message.`);
  }

  const proof = await signMessageViaWalletHost(options, {
    nonce: intent.nonce,
    message: intent.message,
    ...(intent.walletAddress ? { walletAddress: intent.walletAddress } : {}),
    ...(intent.domain ? { domain: intent.domain } : {}),
    ...(intent.issuedAt ? { issuedAt: intent.issuedAt } : {}),
    ...(intent.expiresAt ? { expiresAt: intent.expiresAt } : {}),
    summary: reqOptions.summary ?? 'Agentic CLI signed request',
  }, {
    ...(reqOptions.noOpen !== undefined ? { noOpen: reqOptions.noOpen } : {}),
    ...(reqOptions.timeoutMs !== undefined ? { timeoutMs: reqOptions.timeoutMs } : {}),
    ...(reqOptions.walletHost?.path ? { path: reqOptions.walletHost.path } : {}),
    ...(reqOptions.walletHost?.openLabel ? { openLabel: reqOptions.walletHost.openLabel } : {}),
  });

  const bodyString = buildFinalBody(
    proof,
    reqOptions.finalize.body,
    reqOptions.finalize.bodyFragments,
  );
  const finalInit: RequestInit = {
    method: reqOptions.finalize.method,
    body: bodyString,
  };
  const finalReqOptions: RenderWebRequestOptions = {
    label: reqOptions.finalize.label ?? 'Render-web signed request',
    requireAuth: true,
  };
  return renderWebRequest<TFinal>(
    options,
    reqOptions.finalize.path,
    finalInit,
    finalReqOptions,
  );
}

/**
 * Construct the final body string. The proof envelope is always JSON-encoded
 * by us, but any `bodyFragments` are spliced in verbatim so callers control
 * the exact bytes of payload fields the server hashes.
 */
function buildFinalBody(
  proof: SignedProof,
  extra: JsonRecord | undefined,
  fragments: Record<string, string> | undefined,
): string {
  const parts: string[] = [];
  const proofEntries = Object.entries(proof);
  const fragmentKeys = new Set(fragments ? Object.keys(fragments) : []);
  const extraEntries = extra && isRecord(extra)
    ? Object.entries(extra).filter(([k]) => !fragmentKeys.has(k))
    : [];

  // Order: extra (non-fragment) → fragments (verbatim bytes) → proof (overrides
  // any colliding extra key by being last). Proof fields are flat scalars so
  // collisions are unlikely, but proof wins.
  for (const [key, value] of extraEntries) {
    parts.push(`${JSON.stringify(key)}:${JSON.stringify(value)}`);
  }
  if (fragments) {
    for (const [key, raw] of Object.entries(fragments)) {
      parts.push(`${JSON.stringify(key)}:${raw}`);
    }
  }
  for (const [key, value] of proofEntries) {
    parts.push(`${JSON.stringify(key)}:${JSON.stringify(value)}`);
  }
  return `{${parts.join(',')}}`;
}
