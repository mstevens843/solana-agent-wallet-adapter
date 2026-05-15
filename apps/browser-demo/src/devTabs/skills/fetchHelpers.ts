// Shared cloud-fetch helpers for Layer 2 Skills sub-tabs and components.
// Lifted from the payOut.ts pattern so each sub-tab agent doesn't duplicate
// fetch / error-shape logic.

export type FetchResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'error'; status: number; message: string }
  | { kind: 'forbidden' }
  | { kind: 'notDeployed' }
  | { kind: 'networkError'; message: string };

const COMMON_HEADERS = {
  Accept: 'application/json',
} as const;

export async function getJson<T>(path: string): Promise<FetchResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'GET',
      credentials: 'include',
      headers: COMMON_HEADERS,
    });
  } catch (err) {
    return { kind: 'networkError', message: (err as Error).message };
  }
  return interpretResponse<T>(res);
}

export async function postJson<T>(path: string, body: unknown): Promise<FetchResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      credentials: 'include',
      headers: { ...COMMON_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { kind: 'networkError', message: (err as Error).message };
  }
  return interpretResponse<T>(res);
}

export async function deleteJson<T = { ok: true }>(path: string): Promise<FetchResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'DELETE',
      credentials: 'include',
      headers: COMMON_HEADERS,
    });
  } catch (err) {
    return { kind: 'networkError', message: (err as Error).message };
  }
  return interpretResponse<T>(res);
}

async function interpretResponse<T>(res: Response): Promise<FetchResult<T>> {
  if (res.status === 403) return { kind: 'forbidden' };
  if (res.status === 404) return { kind: 'notDeployed' };
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    if (res.ok) return { kind: 'ok', value: undefined as unknown as T };
    return { kind: 'error', status: res.status, message: 'Non-JSON error response.' };
  }
  if (!res.ok) {
    const message =
      parsed && typeof parsed === 'object' && parsed !== null && 'error' in parsed
        ? String((parsed as Record<string, unknown>).error ?? `HTTP ${res.status}`)
        : `HTTP ${res.status}`;
    return { kind: 'error', status: res.status, message };
  }
  return { kind: 'ok', value: parsed as T };
}
