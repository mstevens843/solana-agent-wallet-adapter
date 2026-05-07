# @solana-agent-wallet-adapter/ios-link

iOS wallet-link signing transport for Solana Agent Wallet Adapter.

This is not Android MWA. iOS approval is a wallet link and callback: the agent returns an `approvalUri`, the user opens it on iPhone, the wallet redirects back to the bridge, and the agent polls until the approval resolves.

## Supported Paths

- Phantom: encrypted deeplinks at `https://phantom.app/ul/v1`.
- Solflare: encrypted deeplinks at `https://solflare.com/ul/v1`.
- Backpack: encrypted deeplinks at `https://backpack.app/ul/v1`.
- Jupiter: WalletConnect/Reown pairing with QR-first approval for Jupiter
  Mobile.

## Bridge Usage

```sh
node packages/mcp-server/dist/bin/bridge.js \
  --ios-provider phantom \
  --ios-callback-base-url http://<lan-ip>:8787 \
  --token local-agent-wallet
```

For Jupiter Mobile, supply a Reown project id and scan the returned QR code:

```sh
REOWN_PROJECT_ID=<your-reown-project-id> \
node packages/mcp-server/dist/bin/bridge.js \
  --ios-provider jupiter \
  --walletconnect-storage-dir ./.agent-wallet/walletconnect \
  --token local-agent-wallet
```

Then register/run the MCP server with `--bridge` and call:

```text
solana_connect_wallet
```

After the user approves the link, `solana_get_address` and signing tools use
the connected iOS session. Jupiter supports `solana_signMessage`,
`solana_signTransaction`, and `solana_signAndSendTransaction` through the active
WalletConnect session.

## Logging

Logs use deterministic redacted lines:

```text
[AgentIOS] [Component] method | STEP_NAME phase=INFO message="..." key=value
```

No session tokens, full callback URLs, ciphertexts, plaintext payloads, full messages, full transactions, or full signatures are logged.

See [`docs/smoke/ios-wallet-web.md`](../../docs/smoke/ios-wallet-web.md) for the manual iOS smoke.
