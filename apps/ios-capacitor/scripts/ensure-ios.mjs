#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const appDir = resolve(new URL('..', import.meta.url).pathname);
const iosDir = join(appDir, 'ios');
const project = join(iosDir, 'App/App.xcodeproj');
const infoPlist = join(iosDir, 'App/App/Info.plist');
const entitlements = join(iosDir, 'App/App/App.entitlements');

if (!existsSync(project)) {
  await run('pnpm', ['exec', 'cap', 'add', 'ios'], { cwd: appDir, env: process.env });
}

patchInfoPlist();
patchEntitlements();

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
  if (!plist.includes('<key>ITSAppUsesNonExemptEncryption</key>')) {
    plist = plist.replace(
      '<key>CFBundleURLTypes</key>',
      '<key>ITSAppUsesNonExemptEncryption</key>\n\t<false/>\n\t<key>CFBundleURLTypes</key>',
    );
  }
  writeFileSync(infoPlist, plist);
  console.log('[ios-capacitor] Ensured URL scheme and encryption export plist entries');
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
    '\t</array>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
  writeFileSync(entitlements, contents);
  console.log('[ios-capacitor] Wrote associated-domain entitlements template');
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
