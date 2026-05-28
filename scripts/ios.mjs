#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const capacitorAppDir = join(root, 'apps/ios-capacitor');
const nativeAppDir = join(root, 'apps/ios-native');
const [command = 'build', ...extraArgs] = process.argv.slice(2);

const commands = new Set(['mode', 'build', 'debug', 'release', 'sync', 'open']);
if (!commands.has(command)) {
  console.error(`[ios] Unknown command: ${command}`);
  console.error('[ios] Use one of: mode, build, debug, release, sync, open');
  process.exit(1);
}

const mode = capacitorIosEnabled() ? 'capacitor' : 'native-swift';
console.log(`[ios] mode=${mode} CAPACITOR_IOS_APP=${String(resolveIosFlagRaw())}`);

if (command === 'mode') {
  process.exit(0);
}

if (mode === 'capacitor') {
  await runCapacitor(command, extraArgs);
} else {
  await runNativeSwift(command, extraArgs);
}

async function runCapacitor(selectedCommand, forwardedArgs) {
  if (selectedCommand === 'open') {
    await run('pnpm', ['-F', '@solana-agent-wallet-adapter/ios-capacitor', 'open', ...forwardedArgs], {
      cwd: root,
      env: iosEnv(),
    });
    return;
  }

  await run('pnpm', ['--filter', '@solana-agent-wallet-adapter/browser-demo^...', 'build'], {
    cwd: root,
    env: iosEnv(),
  });
  await run('pnpm', ['-F', '@solana-agent-wallet-adapter/browser-demo', 'build'], {
    cwd: root,
    env: iosEnv(),
  });
  await run('pnpm', ['-F', '@solana-agent-wallet-adapter/ios-capacitor', 'copy-web'], {
    cwd: root,
    env: iosEnv(),
  });
  await run('pnpm', ['-F', '@solana-agent-wallet-adapter/ios-capacitor', 'sync'], {
    cwd: root,
    env: iosEnv(),
  });

  if (selectedCommand === 'sync') {
    return;
  }

  const workspace = join(capacitorAppDir, 'ios/App/App.xcworkspace');
  const project = join(capacitorAppDir, 'ios/App/App.xcodeproj');
  if (!existsSync(workspace) && !existsSync(project)) {
    console.log('[ios] Capacitor iOS project was not generated; sync completed but xcodebuild was skipped.');
    return;
  }

  const destination = process.env.AGENTIC_IOS_DESTINATION ?? 'generic/platform=iOS';
  const configuration = selectedCommand === 'release' ? 'Release' : 'Debug';
  const derivedDataPath = process.env.AGENTIC_IOS_DERIVED_DATA ?? join(capacitorAppDir, 'build/DerivedData');
  const clonedPackagesPath = process.env.AGENTIC_IOS_SOURCE_PACKAGES ?? join(capacitorAppDir, 'build/SourcePackages');
  const buildArgs = existsSync(workspace)
    ? ['-workspace', workspace, '-scheme', 'App']
    : ['-project', project, '-scheme', 'App'];
  await run(
    'xcodebuild',
    [
      ...buildArgs,
      '-configuration',
      configuration,
      '-destination',
      destination,
      '-derivedDataPath',
      derivedDataPath,
      '-clonedSourcePackagesDirPath',
      clonedPackagesPath,
      'CODE_SIGNING_ALLOWED=NO',
      ...forwardedArgs,
      'build',
    ],
    {
      cwd: capacitorAppDir,
      env: xcodeEnv(),
    },
  );
}

async function runNativeSwift(selectedCommand, forwardedArgs) {
  if (selectedCommand === 'open') {
    await run('open', [nativeAppDir], { cwd: root, env: iosEnv() });
    return;
  }
  const configuration = selectedCommand === 'release' ? 'release' : 'debug';
  await run('swift', ['build', '-c', configuration, ...forwardedArgs], {
    cwd: nativeAppDir,
    env: iosEnv(),
  });
}

function capacitorIosEnabled() {
  const raw = resolveIosFlagRaw();
  return !new Set(['0', 'false', 'no', 'off', 'native', 'swift']).has(String(raw).trim().toLowerCase());
}

function resolveIosFlagRaw() {
  return (
    process.env.CAPACITOR_IOS_APP ??
    process.env.CAPACITATOR_IOS_APP ??
    process.env.VITE_CAPACITOR_IOS_APP ??
    process.env.VITE_CAPACITATOR_IOS_APP ??
    'true'
  );
}

function iosEnv() {
  const raw = String(resolveIosFlagRaw());
  const env = {
    ...process.env,
    CAPACITOR_IOS_APP: raw,
    CAPACITATOR_IOS_APP: raw,
    VITE_CAPACITOR_IOS_APP: raw,
    VITE_CAPACITATOR_IOS_APP: raw,
  };
  env.VITE_AGENTIC_DEVICE_AGENT = env.VITE_AGENTIC_DEVICE_AGENT ?? 'true';
  env.VITE_AGENTIC_BROWSER_DEVICE_AGENT = env.VITE_AGENTIC_BROWSER_DEVICE_AGENT ?? 'false';
  const xcodeDeveloperDir = '/Applications/Xcode.app/Contents/Developer';
  if (!env.DEVELOPER_DIR && existsSync(xcodeDeveloperDir)) {
    env.DEVELOPER_DIR = xcodeDeveloperDir;
  }
  const cacheRoot = join(root, 'build/ios-cache');
  env.XDG_CACHE_HOME = env.XDG_CACHE_HOME ?? join(cacheRoot, 'xdg');
  env.CLANG_MODULE_CACHE_PATH = env.CLANG_MODULE_CACHE_PATH ?? join(cacheRoot, 'clang-modules');
  env.SWIFTPM_MODULECACHE_OVERRIDE = env.SWIFTPM_MODULECACHE_OVERRIDE ?? join(cacheRoot, 'swiftpm-modules');
  return env;
}

function xcodeEnv() {
  return {
    ...iosEnv(),
    HOME: process.env.AGENTIC_IOS_HOME ?? join(root, 'build/ios-home'),
  };
}

async function run(commandName, args, options) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(commandName, args, {
      ...options,
      stdio: 'inherit',
    });
    child.on('error', rejectRun);
    child.on('exit', (code) => {
      if (code === 0) {
        resolveRun();
      } else {
        rejectRun(new Error(`${commandName} ${args.join(' ')} exited with code ${code ?? 1}`));
      }
    });
  });
}
