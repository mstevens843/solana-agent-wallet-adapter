#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function commandOk(command, args = ['--version']) {
  const result = spawnSync(command, args, { stdio: 'ignore' });
  return result.status === 0;
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return {
    ok: result.status === 0,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

const failures = [];

if (!commandOk('cargo')) {
  const cargoHomeBin = join(homedir(), '.cargo', 'bin', 'cargo');
  const pathHint = existsSync(cargoHomeBin)
    ? `Rust exists at ${cargoHomeBin}, but ~/.cargo/bin is not on PATH. Run: source "$HOME/.cargo/env"`
    : 'Install Rust first: curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh';

  failures.push(`cargo was not found on PATH. ${pathHint}`);
}

if (process.platform === 'darwin') {
  const xcodeSelect = commandOutput('xcode-select', ['-p']);
  if (!xcodeSelect.ok || !xcodeSelect.stdout) {
    failures.push('macOS Command Line Tools were not found. Run: xcode-select --install');
  }
}

if (failures.length > 0) {
  console.error('[desktop-tauri] Missing native prerequisites:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}
