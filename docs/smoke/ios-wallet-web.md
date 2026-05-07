# iOS Wallet Web Smoke

This smoke verifies both iOS paths. Solana Mobile Wallet Adapter is not
available on iOS.

## What This Uses

- Wallet in-app browsers that inject a Solana Wallet Standard provider.
- iOS Safari wallet extensions that inject a Solana Wallet Standard provider.
- The same `@solana-agent-wallet-adapter/wallet-standard-web` backend used by
  desktop browser wallets.
- `@solana-agent-wallet-adapter/ios-link` for agent approval links through
  Phantom, Solflare, or Backpack.

Jupiter Mobile uses WalletConnect/Reown. It is not the encrypted deeplink path:
start the bridge with `--ios-provider jupiter`, provide `REOWN_PROJECT_ID`, and
scan the QR code from Jupiter Mobile.

## Start LAN Dev

```sh
pnpm dev:mobile
```

The script prints a URL like:

```text
http://<laptop-ip>:5174/?bridgeUrl=http://<laptop-ip>:8787&token=local-agent-wallet
```

Open that URL from the wallet's in-app browser, or from Safari if the installed
wallet provides a Safari extension with Wallet Standard injection.

## Start iOS Agent Link Bridge

```sh
pnpm --filter @solana-agent-wallet-adapter/mcp-server build
node packages/mcp-server/dist/bin/bridge.js \
  --ios-provider phantom \
  --ios-callback-base-url http://<laptop-ip>:8787 \
  --token local-agent-wallet
```

For Jupiter Mobile:

```sh
REOWN_PROJECT_ID=<your-reown-project-id> \
node packages/mcp-server/dist/bin/bridge.js \
  --ios-provider jupiter \
  --walletconnect-storage-dir ./.agent-wallet/walletconnect \
  --token local-agent-wallet
```

Run the MCP server with `--bridge`, call `solana_connect_wallet`, open the
returned approval URL on iPhone, approve in the wallet, then poll
`solana_check_approval`. For Jupiter, open the approval URL on desktop and scan
the QR code with Jupiter Mobile.

## Expected Flow

1. Open the LAN URL on iOS through a supported wallet host.
2. Tap `Discover wallets`.
3. Confirm the mobile panel says iOS uses wallet fallback, not MWA.
4. Select the injected wallet.
5. Connect and approve in the wallet UI.
6. Connect bridge.
7. Use the Approval Inbox or Wallet Flow tab to request a signature.

## Expected Unsupported Flow

Plain iOS Safari with no wallet extension should show no Wallet Standard
providers. That is expected for the web compatibility path. The agent link path
does not require an injected provider; it requires the bridge callback URL to be
reachable from the phone.
