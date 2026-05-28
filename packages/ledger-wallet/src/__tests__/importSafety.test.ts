import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('package import safety', () => {
  it('keeps LedgerHQ WebHID and Buffer modules out of top-level webhid imports', () => {
    const source = readFileSync(fileURLToPath(new URL('../webhid.ts', import.meta.url)), 'utf8');

    expect(source).not.toMatch(/^import .* from ['"]@ledgerhq\/hw-app-solana['"];$/m);
    expect(source).not.toMatch(/^import .* from ['"]@ledgerhq\/hw-transport-webhid['"];$/m);
    expect(source).not.toMatch(/^import .* from ['"]buffer['"];$/m);
    expect(source).toContain("await import('buffer')");
    expect(source).toContain("await import('@ledgerhq/hw-app-solana')");
    expect(source).toContain("await import('@ledgerhq/hw-transport-webhid')");
  });
});
