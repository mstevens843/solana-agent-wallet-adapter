import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

// Source-level regression guard for the iOS Jupiter WalletConnect foreground.
//
// A standalone WC sign request (signMessage / signTransaction / signAndSendTransaction) rides the
// relay to the already-paired Jupiter wallet; the app only needs to FOREGROUND Jupiter so its WC
// client surfaces the pending request. That foreground MUST open the bare custom scheme
// `jupiter://` — never a fabricated `jupiter://wc?uri=wc:<topic>@2` pairing URI, which reown-swift
// rejects with "The format of the WalletConnect Pairing URI is invalid." (the bug users hit on cloud
// sign-in and every other Jupiter wallet action across the app).
//
// All three Jupiter sign methods funnel through a single native foreground path, so this one helper
// is the whole surface. This test reads the Swift bridge source as text so it runs in the normal
// vitest suite with no Xcode dependency.

const bridgeDir = '../../../../packages/ios-capacitor-bridge/ios/Plugin';
const deepLinkSwift = readFileSync(
  new URL(`${bridgeDir}/AgenticWalletConnectDeepLink.swift`, import.meta.url),
  'utf8',
);
const coreSwift = readFileSync(
  new URL(`${bridgeDir}/AgenticWalletConnectCore.swift`, import.meta.url),
  'utf8',
);

// Extract a Swift function's brace body (from its opening `{` to the matching `}`), starting at the
// given signature — so leading doc comments are NOT included in the assertion surface.
function swiftFunctionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start === -1) throw new Error(`Swift function not found: ${signature}`);
  const bodyStart = source.indexOf('{', start);
  if (bodyStart === -1) throw new Error(`No opening brace for: ${signature}`);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart, i + 1);
    }
  }
  throw new Error(`Unbalanced braces for: ${signature}`);
}

describe('iOS Jupiter WalletConnect foreground (invalid-pairing-URI regression guard)', () => {
  it('foregrounds a Jupiter sign request with the bare jupiter:// scheme, never a fabricated pairing URI', () => {
    const body = swiftFunctionBody(deepLinkSwift, 'func jupiterRequestForegroundUrl(');
    expect(body).toContain('URL(string: "jupiter://")');
    // Must NOT synthesize a wc: pairing URI for an already-established session.
    expect(body).not.toContain('wc?uri=');
    expect(body).not.toContain('wc:\\(');
    expect(body).not.toContain('@2');
  });

  it('keeps the CONNECT pairing builder carrying the full relay URI', () => {
    // Connect must still pass the complete pairing URI (has symKey + relay-protocol), i.e. the `uri`
    // argument — so the guard above can't be "satisfied" by breaking connect instead.
    const body = swiftFunctionBody(deepLinkSwift, 'func jupiterPairingUrl(');
    expect(body).toContain('jupiter://wc?uri=\\(percentEncodeQueryValue(uri))');
  });

  it('routes every Jupiter sign request through the single foreground funnel', () => {
    // signMessage / signTransaction / signAndSendTransaction all go through sendRequest ->
    // launchCurrentWalletForRequest, whose only Jupiter launch URL is jupiterRequestForegroundUrl.
    // Locking this keeps the one-helper invariant intact (so the guard above covers every action).
    expect(coreSwift).toContain('func launchCurrentWalletForRequest(');
    expect(coreSwift).toContain(
      'AgenticWalletConnectDeepLink.jupiterRequestForegroundUrl(sessionTopic: topic)',
    );
  });
});
