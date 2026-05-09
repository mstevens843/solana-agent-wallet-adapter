import { describe, expect, it } from 'vitest';

import { redactSecrets } from '../cloud/redaction.js';

describe('server secret redaction', () => {
  it('redacts exact nonstandard provider keys before generic token patterns', () => {
    const exactKey = 'provider-secret-value-abcdef123456';
    const message = `Bad key ${exactKey}; Authorization: Bearer ${exactKey}; https://provider.example/debug?api-key=${exactKey}`;
    const redacted = redactSecrets(message, exactKey);

    expect(redacted).toContain('[redacted]');
    expect(redacted).not.toContain(exactKey);
    expect(redacted).not.toContain(`Bearer ${exactKey}`);
    expect(redacted).not.toContain(`api-key=${exactKey}`);
  });

  it('redacts common API key and token formats without an exact secret', () => {
    const message = [
      'Authorization: Bearer opaque-provider-token-123456789',
      'OpenAI key sk-proj-abcdefghijklmnopqrstuvwxyz',
      'legacy key sk-abcdefghijklmnopqrstuvwxyz',
      'jwt aaaabbbbccccddddeeeeffff.gggghhhhiiiijjjjkkkkllll.mmmmnnnnooooppppqqqqrrrr',
      'api-key=providerSecret123456',
    ].join(' | ');
    const redacted = redactSecrets(message);

    expect(redacted).toContain('Bearer [redacted]');
    expect(redacted).toContain('[redacted-token]');
    expect(redacted).not.toContain('opaque-provider-token-123456789');
    expect(redacted).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz');
    expect(redacted).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(redacted).not.toContain('providerSecret123456');
  });
});
