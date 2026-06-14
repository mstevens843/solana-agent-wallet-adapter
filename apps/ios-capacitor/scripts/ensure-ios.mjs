#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const IOS_DEPLOYMENT_TARGET = '16.0';
const FIREBASE_IOS_SDK_VERSION = '12.7.0';
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
  {
    key: 'GOOGLE_ANALYTICS_DEFAULT_ALLOW_AD_PERSONALIZATION_SIGNALS',
    valueType: 'bool',
    value: false,
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
patchCapAppSpmFirebase();
patchXcodeDeploymentTarget();
patchXcodeCapabilities();
patchFrameworkDsymBuildPhase();

function patchInfoPlist() {
  if (!existsSync(infoPlist)) {
    return;
  }
  const before = readFileSync(infoPlist, 'utf8');
  let plist = before;
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
  if (plist !== before) {
    writeFileSync(infoPlist, plist);
    console.log('[ios-capacitor] Ensured Info.plist keys');
  }
}

function renderPlistEntry({ key, valueType, value }) {
  if (valueType === 'string') {
    return `\t<key>${key}</key>\n\t<string>${escapeXml(value)}</string>`;
  }
  if (valueType === 'bool') {
    return `\t<key>${key}</key>\n\t<${value ? 'true' : 'false'}/>`;
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
  writeFileIfChanged(entitlements, contents, '[ios-capacitor] Wrote associated-domain entitlements template');
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

function patchCapAppSpmFirebase() {
  if (!existsSync(capAppSpm)) {
    return;
  }
  let src = readFileSync(capAppSpm, 'utf8');
  const before = src;
  if (!src.includes('firebase/firebase-ios-sdk.git')) {
    src = src.replace(
      '        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.3.1"),\n',
      `        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.3.1"),\n        .package(url: "https://github.com/firebase/firebase-ios-sdk.git", .upToNextMajor(from: "${FIREBASE_IOS_SDK_VERSION}")),\n`,
    );
  }
  if (!src.includes('.product(name: "FirebaseCore", package: "firebase-ios-sdk")')) {
    src = src.replace(
      '                .product(name: "Cordova", package: "capacitor-swift-pm"),\n',
      '                .product(name: "Cordova", package: "capacitor-swift-pm"),\n                .product(name: "FirebaseCore", package: "firebase-ios-sdk"),\n                .product(name: "FirebaseAnalyticsCore", package: "firebase-ios-sdk"),\n',
    );
  }
  if (src !== before) {
    writeFileSync(capAppSpm, src);
    console.log('[ios-capacitor] Ensured Firebase AnalyticsCore SPM dependency');
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

function patchXcodeCapabilities() {
  if (!existsSync(pbxproj)) {
    return;
  }
  let src = readFileSync(pbxproj, 'utf8');
  if (src.includes('SystemCapabilities = {')) {
    return;
  }
  const before = src;
  src = src.replace(
    /(\s+504EC3031FED79650016851F = \{\n\s+CreatedOnToolsVersion = 9\.2;\n\s+LastSwiftMigration = 1100;\n\s+ProvisioningStyle = Automatic;\n)(\s+\};)/,
    [
      '$1',
      '\t\t\t\t\t\tSystemCapabilities = {',
      '\t\t\t\t\t\t\tcom.apple.ApplicationGroups.iOS = {',
      '\t\t\t\t\t\t\t\tenabled = 1;',
      '\t\t\t\t\t\t\t};',
      '\t\t\t\t\t\t\tcom.apple.AssociatedDomains = {',
      '\t\t\t\t\t\t\t\tenabled = 1;',
      '\t\t\t\t\t\t\t};',
      '\t\t\t\t\t\t\tcom.apple.BackgroundModes = {',
      '\t\t\t\t\t\t\t\tenabled = 1;',
      '\t\t\t\t\t\t\t};',
      '\t\t\t\t\t\t};',
      '$2',
    ].join('\n'),
  );
  if (src !== before) {
    writeFileSync(pbxproj, src);
    console.log('[ios-capacitor] Ensured Xcode capability metadata');
  }
}

function patchFrameworkDsymBuildPhase() {
  if (!existsSync(pbxproj)) {
    return;
  }
  let src = readFileSync(pbxproj, 'utf8');
  if (src.includes('Generate Firebase dSYMs')) {
    return;
  }
  const before = src;
  src = src.replace(
    '\t\t\t\t504EC3021FED79650016851F /* Resources */,\n',
    '\t\t\t\t504EC3021FED79650016851F /* Resources */,\n\t\t\t\tB16C00000000000000000003 /* Generate Firebase dSYMs */,\n',
  );
  src = src.replace(
    '/* End PBXResourcesBuildPhase section */\n\n',
    [
      '/* End PBXResourcesBuildPhase section */',
      '',
      '/* Begin PBXShellScriptBuildPhase section */',
      '\t\tB16C00000000000000000003 /* Generate Firebase dSYMs */ = {',
      '\t\t\tisa = PBXShellScriptBuildPhase;',
      '\t\t\talwaysOutOfDate = 1;',
      '\t\t\tbuildActionMask = 2147483647;',
      '\t\t\tfiles = (',
      '\t\t\t);',
      '\t\t\tinputFileListPaths = (',
      '\t\t\t);',
      '\t\t\tinputPaths = (',
      '\t\t\t);',
      '\t\t\tname = "Generate Firebase dSYMs";',
      '\t\t\toutputFileListPaths = (',
      '\t\t\t);',
      '\t\t\toutputPaths = (',
      '\t\t\t);',
      '\t\t\trunOnlyForDeploymentPostprocessing = 0;',
      '\t\t\tshellPath = /bin/sh;',
      '\t\t\tshellScript = "sh \\\"${SRCROOT}/../../scripts/generate-ios-framework-dsyms.sh\\\"\\n";',
      '\t\t};',
      '/* End PBXShellScriptBuildPhase section */',
      '',
      '',
    ].join('\n'),
  );
  if (src === before) {
    throw new Error('Could not add Firebase dSYM build phase to project.pbxproj');
  }
  writeFileSync(pbxproj, src);
  console.log('[ios-capacitor] Ensured Firebase framework dSYM archive phase');
}
function writeFileIfChanged(filePath, contents, message) {
  if (existsSync(filePath) && readFileSync(filePath, 'utf8') === contents) {
    return;
  }
  writeFileSync(filePath, contents);
  console.log(message);
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
