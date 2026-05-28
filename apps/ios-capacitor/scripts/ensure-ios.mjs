#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const IOS_DEPLOYMENT_TARGET = '16.0';
const CODE_SIGN_ENTITLEMENTS = 'App/App.entitlements';

const appDir = resolve(new URL('..', import.meta.url).pathname);
const iosDir = join(appDir, 'ios');
const project = join(iosDir, 'App/App.xcodeproj');
const infoPlist = join(iosDir, 'App/App/Info.plist');
const entitlements = join(iosDir, 'App/App/App.entitlements');
const capAppSpm = join(iosDir, 'App/CapApp-SPM/Package.swift');
const pbxproj = join(iosDir, 'App/App.xcodeproj/project.pbxproj');

if (!existsSync(project)) {
  await run('pnpm', ['exec', 'cap', 'add', 'ios'], { cwd: appDir, env: process.env });
}

const REQUIRED_PLIST_KEYS = [
  { key: 'NSFaceIDUsageDescription', valueType: 'string', value: 'Use Face ID to confirm wallet actions and protect sensitive operations.' },
  {
    key: 'UIBackgroundModes',
    valueType: 'array',
    value: ['fetch', 'processing'],
  },
  {
    key: 'BGTaskSchedulerPermittedIdentifiers',
    valueType: 'array',
    value: ['com.agentic.wallet.deviceagent.process'],
  },
  {
    key: 'LSApplicationQueriesSchemes',
    valueType: 'array',
    value: ['phantom', 'solflare', 'backpack', 'wc', 'https'],
  },
  { key: 'AGENTIC_CLOUD_API_BASE_URL', valueType: 'string', value: 'https://agentic-signer.com' },
  {
    key: 'AGENTIC_ALLOWED_ORIGINS',
    valueType: 'string',
    value: 'https://agentic-signer.com,https://agentic-seeker.com,capacitor://localhost',
  },
];

patchInfoPlist();
patchEntitlements();
patchCapAppSpmDeploymentTarget();
patchXcodeDeploymentTarget();

function patchInfoPlist() {
  if (!existsSync(infoPlist)) {
    return;
  }
  let plist = readFileSync(infoPlist, 'utf8');
  plist = plist
    .replace(/\n\s*<key>ITSAppUsesNonExemptEncryption<\/key>\s*\n\s*<false\/>\s*(?=<\/dict>\s*<\/array>)/g, '')
    .replace(/\n\s*<key>ITSAppUsesNonExemptEncryption<\/key>\s*\n\s*<false\/>\s*(?=<\/array>)/g, '');
  if (!plist.includes('<key>ITSAppUsesNonExemptEncryption</key>')) {
    plist = plist.replace(
      '<key>CFBundleURLTypes</key>',
      '<key>ITSAppUsesNonExemptEncryption</key>\n\t<false/>\n\t<key>CFBundleURLTypes</key>',
    );
  }
  if (!plist.includes('<string>agenticwallet</string>')) {
    plist = plist.replace(
      '</dict>',
      [
        '\t<key>CFBundleURLTypes</key>',
        '\t<array>',
        '\t\t<dict>',
        '\t\t\t<key>CFBundleURLName</key>',
        '\t\t\t<string>com.agentic.wallet</string>',
        '\t\t\t<key>CFBundleURLSchemes</key>',
        '\t\t\t<array>',
        '\t\t\t\t<string>agenticwallet</string>',
        '\t\t\t</array>',
        '\t\t</dict>',
        '\t</array>',
        '</dict>',
      ].join('\n'),
    );
  }
  // Insert required keys (NSFaceIDUsageDescription, BGTaskSchedulerPermittedIdentifiers,
  // UIBackgroundModes, LSApplicationQueriesSchemes, AGENTIC_*) if missing. We
  // insert just before the closing </dict> so the order stays predictable.
  for (const entry of REQUIRED_PLIST_KEYS) {
    if (plist.includes(`<key>${entry.key}</key>`)) continue;
    const block = renderPlistEntry(entry);
    plist = plist.replace(/<\/dict>\s*<\/plist>\s*$/, `${block}\n</dict>\n</plist>\n`);
  }
  writeFileSync(infoPlist, plist);
  console.log('[ios-capacitor] Ensured Info.plist keys');
}

function renderPlistEntry({ key, valueType, value }) {
  if (valueType === 'string') {
    return `\t<key>${key}</key>\n\t<string>${escapeXml(value)}</string>`;
  }
  if (valueType === 'array') {
    const items = value.map((v) => `\t\t<string>${escapeXml(v)}</string>`).join('\n');
    return `\t<key>${key}</key>\n\t<array>\n${items}\n\t</array>`;
  }
  throw new Error(`Unsupported plist valueType: ${valueType}`);
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function patchEntitlements() {
  const contents = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>com.apple.developer.associated-domains</key>',
    '\t<array>',
    '\t\t<string>applinks:agenticwalletadapter.com</string>',
    '\t\t<string>applinks:agentic-signer.com</string>',
    '\t</array>',
    '\t<key>com.apple.security.application-groups</key>',
    '\t<array>',
    '\t\t<string>group.com.agentic.wallet</string>',
    '\t</array>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
  writeFileSync(entitlements, contents);
  console.log('[ios-capacitor] Wrote associated-domain entitlements template');
}

function patchCapAppSpmDeploymentTarget() {
  if (!existsSync(capAppSpm)) {
    return;
  }
  let src = readFileSync(capAppSpm, 'utf8');
  // Capacitor's CLI regenerates CapApp-SPM/Package.swift from a template with
  // .iOS(.v15). The bridge package now requires .iOS(.v16); without this patch
  // transitive SPM resolution fails. We rewrite after every cap sync.
  const before = src;
  src = src.replace(/platforms:\s*\[\.iOS\(\.v\d+\)\]/g, `platforms: [.iOS(.v${IOS_DEPLOYMENT_TARGET.split('.')[0]})]`);
  if (src !== before) {
    writeFileSync(capAppSpm, src);
    console.log(`[ios-capacitor] Bumped CapApp-SPM platform to .iOS(.v${IOS_DEPLOYMENT_TARGET.split('.')[0]})`);
  }
}

function patchXcodeDeploymentTarget() {
  if (!existsSync(pbxproj)) {
    return;
  }
  let src = readFileSync(pbxproj, 'utf8');
  const before = src;
  src = src.replace(/IPHONEOS_DEPLOYMENT_TARGET = [\d.]+;/g, `IPHONEOS_DEPLOYMENT_TARGET = ${IOS_DEPLOYMENT_TARGET};`);
  src = src.replace(
    /ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;\n(?!\s*CODE_SIGN_ENTITLEMENTS = )/g,
    `ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;\n\t\t\t\tCODE_SIGN_ENTITLEMENTS = ${CODE_SIGN_ENTITLEMENTS};\n`,
  );
  if (src !== before) {
    writeFileSync(pbxproj, src);
    console.log(`[ios-capacitor] Ensured Xcode target settings`);
  }
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
