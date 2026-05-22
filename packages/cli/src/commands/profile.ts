/**
 * Agent profile (A2A AgentCard) management.
 *
 * Endpoints (verified against apps/render-web/src/cloud/router.ts):
 *   GET  /.well-known/agent.json                       — public profile read
 *   POST /api/agents/profile-intent {action, payload?} — returns signed nonce envelope
 *   PUT  /api/agents/profile                           — full SIWS-signed envelope + payload
 *   DELETE /api/agents/profile                         — full SIWS-signed envelope (takedown)
 *
 * Publish/delete both require the user to sign a server-issued message via the
 * wallet host. The runSignedRequest helper handles the intent→sign→submit
 * roundtrip transparently.
 *
 * BYTE PRESERVATION: the server hashes the payload at publish time and compares
 * to the hash baked into the original nonce message. The CLI reads the raw
 * file once and passes the same string for BOTH the intent body and the
 * finalize body via `bodyJson`/`bodyFragments`, so JSON.stringify is never
 * applied twice with potentially different key ordering.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { ParsedArgs } from '../shared/types.js';
import { renderWebRequest } from '../http/index.js';
import { runSignedRequest } from '../auth/signedRequest.js';

export async function dispatchProfile(parsed: ParsedArgs): Promise<unknown> {
  const sub = parsed.positionals[1] ?? 'show';
  if (sub === 'show') {
    return renderWebRequest(parsed.options, '/.well-known/agent.json', undefined, {
      useBearer: false,
      label: 'Agent card',
    });
  }
  if (sub === 'publish') {
    const file = parsed.positionals[2];
    if (!file) {
      throw new Error('Usage: solana-agent-wallet profile publish <agent-card.json>');
    }
    // Read once, use the same bytes for both intent and finalize so the
    // server's payloadHash computation is deterministic.
    const payloadRaw = await readFile(resolve(file), 'utf8');
    // Validate it parses (early error before round-trip), but discard the
    // object — we send the original bytes.
    try {
      JSON.parse(payloadRaw);
    } catch (err) {
      throw new Error(`Failed to parse ${file} as JSON: ${(err as Error).message}`, { cause: err });
    }
    return runSignedRequest(parsed.options, {
      intent: {
        path: '/api/agents/profile-intent',
        // intent body is {action, payload}. Build as a literal string so the
        // payload bytes are byte-identical to the finalize fragment below.
        bodyJson: `{"action":"publish","payload":${payloadRaw}}`,
        label: 'Agent profile intent',
      },
      finalize: {
        path: '/api/agents/profile',
        method: 'PUT',
        bodyFragments: { payload: payloadRaw },
        label: 'Agent profile publish',
      },
      summary: 'Publish Agentic agent profile',
    });
  }
  if (sub === 'delete' || sub === 'takedown') {
    return runSignedRequest(parsed.options, {
      intent: {
        path: '/api/agents/profile-intent',
        body: { action: 'takedown' },
        label: 'Agent profile intent',
      },
      finalize: {
        path: '/api/agents/profile',
        method: 'DELETE',
        label: 'Agent profile takedown',
      },
      summary: 'Take down Agentic agent profile',
    });
  }
  throw new Error(`Unknown profile subcommand: ${sub}. Try: show | publish <file.json> | delete`);
}
