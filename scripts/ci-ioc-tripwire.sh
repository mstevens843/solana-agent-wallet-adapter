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

# Local auth/session artifacts and live API keys must never be committed. Keep
# this narrow so fixture-style test secrets remain usable.
FORBIDDEN_PATHS=(
  ".env"
  ".env.local"
  "session.json"
)

SENSITIVE_REGEXES=(
  'sk-ant-api[0-9]+-[A-Za-z0-9_-]{20,}'
  'sk-proj-[A-Za-z0-9_-]{20,}'
  'AGENTIC_AI_API_KEY=.*sk-[A-Za-z0-9_-]{12,}'
  'BRIDGE_TOKEN=[A-Za-z0-9._~+/=-]{16,}'
)

# Documentation files that legitimately reference these strings as forensics.
EXCLUDE=(
  ":(exclude)docs/SECURITY.md"
  ":(exclude).github/workflows/ci.yml"
  ":(exclude)scripts/ci-ioc-tripwire.sh"
  ":(exclude).env.example"
  ":(exclude)**/__tests__/**"
)

fail=0

tracked_forbidden=''
for p in "${FORBIDDEN_PATHS[@]}"; do
  if git ls-files --error-unmatch "$p" >/dev/null 2>&1 && [ -e "$p" ]; then
    if [ -n "$tracked_forbidden" ]; then
      tracked_forbidden="${tracked_forbidden}
$p"
    else
      tracked_forbidden="$p"
    fi
  fi
done
if [ -n "$tracked_forbidden" ]; then
  echo "FAIL: local secret/session artifact tracked in git:"
  echo "$tracked_forbidden" | sed 's/^/  /'
  fail=1
fi

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

for p in "${SENSITIVE_REGEXES[@]}"; do
  matches=$(git grep -E -l -- "$p" -- . "${EXCLUDE[@]}" 2>/dev/null || true)
  if [ -n "$matches" ]; then
    echo "FAIL: live-looking secret pattern present in tracked file(s):"
    echo "$matches" | sed 's/^/  /'
    fail=1
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "ok: no supply-chain indicators-of-compromise detected"
fi

exit "$fail"
