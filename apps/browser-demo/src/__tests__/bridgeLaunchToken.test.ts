import { describe, expect, it } from 'vitest';

import { readBridgeLaunchToken } from '../bridgeLaunchToken.js';

// The CLI/desktop now pass the bridge token in the URL fragment so a remote
// wallet-host origin (Render) never receives/logs it; older launches use the
// query. These lock in fragment-first reading with a query fallback.
describe('readBridgeLaunchToken', () => {
  it('reads the token from the URL fragment (CLI/desktop launch)', () => {
    expect(readBridgeLaunchToken('?bridgeUrl=http://127.0.0.1:8787', '#token=abc123')).toBe('abc123');
  });

  it('prefers the fragment over the query when both are present', () => {
    expect(readBridgeLaunchToken('?token=querytok', '#token=fragtok')).toBe('fragtok');
  });

  it('falls back to the query token for legacy / QR / deeplink launches', () => {
    expect(readBridgeLaunchToken('?token=legacy', '')).toBe('legacy');
  });

  it('ignores a non-token hash route and returns undefined when no token is present', () => {
    expect(readBridgeLaunchToken('?bridgeUrl=http://127.0.0.1:8787', '#workspace')).toBeUndefined();
  });
});
