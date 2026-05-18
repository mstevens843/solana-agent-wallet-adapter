# Agentic Release Plan

This file coordinates three parallel implementation agents. Each agent has a non-overlapping write scope. Do not edit outside your assigned scope unless your prompt explicitly allows it.

Before starting, each agent must run `git status --short`, read this whole file, and preserve unrelated user or agent changes.

## Shared Contract

Public product name: `Agentic`.

Technical/docs name: `Solana Agent Wallet Adapter`.

Repository: `mstevens843/solana-agent-wallet-adapter`.

Render hosts only the static public website. The local wallet bridge, CLI, and desktop app run on the user's machine.

CLI release assets:

- `solana-agent-wallet-macos-arm64.tar.gz`
- `solana-agent-wallet-macos-x64.tar.gz`
- `solana-agent-wallet-linux-x64.tar.gz`
- `solana-agent-wallet-windows-x64.zip`

Desktop release assets:

- `agentic-desktop-macos-arm64.dmg`
- `agentic-desktop-macos-x64.dmg`
- `agentic-desktop-windows-x64.msi`
- `agentic-desktop-linux-x64.AppImage`

Release URL pattern:

```text
https://github.com/mstevens843/solana-agent-wallet-adapter/releases/latest/download/<asset>
```

Fallback release URL:

```text
https://github.com/mstevens843/solana-agent-wallet-adapter/releases/latest
```

## Agent 1: Render Website And Public Download Surface

### Write Scope

You own:

- `apps/browser-demo/**`
- `apps/browser-demo/README.md`
- `render.yaml`
- `docs/deploy/render.md` if needed

Do not edit:

- `packages/cli/**`
- `apps/desktop-shell/**`
- `packages/mcp-server/**`
- `.github/workflows/**`

### Goal

Turn the current browser demo into a complete Render-deployable public website for Agentic. It should be deployable as a static Render site and should present real public install/download paths for CLI and desktop releases while preserving the live wallet workspace.

### Required Website Content

- Top nav: Agentic mark, Docs, CLI, Desktop, Launch Demo.
- Hero headline: `Let agents use your Solana wallet without giving them one.`
- Clear custody model explanation:
  - agents prepare actions
  - user wallet signs
  - no private key leaves the wallet
- Keep the live browser workspace below the marketing/docs sections.
- Keep `Agentic` as public UI branding.
- Keep `Solana Agent Wallet Adapter` in technical/docs copy.

### Install And Download Sections

Add production install/download sections for:

- CLI npm global install:

```sh
npm install -g @solana-agent-wallet-adapter/cli
```

- CLI one-shot:

```sh
npm exec @solana-agent-wallet-adapter/cli -- app
```

- CLI standalone binaries using the exact CLI release asset names from the shared contract.
- Desktop downloads using the exact desktop release asset names from the shared contract.
- `View all releases` link to the fallback release URL from the shared contract.

Do not present `pnpm desktop:dev` or `pnpm cli -- app` as public install paths. Those may appear only in a clearly labeled `Local repo development` area.

### Render Deployment

Add root `render.yaml` for a Render Static Site.

Use this behavior:

- service type: web
- runtime: static
- build command:

```sh
corepack enable && pnpm install --frozen-lockfile && pnpm -F @solana-agent-wallet-adapter/browser-demo build
```

- static publish path:

```text
apps/browser-demo/dist
```

- SPA fallback rewrite to `/index.html`.

Add concise Render deployment docs with:

- manual dashboard values
- blueprint usage
- note that Render hosts only the static website
- note that CLI/desktop/local bridge run locally on user machines

### Behavior Requirements

- All install buttons copy commands exactly.
- All download buttons navigate to real GitHub latest-release URLs.
- No browser button should claim it can open Terminal directly.
- Preserve existing wallet discovery/connect/sign/bridge/inbox/labs behavior.
- Keep mobile layout free of horizontal overflow at 390px width.
- Use stable responsive dimensions for command rows and download cards.

### Verification

Run:

```sh
pnpm -F @solana-agent-wallet-adapter/browser-demo typecheck
pnpm -F @solana-agent-wallet-adapter/browser-demo build
```

Also verify:

- desktop render smoke
- 390px mobile render smoke
- copy buttons copy exactly the npm/exec commands
- release download anchors use the shared asset names exactly

## Agent 2: CLI NPM Package And Standalone Binary Downloads

### Write Scope

You own:

- `packages/cli/**`
- `packages/mcp-server/package.json` only if an export/bin subpath is needed
- `.github/workflows/cli-release.yml`
- `packages/cli/README.md`

Do not edit:

- `apps/browser-demo/**`
- `apps/desktop-shell/**`
- `render.yaml`
- `.github/workflows/desktop-release.yml`

### Goal

Make the CLI genuinely usable through both public paths:

- npm install / npm exec
- standalone downloadable binaries from GitHub Releases

Users must be able to run:

```sh
npm install -g @solana-agent-wallet-adapter/cli
solana-agent-wallet app
npm exec @solana-agent-wallet-adapter/cli -- app
```

Users must also be able to download standalone binaries from GitHub Releases using the shared CLI release asset names.

### Runtime Requirements

`solana-agent-wallet app` must not require:

- `pnpm`
- a repo checkout
- `packages/*` source paths

Replace repo-root assumptions with an installed-runtime mode:

- default config/data dir should be user-local
- on Unix, prefer `~/.solana-agent-wallet`
- on Windows, use an appropriate app data path
- create default config files when absent
- keep repo-dev mode working when running inside this monorepo

Package the browser wallet host into the CLI package:

- build/copy browser-demo static output into `packages/cli/dist/wallet-host` during CLI build
- serve it locally from the CLI at `127.0.0.1:5174`

Package/start the bridge without repo paths:

- prefer importing/starting bridge server code from `@solana-agent-wallet-adapter/mcp-server`
- if a subpath export is required, add the smallest safe export in `packages/mcp-server/package.json`

### Required Commands

Add or confirm these commands:

```sh
solana-agent-wallet app
solana-agent-wallet doctor
solana-agent-wallet bridge serve
solana-agent-wallet bridge start
solana-agent-wallet wallet-host serve
```

`bridge start` may spawn the current CLI executable in `bridge serve` mode so it works for both npm installs and standalone binary installs.

### NPM Packaging

Ensure `packages/cli/package.json` has correct:

- `bin`
- `files`
- dependencies
- build scripts

`npm pack --dry-run` from `packages/cli` must include:

- built CLI JS
- wallet-host assets
- README
- types

README must document:

- npm global install
- npm exec one-shot
- local repo dev fallback
- troubleshooting

### Standalone Binaries

Use a maintained Node executable packager. Prefer `@yao-pkg/pkg` unless a better repo-compatible approach is discovered during implementation.

Add scripts under `packages/cli` to build:

- macOS arm64
- macOS x64
- Linux x64
- Windows x64

Release asset names must exactly match:

- `solana-agent-wallet-macos-arm64.tar.gz`
- `solana-agent-wallet-macos-x64.tar.gz`
- `solana-agent-wallet-linux-x64.tar.gz`
- `solana-agent-wallet-windows-x64.zip`

Add `.github/workflows/cli-release.yml` that:

- builds on tags like `v*`
- supports manual dispatch if practical
- uploads those four assets to GitHub Releases
- runs smoke tests on each platform

### Verification

Run:

```sh
pnpm -F @solana-agent-wallet-adapter/cli build
pnpm -F @solana-agent-wallet-adapter/cli typecheck
pnpm -F @solana-agent-wallet-adapter/mcp-server build
```

Also run:

```sh
cd packages/cli
npm pack --dry-run
```

Smoke from outside the repo in a temp dir:

- installed package or packed tarball can run `solana-agent-wallet --help`
- `solana-agent-wallet doctor --json`
- `solana-agent-wallet wallet-host serve` starts a reachable local page
- `solana-agent-wallet bridge serve` starts a reachable health endpoint

## Agent 3: Desktop App Release And Usable Local Runtime

### Write Scope

You own:

- `apps/desktop-shell/**`
- `apps/desktop-shell/README.md`
- `.github/workflows/desktop-release.yml`

Do not edit:

- `apps/browser-demo/**`
- `packages/cli/**`
- `packages/mcp-server/**`
- `render.yaml`
- `.github/workflows/cli-release.yml`

### Goal

Make the desktop version available as real downloadable Tauri installers. The desktop app should be named Agentic publicly and should be usable by non-repo users.

### Product Behavior

- Public app name: `Agentic`.
- Technical copy may mention `Solana Agent Wallet Adapter`.
- The desktop app should not require the user to clone this repo.
- The desktop app should manage the local bridge and wallet-host lifecycle through the CLI sidecar contract from Agent 2:
  - sidecar command supports `bridge serve`
  - sidecar command supports `wallet-host serve`
- If the sidecar is missing in a dev build, show a clear diagnostic and preserve repo-dev fallback behavior.
- Desktop should launch the external browser wallet host for real browser extension wallets.
- Do not imply the Tauri WebView replaces Phantom/Solflare/Backpack browser approval.

### Implementation Requirements

- Update public-facing Tauri product metadata from `Solana Agent Wallet` to `Agentic`.
- Configure Tauri bundling to include the CLI sidecar binary per platform using a stable sidecar naming convention.
- Desktop start/stop/restart bridge should spawn the bundled sidecar instead of `node packages/mcp-server/dist/bin/bridge.js` in installed mode.
- Desktop should also be able to start/verify the local wallet-host server via sidecar.
- Keep repo-dev fallback paths for contributors, but installed mode must be primary.
- Improve desktop diagnostics:
  - sidecar found/missing
  - bridge reachable
  - wallet host reachable
  - config/data path
  - release version

README must explain:

- install
- first run
- wallet host
- relation between desktop app, CLI, and browser wallet approval

### Release Workflow

Add `.github/workflows/desktop-release.yml`.

Use the official Tauri GitHub Action.

Trigger on:

- tags like `v*`
- manual dispatch

Build:

- macOS arm64
- macOS x64
- Windows x64
- Linux x64

Upload release assets renamed exactly:

- `agentic-desktop-macos-arm64.dmg`
- `agentic-desktop-macos-x64.dmg`
- `agentic-desktop-windows-x64.msi`
- `agentic-desktop-linux-x64.AppImage`

The workflow may build or fetch the CLI sidecar using the Agent 2 contract, but do not edit CLI files.

### Verification

Run:

```sh
pnpm -F @solana-agent-wallet-adapter/desktop-shell typecheck
pnpm -F @solana-agent-wallet-adapter/desktop-shell build
```

Run this where the local platform supports it:

```sh
pnpm -F @solana-agent-wallet-adapter/desktop-shell tauri:build
```

Also confirm:

- installed-mode diagnostics do not point users at repo-only paths unless explicitly in dev fallback
- release workflow asset names match the shared contract exactly

## Coordination Notes

Agent 1 depends only on the shared release asset names and URL pattern, not on Agent 2 or 3 code.

Agent 2 owns the CLI sidecar contract that Agent 3 consumes. If Agent 2 must change command names, stop and report the conflict instead of silently diverging from this plan.

Agent 3 must use the Agent 2 sidecar command contract as written. Do not edit CLI implementation from Agent 3.

If two agents both need a small shared change, prefer documenting the blocker and asking the coordinating user to assign it rather than editing outside scope.
