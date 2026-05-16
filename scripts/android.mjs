#!/usr/bin/env node
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { chmod, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import https from 'node:https';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appDir = join(root, 'apps/android-twa');
const assetLinksPath = join(root, 'apps/browser-demo/public/.well-known/assetlinks.json');
const packageName = 'com.agentic.wallet';
const zeroFingerprint = '00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00';
const gradleVersion = '8.11.1';
const gradleHome = join(root, '.gradle/agentic-android', `gradle-${gradleVersion}`);
const gradleZip = join(root, '.gradle/agentic-android', `gradle-${gradleVersion}-bin.zip`);
const sdkFallback = join(process.env.HOME ?? '', 'Library/Android/sdk');

const [command = 'build', ...extraArgs] = process.argv.slice(2);
const forwardedGradleArgs = extraArgs.filter((arg) => arg !== '--');

if (command === 'fingerprint') {
  fingerprint(extraArgs);
  process.exit(0);
}

if (command === 'assetlinks') {
  assetlinks(extraArgs);
  process.exit(0);
}

if (command === 'assetlinks:write') {
  assetlinks(['--write', ...extraArgs]);
  process.exit(0);
}

if (command === 'assetlinks:verify') {
  verifyAssetLinks(extraArgs);
  process.exit(0);
}

const tasks = {
  build: ['assembleDebug'],
  debug: ['assembleDebug'],
  release: ['bundleRelease', 'assembleRelease'],
  install: ['installDebug'],
};

if (!Object.hasOwn(tasks, command)) {
  console.error(`[android] Unknown command: ${command}`);
  console.error('[android] Use one of: build, debug, release, install, fingerprint, assetlinks, assetlinks:write, assetlinks:verify');
  process.exit(1);
}

const env = {
  ...process.env,
  ANDROID_HOME: process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || sdkFallback,
  ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME || sdkFallback,
};

await ensureAndroidSdk(env);
const gradle = await resolveGradle();
await run(gradle.command, [...gradle.args, '--no-daemon', ...forwardedGradleArgs, ...tasks[command]], {
  cwd: appDir,
  env,
});

async function ensureAndroidSdk(env) {
  const androidJar = join(env.ANDROID_HOME, 'platforms/android-36/android.jar');
  if (!existsSync(androidJar)) {
    console.error(`[android] Android SDK platform 36 not found at ${androidJar}`);
    console.error('[android] Install Android SDK platform 36, or set ANDROID_HOME/ANDROID_SDK_ROOT.');
    process.exit(1);
  }
}

async function resolveGradle() {
  const configured = process.env.GRADLE;
  if (configured) return { command: configured, args: [] };

  const wrapperGradle = join(appDir, 'gradlew');
  if (existsSync(wrapperGradle)) return { command: wrapperGradle, args: [] };

  const systemGradle = spawnSync('gradle', ['--version'], { stdio: 'ignore' });
  if (systemGradle.status === 0) return { command: 'gradle', args: [] };

  const localGradle = join(gradleHome, 'bin/gradle');
  if (!existsSync(localGradle)) {
    await downloadGradle();
  }
  return { command: localGradle, args: [] };
}

async function downloadGradle() {
  mkdirSync(dirname(gradleZip), { recursive: true });
  const url = `https://services.gradle.org/distributions/gradle-${gradleVersion}-bin.zip`;
  console.log(`[android] Gradle is not installed. Downloading ${url}`);
  await download(url, gradleZip);
  await run('unzip', ['-q', '-o', gradleZip, '-d', dirname(gradleHome)], { cwd: root, env: process.env });
  await chmod(join(gradleHome, 'bin/gradle'), 0o755);
}

function download(url, destination) {
  return new Promise((resolveDownload, rejectDownload) => {
    const request = https.get(url, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
        response.resume();
        download(response.headers.location, destination).then(resolveDownload, rejectDownload);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        rejectDownload(new Error(`Download failed with HTTP ${response.statusCode}`));
        return;
      }
      const file = createWriteStream(destination);
      response.pipe(file);
      file.on('finish', () => {
        file.close(resolveDownload);
      });
      file.on('error', rejectDownload);
    });
    request.on('error', async (err) => {
      await rm(destination, { force: true }).catch(() => {});
      rejectDownload(err);
    });
  });
}

async function run(command, args, options) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      ...options,
      stdio: 'inherit',
    });
    child.on('error', rejectRun);
    child.on('exit', (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} ${args.join(' ')} exited with code ${code ?? 1}`));
    });
  });
}

function fingerprint(args) {
  const options = parseOptions(args);
  const config = keystoreConfig(options);
  const sha256 = readKeystoreFingerprint(config);
  const assetLinks = buildAssetLinks(config.packageName, [sha256]);

  console.log(`[android] Keystore: ${config.keystore}`);
  console.log(`[android] Alias: ${config.alias}`);
  console.log(`[android] SHA256: ${sha256}`);
  console.log('[android] assetlinks.json:');
  console.log(JSON.stringify(assetLinks, null, 2));
}

function assetlinks(args) {
  const options = parseOptions(args);
  const fingerprints = resolveAssetLinkFingerprints(options);
  const outputPath = resolve(options.out ?? assetLinksPath);
  const appPackage = options.package ?? process.env.AGENTIC_ANDROID_PACKAGE_NAME ?? packageName;
  const assetLinks = buildAssetLinks(appPackage, fingerprints);
  const json = `${JSON.stringify(assetLinks, null, 2)}\n`;

  if (options.write) {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, json);
    console.log(`[android] Wrote ${outputPath}`);
  }

  console.log(json.trimEnd());
}

function resolveAssetLinkFingerprints(options) {
  const fromEnv = process.env.AGENTIC_ANDROID_SHA256_CERT_FINGERPRINTS;
  if (fromEnv) {
    const fingerprints = fromEnv
      .split(/[,\n]/)
      .map((value) => normalizeFingerprint(value))
      .filter(Boolean);
    validateFingerprints(fingerprints, { allowPlaceholder: false });
    if (fingerprints.length === 0) {
      console.error('[android] AGENTIC_ANDROID_SHA256_CERT_FINGERPRINTS was set but no fingerprints were found.');
      process.exit(1);
    }
    return fingerprints;
  }

  const config = keystoreConfig(options);
  return [readKeystoreFingerprint(config)];
}

function keystoreConfig(options) {
  return {
    keystore: resolve(
      options.keystore ??
        options.positional[0] ??
        process.env.AGENTIC_ANDROID_KEYSTORE ??
        join(process.env.HOME ?? '', '.android/debug.keystore'),
    ),
    alias:
      options.alias ??
      options.positional[1] ??
      process.env.AGENTIC_ANDROID_KEY_ALIAS ??
      'androiddebugkey',
    storepass:
      options.storepass ??
      options.positional[2] ??
      process.env.AGENTIC_ANDROID_STORE_PASSWORD ??
      'android',
    packageName: options.package ?? process.env.AGENTIC_ANDROID_PACKAGE_NAME ?? packageName,
  };
}

function readKeystoreFingerprint({ keystore, alias, storepass }) {
  if (!existsSync(keystore) || !statSync(keystore).isFile()) {
    console.error(`[android] Keystore not found: ${keystore}`);
    process.exit(1);
  }

  const result = spawnSync(
    'keytool',
    ['-list', '-v', '-keystore', keystore, '-alias', alias, '-storepass', storepass],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }

  const match = result.stdout.match(/SHA256:\s*([A-F0-9:]+)/i);
  if (!match) {
    console.error('[android] SHA256 fingerprint not found in keytool output.');
    process.exit(1);
  }

  return normalizeFingerprint(match[1]);
}

function buildAssetLinks(appPackage, fingerprints) {
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: appPackage,
        sha256_cert_fingerprints: fingerprints,
      },
    },
  ];
}

function verifyAssetLinks(args) {
  const options = parseOptions(args);
  const file = resolve(options.file ?? options.out ?? assetLinksPath);
  const appPackage = options.package ?? process.env.AGENTIC_ANDROID_PACKAGE_NAME ?? packageName;
  const expectedFingerprints = process.env.AGENTIC_ANDROID_SHA256_CERT_FINGERPRINTS
    ?.split(/[,\n]/)
    .map((value) => normalizeFingerprint(value))
    .filter(Boolean) ?? [];

  if (!existsSync(file) || !statSync(file).isFile()) {
    console.error(`[android] assetlinks file not found: ${file}`);
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[android] assetlinks JSON is invalid: ${message}`);
    process.exit(1);
  }

  if (!Array.isArray(parsed)) {
    console.error('[android] assetlinks JSON must be an array.');
    process.exit(1);
  }

  const entry = parsed.find((candidate) => candidate?.target?.package_name === appPackage);
  if (!entry) {
    console.error(`[android] assetlinks target package not found: ${appPackage}`);
    process.exit(1);
  }
  if (!Array.isArray(entry.relation) || !entry.relation.includes('delegate_permission/common.handle_all_urls')) {
    console.error('[android] assetlinks relation must include delegate_permission/common.handle_all_urls.');
    process.exit(1);
  }
  if (entry.target?.namespace !== 'android_app') {
    console.error('[android] assetlinks target namespace must be android_app.');
    process.exit(1);
  }

  const fingerprints = entry.target?.sha256_cert_fingerprints;
  if (!Array.isArray(fingerprints) || fingerprints.length === 0) {
    console.error('[android] assetlinks target must include sha256_cert_fingerprints.');
    process.exit(1);
  }
  const normalizedFingerprints = fingerprints.map((value) => normalizeFingerprint(String(value)));
  validateFingerprints(normalizedFingerprints, { allowPlaceholder: Boolean(options.allowPlaceholder) });

  for (const expected of expectedFingerprints) {
    if (!normalizedFingerprints.includes(expected)) {
      console.error(`[android] Expected fingerprint missing from assetlinks: ${expected}`);
      process.exit(1);
    }
  }

  console.log(`[android] Verified ${file}`);
}

function validateFingerprints(fingerprints, { allowPlaceholder }) {
  for (const fingerprint of fingerprints) {
    if (!/^[A-F0-9]{2}(:[A-F0-9]{2}){31}$/.test(fingerprint)) {
      console.error(`[android] Invalid SHA256 certificate fingerprint: ${fingerprint}`);
      process.exit(1);
    }
    if (!allowPlaceholder && fingerprint === zeroFingerprint) {
      console.error('[android] assetlinks contains the placeholder zero fingerprint.');
      process.exit(1);
    }
  }
}

function normalizeFingerprint(value) {
  const raw = value.trim();
  if (!raw) return '';
  const hex = raw.replace(/[^a-fA-F0-9]/g, '').toUpperCase();
  if (hex.length === 64) {
    return hex.match(/.{2}/g).join(':');
  }
  return raw.toUpperCase();
}

function parseOptions(args) {
  const options = { positional: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') {
      continue;
    }
    if (arg === '--write') {
      options.write = true;
      continue;
    }
    if (arg === '--allow-placeholder') {
      options.allowPlaceholder = true;
      continue;
    }
    if (arg.startsWith('--file=')) {
      options.file = arg.slice('--file='.length);
      continue;
    }
    if (arg === '--file') {
      options.file = args[++index];
      continue;
    }
    if (arg.startsWith('--out=')) {
      options.out = arg.slice('--out='.length);
      continue;
    }
    if (arg === '--out') {
      options.out = args[++index];
      continue;
    }
    if (arg.startsWith('--keystore=')) {
      options.keystore = arg.slice('--keystore='.length);
      continue;
    }
    if (arg === '--keystore') {
      options.keystore = args[++index];
      continue;
    }
    if (arg.startsWith('--alias=')) {
      options.alias = arg.slice('--alias='.length);
      continue;
    }
    if (arg === '--alias') {
      options.alias = args[++index];
      continue;
    }
    if (arg.startsWith('--storepass=')) {
      options.storepass = arg.slice('--storepass='.length);
      continue;
    }
    if (arg === '--storepass') {
      options.storepass = args[++index];
      continue;
    }
    if (arg.startsWith('--package=')) {
      options.package = arg.slice('--package='.length);
      continue;
    }
    if (arg === '--package') {
      options.package = args[++index];
      continue;
    }
    options.positional.push(arg);
  }
  return options;
}
