# Public Release

Use this process to make every public installer shown on `agentic-signer.com` resolve for users.

## Prerequisites

- The npm scope `@solana-agent-wallet-adapter` exists and the release token can publish
  `@solana-agent-wallet-adapter/cli`.
- GitHub Actions has write access to repository contents and releases.
- Repository secrets are set:
  - `NPM_TOKEN`
  - `AGENTIC_ANDROID_KEYSTORE_BASE64`
  - `AGENTIC_ANDROID_KEY_ALIAS`
  - `AGENTIC_ANDROID_STORE_PASSWORD`
  - `AGENTIC_ANDROID_KEY_PASSWORD`
- Render production builds that back Android trusted mode have:
  - `AGENTIC_ANDROID_SHA256_CERT_FINGERPRINTS`
  - `AGENTIC_ANDROID_REQUIRE_TRUST=1`

## Current Public Tag

The CLI npm version, desktop app version, and tag must match. The repository is prepared for:

```sh
v0.2.1
```

Before choosing a different tag, update `packages/cli/package.json`, `apps/desktop-shell/package.json`,
`apps/desktop-shell/src-tauri/tauri.conf.json`, and `apps/desktop-shell/src-tauri/Cargo.toml` to the same version
without the leading `v`.

## Release Flow

1. Run local preflight checks:

   ```sh
   pnpm -F @solana-agent-wallet-adapter/cli build
   (cd packages/cli && env NPM_CONFIG_CACHE=/private/tmp/agentic-npm-cache npm pack --dry-run)
   pnpm -F @solana-agent-wallet-adapter/desktop-shell typecheck
   pnpm -F @solana-agent-wallet-adapter/desktop-shell build
   pnpm verify:release-links
   ```

2. Push the release commit, then tag it:

   ```sh
   git tag v0.2.1
   git push origin master v0.2.1
   ```

3. Confirm the tag starts these workflows:
   - `cli-release`: publishes `@solana-agent-wallet-adapter/cli` to npm and uploads CLI archives.
   - `desktop release`: waits for the CLI archives, bundles the sidecar, and uploads desktop installers.
   - `android release`: builds signed Android artifacts, uploads them, then verifies npm and every advertised GitHub
     download URL.

4. If a tag workflow must be rerun manually, dispatch all three workflows with the same tag. Start `cli-release` first,
   then `desktop release` and `android release`.

## Advertised Artifacts

The release must contain:

- `solana-agent-wallet-macos-arm64.tar.gz`
- `solana-agent-wallet-macos-x64.tar.gz`
- `solana-agent-wallet-linux-x64.tar.gz`
- `solana-agent-wallet-windows-x64.zip`
- `agentic-desktop-macos-arm64.dmg`
- `agentic-desktop-macos-x64.dmg`
- `agentic-desktop-windows-x64.msi`
- `agentic-desktop-linux-x64.AppImage`
- `agentic-android.apk`
- `agentic-android.aab`

The website links those assets through:

```text
https://github.com/mstevens843/solana-agent-wallet-adapter/releases/latest/download/<asset>
```

## Post-Release Verification

After Actions finishes, run:

```sh
pnpm verify:release-links:live -- --tag v0.2.1
npm view @solana-agent-wallet-adapter/cli@0.2.1 version
npm exec @solana-agent-wallet-adapter/cli@0.2.1 -- --help
```

The live verifier fails if npm is unpublished, the tagged GitHub release is missing an advertised asset, or any
`/releases/latest/download/...` URL still returns a non-2xx response.
