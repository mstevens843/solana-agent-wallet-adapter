import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const viteConfigSource = readFileSync(
  new URL('../../vite.config.ts', import.meta.url),
  'utf8',
);

describe('browser-demo Vite browser Device Agent flag', () => {
  it('defines the browser-native flag from the Vite-prefixed environment variable', () => {
    expect(viteConfigSource).toContain('process.env.VITE_AGENTIC_BROWSER_DEVICE_AGENT');
    expect(viteConfigSource).toContain(
      "'import.meta.env.VITE_AGENTIC_BROWSER_DEVICE_AGENT': JSON.stringify(browserDeviceAgent)",
    );
  });

  it('does not expose a non-Vite browser Device Agent environment alias to client code', () => {
    expect(viteConfigSource).not.toMatch(/process\.env\.AGENTIC_BROWSER_DEVICE_AGENT\b/);
  });
});
