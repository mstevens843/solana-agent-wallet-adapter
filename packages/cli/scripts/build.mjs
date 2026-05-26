#!/usr/bin/env node
import { cp, chmod, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { build } from 'esbuild';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(scriptDir, '..');
const repoRoot = join(cliRoot, '..', '..');
const browserDist = join(repoRoot, 'apps', 'browser-demo', 'dist');
const distDir = join(cliRoot, 'dist');
const walletHostDist = join(distDir, 'wallet-host');
const cliPackageJson = JSON.parse(await readFile(join(cliRoot, 'package.json'), 'utf8'));
const cliVersion = String(cliPackageJson.version);
const optionalNativeModuleFilter =
  /^(?:@triton-one\/yellowstone-grpc|helius-laserstream|@triton-one\/yellowstone-grpc-napi-.+|yellowstone-grpc-napi-.+|helius-laserstream-.+)$/;
const startupQuietPrelude = [
  'const __agenticCliDebug = process.argv.includes("--debug") || process.env.AGENT_WALLET_DEBUG === "1";',
  'if (!__agenticCliDebug) {',
  '  const __agenticOriginalWarn = console.warn.bind(console);',
  '  console.warn = (...args) => {',
  '    const first = String(args[0] ?? "");',
  '    if (first.startsWith("bigint: Failed to load bindings, pure JS will be used")) return;',
  '    __agenticOriginalWarn(...args);',
  '  };',
  '  const __agenticOriginalEmitWarning = process.emitWarning.bind(process);',
  '  process.emitWarning = (warning, ...args) => {',
  '    const optionArg = args[0];',
  '    const type = optionArg && typeof optionArg === "object" ? optionArg.type : optionArg;',
  '    const code = optionArg && typeof optionArg === "object" ? optionArg.code : args[1];',
  '    const warningObject = warning && typeof warning === "object" ? warning : undefined;',
  '    if (type === "DeprecationWarning" || code === "DEP0040" || warningObject?.name === "DeprecationWarning" || warningObject?.code === "DEP0040") return;',
  '    return __agenticOriginalEmitWarning(warning, ...args);',
  '  };',
  '}',
].join('\n');

const optionalNativeStubPlugin = {
  name: 'optional-native-stub',
  setup(build) {
    build.onResolve({ filter: optionalNativeModuleFilter }, (args) => ({
      path: args.path,
      namespace: 'optional-native-stub',
    }));
    build.onLoad({ filter: /.*/, namespace: 'optional-native-stub' }, (args) => ({
      loader: 'js',
      contents: `
const unavailable = () => {
  throw new Error(${JSON.stringify(`Optional native module ${args.path} is not bundled in the Agentic CLI.`)});
};
class OptionalNativeClient {
  constructor() {
    unavailable();
  }
}
module.exports = OptionalNativeClient;
module.exports.default = OptionalNativeClient;
module.exports.CommitmentLevel = {};
module.exports.CompressionAlgorithms = {};
module.exports.LaserCommitmentLevel = {};
module.exports.subscribe = unavailable;
`,
    }));
  },
};

if (!existsSync(join(browserDist, 'index.html'))) {
  throw new Error(`Browser wallet host build is missing at ${browserDist}.`);
}

await build({
  entryPoints: [join(cliRoot, 'src', 'index.ts')],
  outfile: join(distDir, 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  define: {
    __AGENTIC_CLI_VERSION__: JSON.stringify(cliVersion),
  },
  plugins: [optionalNativeStubPlugin],
  banner: {
    js: [
      'import { createRequire as __agenticCreateRequire } from "node:module";',
      'import { fileURLToPath as __agenticFileURLToPath } from "node:url";',
      'import { dirname as __agenticDirname } from "node:path";',
      'const require = __agenticCreateRequire(import.meta.url);',
      'const __filename = __agenticFileURLToPath(import.meta.url);',
      'const __dirname = __agenticDirname(__filename);',
      startupQuietPrelude,
    ].join('\n'),
  },
  external: [
    'bufferutil',
    'utf-8-validate',
    '*.node',
    '@triton-one/yellowstone-grpc-napi-darwin-arm64',
    'helius-laserstream-darwin-arm64',
  ],
});

await chmod(join(distDir, 'index.js'), 0o755);
await rm(walletHostDist, { recursive: true, force: true });
await cp(browserDist, walletHostDist, {
  recursive: true,
  filter: (source) => !source.endsWith('.bak'),
});

console.log(`[cli-build] bundled CLI: ${join(distDir, 'index.js')}`);
console.log(`[cli-build] copied wallet host: ${walletHostDist}`);
