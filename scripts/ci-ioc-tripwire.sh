#!/usr/bin/env bash
# Supply-chain indicator-of-compromise tripwire.
#
# Fails CI if any unambiguous IoC string is present in the lockfile or any
# committed source file. Strings here are chosen to be unlikely to appear
# legitimately — broader scope-level checks live in docs/SECURITY.md as
# operator-run forensics, not CI.
#
# Runs locally with no arguments: `bash scripts/ci-ioc-tripwire.sh`.

set -euo pipefail

cd "$(dirname "$0")/.."

PATTERNS=(
  # Mini Shai-Hulud / CVE-2026-45321 (May 2026 npm worm family)
  "router_init.js"
  "ab4fcadaec49c03278063dd269ea5eef82d24f2124a8e15d7b90f2fa8601266c"
  "raydium-bs58"
  "base-x-64"
  "bs58-basic"
  "ethersproject-wallet"
  "@kodane/patch-manager"
  "solana-transaction-toolkit"
  "solana-stable-web-huks"
  # mistralai PyPI v2.4.6 compromise (cross-ecosystem awareness — checks that
  # the C2 host and payload filenames never appear in our tree even though
  # we are an npm project, since dev machines often run mixed toolchains).
  "83.142.209.194"
  "transformers.pyz"
  "pgsql-monitor.service"
  "pgmonitor.py"
)

# Documentation files that legitimately reference these strings as forensics.
EXCLUDE=(
  ":(exclude)docs/SECURITY.md"
  ":(exclude).github/workflows/ci.yml"
  ":(exclude)scripts/ci-ioc-tripwire.sh"
)

fail=0

if [ -f pnpm-lock.yaml ]; then
  for p in "${PATTERNS[@]}"; do
    if grep -F -q -- "$p" pnpm-lock.yaml; then
      echo "FAIL: '$p' present in pnpm-lock.yaml"
      fail=1
    fi
  done
fi

for p in "${PATTERNS[@]}"; do
  matches=$(git grep -F -l -- "$p" -- . "${EXCLUDE[@]}" 2>/dev/null || true)
  if [ -n "$matches" ]; then
    echo "FAIL: '$p' present in tracked file(s):"
    echo "$matches" | sed 's/^/  /'
    fail=1
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "ok: no supply-chain indicators-of-compromise detected"
fi

exit "$fail"
