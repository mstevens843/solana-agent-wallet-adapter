import { describe, expect, it } from 'vitest';

import { assertWebhookUrlAllowed, WebhookSecurityError } from '../cloud/webhookSecurity.js';

describe('webhook SSRF guard', () => {
  it('blocks IPv4-mapped IPv6 to the cloud metadata endpoint', () => {
    expect(() => assertWebhookUrlAllowed('http://[::ffff:169.254.169.254]/latest/meta-data/'))
      .toThrow(WebhookSecurityError);
  });

  it('blocks IPv4-mapped IPv6 loopback (hex and dotted forms)', () => {
    expect(() => assertWebhookUrlAllowed('http://[::ffff:127.0.0.1]/')).toThrow(WebhookSecurityError);
    expect(() => assertWebhookUrlAllowed('http://[::ffff:7f00:1]/')).toThrow(WebhookSecurityError);
  });

  it('blocks IPv4-mapped IPv6 to private ranges', () => {
    expect(() => assertWebhookUrlAllowed('http://[::ffff:10.0.0.5]/')).toThrow(WebhookSecurityError);
    expect(() => assertWebhookUrlAllowed('http://[::ffff:192.168.1.1]/')).toThrow(WebhookSecurityError);
  });

  it('still blocks bare loopback / private / metadata', () => {
    expect(() => assertWebhookUrlAllowed('http://127.0.0.1/')).toThrow(WebhookSecurityError);
    expect(() => assertWebhookUrlAllowed('http://169.254.169.254/')).toThrow(WebhookSecurityError);
    expect(() => assertWebhookUrlAllowed('http://[::1]/')).toThrow(WebhookSecurityError);
    expect(() => assertWebhookUrlAllowed('http://metadata.google.internal/')).toThrow(WebhookSecurityError);
  });

  it('allows a normal public https webhook host', () => {
    expect(() => assertWebhookUrlAllowed('https://hooks.example.com/agentic')).not.toThrow();
  });
});
