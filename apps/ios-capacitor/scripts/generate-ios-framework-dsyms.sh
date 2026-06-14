#!/bin/sh
set -eu

FRAMEWORK_NAMES="FirebaseAnalytics GoogleAppMeasurement GoogleAppMeasurementIdentitySupport"

if [ -n "${DWARF_DSYM_FOLDER_PATH:-}" ]; then
  DSYM_DIR="${DWARF_DSYM_FOLDER_PATH:-}"
elif [ -n "${ARCHIVE_PATH:-}" ]; then
  DSYM_DIR="${ARCHIVE_PATH}/dSYMs"
else
  DSYM_DIR=""
fi

if [ -z "$DSYM_DIR" ]; then
  echo "[firebase-dsyms] DWARF_DSYM_FOLDER_PATH is empty; skipping"
  exit 0
fi

mkdir -p "$DSYM_DIR"

framework_binary_at_root() {
  root="$1"
  framework_name="$2"

  if [ -z "$root" ]; then
    return 1
  fi

  candidate="${root}/${framework_name}.framework/${framework_name}"
  if [ -f "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  return 1
}

find_framework_binary() {
  framework_name="$1"

  framework_binary_at_root "${TARGET_BUILD_DIR:-}/${FRAMEWORKS_FOLDER_PATH:-Frameworks}" "$framework_name" && return 0
  framework_binary_at_root "${BUILT_PRODUCTS_DIR:-}" "$framework_name" && return 0
  framework_binary_at_root "${ARCHIVE_PATH:-}/Products/Applications/App.app/Frameworks" "$framework_name" && return 0
  return 1
}

matching_dsym_exists() {
  binary="$1"
  dsym="$2"

  binary_uuid="$(dwarfdump --uuid "$binary" 2>/dev/null | awk 'NR == 1 { print $2 }')"
  if [ -z "$binary_uuid" ] || [ ! -d "$dsym" ]; then
    return 1
  fi

  dwarfdump --uuid "$dsym" 2>/dev/null | awk '{ print $2 }' | grep -qx "$binary_uuid"
}

for framework_name in $FRAMEWORK_NAMES; do
  binary="$(find_framework_binary "$framework_name" || true)"
  if [ -z "$binary" ]; then
    echo "[firebase-dsyms] ${framework_name}.framework not present; skipping"
    continue
  fi

  dsym="${DSYM_DIR}/${framework_name}.framework.dSYM"
  if matching_dsym_exists "$binary" "$dsym"; then
    echo "[firebase-dsyms] ${framework_name}.framework.dSYM already matches"
    continue
  fi

  echo "[firebase-dsyms] Generating ${dsym}"
  xcrun dsymutil "$binary" -o "$dsym"
done
