import type { ParsedArgs } from './parseArgs.js';
import { validateManifestForCli } from './test.js';

export interface PublishResult {
  ok: true;
  status: number;
  manifestId: string;
  manifestPath: string;
  apiUrl: string;
  response: unknown;
}

export async function runPublish(parsed: ParsedArgs): Promise<PublishResult> {
  const { manifest, manifestPath } = await validateManifestForCli(parsed);

  let endpoint: URL;
  try {
    endpoint = new URL('/api/skills/manifests', parsed.options.apiUrl);
  } catch (err: unknown) {
    throw new Error(
      `Invalid --api-url "${parsed.options.apiUrl}": ${(err as Error).message}. Use e.g. http://localhost:3000.`,
    );
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  if (parsed.options.cookie && parsed.options.cookie.trim().length > 0) {
    headers.cookie = parsed.options.cookie;
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(manifest),
    });
  } catch (err: unknown) {
    const message = (err as Error).message;
    const cause = (err as { cause?: { code?: string } }).cause;
    const code = cause?.code;
    const hint =
      code === 'ECONNREFUSED'
        ? ' (is the cloud server running? try: pnpm -F @solana-agent-wallet-adapter/render-web dev)'
        : '';
    throw new Error(`Failed to POST ${endpoint}: ${message}${hint}`);
  }

  const bodyText = await response.text();
  let parsedBody: unknown = bodyText;
  if (bodyText.length > 0) {
    try {
      parsedBody = JSON.parse(bodyText);
    } catch {
      // leave parsedBody as the raw string
    }
  }

  if (!response.ok) {
    let hint = '';
    if (response.status === 401 || response.status === 403) {
      hint =
        '\nHint: copy your session cookie from browser DevTools (Application > Cookies) and pass --cookie or set AGENTIC_COOKIE. Only dev-allowlisted wallets can publish.';
    } else if (response.status === 404) {
      hint =
        '\nHint: /api/skills/manifests is owned by Agent 5 and may not be deployed yet. Verify the endpoint exists at this --api-url.';
    }
    const message =
      typeof parsedBody === 'string'
        ? parsedBody
        : (parsedBody as { error?: string } | null)?.error ?? JSON.stringify(parsedBody);
    throw new Error(`Publish failed: ${response.status} ${response.statusText} — ${message}${hint}`);
  }

  return {
    ok: true,
    status: response.status,
    manifestId: manifest.id,
    manifestPath,
    apiUrl: parsed.options.apiUrl,
    response: parsedBody,
  };
}
