#!/usr/bin/env bash
#
# Stream Jupiter iOS WalletConnect logs from a connected device, adb-logcat style.
# The iOS analog of:  adb logcat -c && adb logcat | grep -E "[Tags]"
#
# Requires libimobiledevice:  brew install libimobiledevice
#
# Usage:
#   ./scripts/ios-jupiter-logs.sh                 # all Agentic logs (native + JS)
#   ./scripts/ios-jupiter-logs.sh <UDID>          # target a specific device
#   AGENTIC_LOG_FILTER='\[AgenticWalletConnect\]|\[AgenticBridge\]|\[JS:jupiter\]' \
#     ./scripts/ios-jupiter-logs.sh               # narrow to the WalletConnect path
#
# See docs/ios-jupiter-logging.md for the full workflow + decoder ring.

set -uo pipefail

if ! command -v idevicesyslog >/dev/null 2>&1; then
  echo "error: idevicesyslog not found. Install it with:  brew install libimobiledevice" >&2
  exit 1
fi

UDID="${1:-$(idevice_id -l 2>/dev/null | head -n1)}"
if [ -z "${UDID}" ]; then
  echo "error: no connected iOS device found. Connect over USB, unlock, and tap Trust, then retry." >&2
  exit 1
fi

FILTER="${AGENTIC_LOG_FILTER:-\\[AgentIOSApp\\]}"

echo "Streaming Agentic iOS logs from device ${UDID} (Ctrl+C to stop)…" >&2
echo "Filter: ${FILTER}" >&2
echo "Tip: reproduce the Jupiter flow now (connect → sign → approve)." >&2
echo "----------------------------------------------------------------" >&2

# --line-buffered keeps the stream flowing line-by-line through the pipe.
idevicesyslog -u "${UDID}" | grep --line-buffered -E "${FILTER}"
