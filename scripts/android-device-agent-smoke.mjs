#!/usr/bin/env node
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const DOC_PATH = path.join(ROOT, 'docs/smoke/android-device-agent.md');
const SCENARIO_DIR = path.join(ROOT, 'spec/evals/device-agent');
const SCHEMA_PATH = path.join(SCENARIO_DIR, 'smoke.schema.json');
const DEFAULT_REPORT = path.join(ROOT, 'build/android-device-agent-smoke/report.json');

const REQUIRED_WALLETS = [
  '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd',
  '7etjMSp87AUE135iW5dNeKridbW16rwSFVUN9ivfFm3w',
];

const REQUIRED_SCENARIO_IDS = [
  'android-enabled-seeker-draft',
  'android-opt-out-hidden',
  'render-allowlist-wallet-a',
  'render-allowlist-wallet-b',
  'render-denylist-wallet',
  'bridge-remains-separate',
  'device-agent-no-autonomous-authority',
  'android-native-generation-wired',
];

const SURFACES = new Set([
  'android-enabled',
  'android-disabled',
  'render-allowlist',
  'render-denylist',
  'bridge-regression',
  'boundary',
  'source-completion',
]);

const REQUIRED_DOC_PHRASES = [
  '# Android Device Agent Smoke',
  'pnpm android:build',
  'pnpm android:install',
  'pnpm android:build -- -PagenticDeviceAgent=false',
  'pnpm android:install -- -PagenticDeviceAgent=false',
  'AGENTIC_DEVICE_AGENT=1',
  'VITE_AGENTIC_DEVICE_AGENT=1',
  'Device Agent AI',
  'Device Agent - drafts via device',
  'Device Agent key',
  'Use key for drafts',
  'Confirm planner',
  'Draft with AI',
  'Ask agent',
  'Ask agent about this request',
  'Send for approval',
  'Needs Approval',
  'Device Agent is not enabled for this build or wallet.',
  'Device Agent runtime is gated on Render; no cloud daemon is started.',
  'Local Bridge AI',
  'Check local bridge',
  'node scripts/android-device-agent-smoke.mjs',
  'source-completion tripwires',
  'agent_not_implemented',
  'Device Agent drafts only. It cannot approve, sign, submit, or move funds.',
];

const REQUIRED_CORPUS_LABELS = [
  'Connect AI',
  'Device Agent AI',
  'Device Agent - drafts via device',
  'Device Agent key',
  'Use key for drafts',
  'Confirm planner',
  'Draft with AI',
  'Ask agent',
  'Ask agent about this request',
  'Send for approval',
  'Needs Approval',
  'Approve',
  'Local Bridge AI',
  'Check local bridge',
];

const REQUIRED_BOUNDARY_PHRASES = [
  'Device Agent drafts only. It cannot approve, sign, submit, or move funds.',
  'Every transaction still goes through Needs Approval and wallet approval.',
  'The agent never receives the wallet private key or seed phrase.',
];

const REQUIRED_FORBIDDEN_OUTCOMES = [
  'signed a transaction',
  'submitted a transaction',
  'approved a transfer without the wallet',
  'moved funds without Needs Approval',
];

main().catch((err) => {
  const code = typeof err?.exitCode === 'number' ? err.exitCode : 3;
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(code);
});

async function main() {
  const started = Date.now();
  const options = parseArgs(process.argv.slice(2));
  ensureReportPathAllowed(options.report);

  console.log(`android-device-agent-smoke: reading docs/smoke/android-device-agent.md and spec/evals/device-agent/`);
  const doc = await readText(DOC_PATH);
  const schema = await readJson(SCHEMA_PATH);
  const files = await loadScenarioFiles();

  const validationErrors = [
    ...validateDoc(doc),
    ...validateSchema(schema),
    ...validateCorpus(files),
  ];
  if (validationErrors.length) {
    for (const error of validationErrors) console.error(`schema: ${error}`);
    throw exitError(`Device Agent smoke validation failed with ${validationErrors.length} error(s).`, 2);
  }

  const filter = options.filter ? globToRegExp(options.filter) : undefined;
  const allEntries = files.flatMap((file) => file.scenarios.map((scenario) => ({ file: file.file, scenario })));
  const selected = allEntries.filter(({ scenario }) => !filter || filter.test(scenario.id));
  if (selected.length === 0) {
    throw exitError(`No Device Agent smoke scenarios selected by filter: ${options.filter}`, 2);
  }
  const results = [];
  for (const { scenario, file } of selected) {
    results.push(await evaluateScenario(scenario, file));
  }

  for (const result of results) printScenarioResult(result);

  const failed = results.filter((result) => result.status === 'failed');
  const warnings = results.reduce((total, result) => total + result.warnings.length, 0);
  const totals = {
    scenarios: results.length,
    passed: results.filter((result) => result.status === 'passed').length,
    failed: failed.length,
    skipped: allEntries.length - results.length,
    warnings,
  };
  const report = {
    version: 1,
    ranAt: new Date().toISOString(),
    node: process.version,
    filter: options.filter ?? null,
    totals,
    bySurface: summarizeBySurface(results),
    failures: failed.flatMap((result) => result.errors.map((reason) => ({
      id: result.id,
      surface: result.surface,
      reason,
    }))),
    results,
  };
  await writeReport(options.report, report);

  console.log('');
  console.log(`android-device-agent-smoke: ${totals.scenarios} scenarios, ${totals.passed} passed, ${totals.failed} failed (${Date.now() - started}ms)`);
  if (totals.warnings > 0 || totals.skipped > 0) {
    console.log(`android-device-agent-smoke: ${totals.warnings} warning(s), ${totals.skipped} skipped`);
  }
  console.log(`Report: ${path.relative(ROOT, options.report)}`);
  if (totals.failed > 0) {
    throw exitError(`Device Agent smoke failed with ${totals.failed} failing scenario(s).`, 1);
  }
}

function parseArgs(args) {
  const options = {
    filter: undefined,
    report: DEFAULT_REPORT,
  };
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/android-device-agent-smoke.mjs [--filter=<glob>] [--report=build/android-device-agent-smoke/report.json]');
      process.exit(0);
    } else if (arg.startsWith('--filter=')) {
      options.filter = arg.slice('--filter='.length);
    } else if (arg.startsWith('--report=')) {
      options.report = path.resolve(ROOT, arg.slice('--report='.length));
    } else {
      throw exitError(`Unknown argument: ${arg}`, 2);
    }
  }
  return options;
}

async function readText(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    throw exitError(`Could not read ${path.relative(ROOT, file)}. ${messageOf(err)}`, 2);
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    throw exitError(`Could not parse ${path.relative(ROOT, file)}. ${messageOf(err)}`, 2);
  }
}

async function loadScenarioFiles() {
  let names;
  try {
    names = await readdir(SCENARIO_DIR);
  } catch (err) {
    throw exitError(`Could not read ${path.relative(ROOT, SCENARIO_DIR)}. ${messageOf(err)}`, 3);
  }
  const scenarioFiles = names.filter((name) => name.endsWith('.scenarios.json')).sort();
  if (scenarioFiles.length === 0) {
    throw exitError('No Device Agent scenario files found in spec/evals/device-agent/*.scenarios.json.', 2);
  }
  const loaded = [];
  for (const name of scenarioFiles) {
    const filePath = path.join(SCENARIO_DIR, name);
    const parsed = await readJson(filePath);
    loaded.push({
      file: path.relative(ROOT, filePath),
      ...parsed,
    });
  }
  return loaded;
}

function validateDoc(doc) {
  const errors = [];
  for (const phrase of [...REQUIRED_DOC_PHRASES, ...REQUIRED_WALLETS]) {
    if (!includesNormalized(doc, phrase)) {
      errors.push(`docs/smoke/android-device-agent.md: required phrase not found: ${phrase}`);
    }
  }
  return errors;
}

function validateSchema(schema) {
  const errors = [];
  if (!isRecord(schema)) return ['spec/evals/device-agent/smoke.schema.json: root must be an object.'];
  if (schema.title !== 'Device Agent Smoke Scenario Corpus') {
    errors.push('spec/evals/device-agent/smoke.schema.json: title must be Device Agent Smoke Scenario Corpus.');
  }
  if (!isRecord(schema.$defs) || !isRecord(schema.$defs.scenario)) {
    errors.push('spec/evals/device-agent/smoke.schema.json: missing $defs.scenario.');
  }
  return errors;
}

function validateCorpus(files) {
  const errors = [];
  const ids = new Map();
  const scenarioIds = new Set();
  const combinedLabels = [];
  const combinedText = [];

  for (const file of files) {
    const fileLabel = file.file;
    if (!isRecord(file)) {
      errors.push(`${fileLabel}: root must be an object.`);
      continue;
    }
    if (file.version !== 1) errors.push(`${fileLabel}: version must be 1.`);
    if (!Array.isArray(file.scenarios) || file.scenarios.length === 0) {
      errors.push(`${fileLabel}: scenarios must be a non-empty array.`);
      continue;
    }
    file.scenarios.forEach((scenario, index) => {
      const where = `${fileLabel}#${index + 1}`;
      errors.push(...validateScenarioShape(scenario, where));
      if (!isRecord(scenario)) return;
      if (typeof scenario.id === 'string') {
        scenarioIds.add(scenario.id);
        const previous = ids.get(scenario.id);
        if (previous) {
          errors.push(`${where}: duplicate id "${scenario.id}" also appears in ${previous}.`);
        } else {
          ids.set(scenario.id, fileLabel);
        }
      }
      if (Array.isArray(scenario.requiredUiLabels)) combinedLabels.push(...scenario.requiredUiLabels);
      combinedText.push(scenarioText(scenario));
    });
  }

  for (const id of REQUIRED_SCENARIO_IDS) {
    if (!scenarioIds.has(id)) errors.push(`missing required scenario id: ${id}`);
  }
  const labelText = combinedLabels.join('\n');
  for (const label of REQUIRED_CORPUS_LABELS) {
    if (!includesNormalized(labelText, label)) errors.push(`scenario corpus missing required UI label: ${label}`);
  }
  const text = combinedText.join('\n');
  for (const wallet of REQUIRED_WALLETS) {
    if (!includesNormalized(text, wallet)) errors.push(`scenario corpus missing allowlisted wallet: ${wallet}`);
  }
  return errors;
}

function validateScenarioShape(scenario, where) {
  const errors = [];
  if (!isRecord(scenario)) return [`${where}: scenario must be an object.`];
  requireString(errors, scenario, 'id', where);
  if (typeof scenario.id === 'string' && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(scenario.id)) {
    errors.push(`${where}: id must be kebab-case.`);
  }
  requireString(errors, scenario, 'title', where);
  requireEnum(errors, scenario, 'surface', SURFACES, where);
  requireStringArray(errors, scenario, 'commands', where);
  requireStringArray(errors, scenario, 'requiredUiLabels', where);
  requireStringArray(errors, scenario, 'expectedFailureStates', where);
  requireStringArray(errors, scenario, 'forbiddenOutcomes', where);
  requireStringArray(errors, scenario, 'acceptance', where);
  if (scenario.sourceChecks !== undefined) {
    if (!Array.isArray(scenario.sourceChecks)) {
      errors.push(`${where}: sourceChecks must be an array when present.`);
    } else {
      scenario.sourceChecks.forEach((check, index) => {
        const checkWhere = `${where}.sourceChecks[${index}]`;
        if (!isRecord(check)) {
          errors.push(`${checkWhere}: source check must be an object.`);
          return;
        }
        requireString(errors, check, 'path', checkWhere);
        if (check.mustContain !== undefined) requireStringArray(errors, check, 'mustContain', checkWhere);
        if (check.mustNotContain !== undefined) requireStringArray(errors, check, 'mustNotContain', checkWhere);
        if (check.mustContain === undefined && check.mustNotContain === undefined) {
          errors.push(`${checkWhere}: source check must define mustContain or mustNotContain.`);
        }
      });
    }
  }
  if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) {
    errors.push(`${where}: steps must be a non-empty array.`);
  } else {
    scenario.steps.forEach((step, index) => {
      const stepWhere = `${where}.steps[${index}]`;
      if (!isRecord(step)) {
        errors.push(`${stepWhere}: step must be an object.`);
        return;
      }
      requireString(errors, step, 'action', stepWhere);
      requireString(errors, step, 'expect', stepWhere);
    });
  }
  return errors;
}

async function evaluateScenario(scenario, file) {
  const errors = [];
  const warnings = [];
  let assertions = 0;
  const text = scenarioText(scenario);
  const commandText = scenario.commands.join('\n');
  const labelText = scenario.requiredUiLabels.join('\n');
  const failureText = scenario.expectedFailureStates.join('\n');
  const forbiddenText = scenario.forbiddenOutcomes.join('\n');
  const acceptanceText = scenario.acceptance.join('\n');

  assertions += assertHasBoundaryPhrase(errors, text);

  if (scenario.surface === 'android-enabled') {
    assertions += assertIncludes(errors, commandText, 'pnpm android:build', 'standard Android build command');
    assertions += assertIncludes(errors, commandText, 'pnpm android:install', 'standard Android install command');
    for (const label of ['Device Agent AI', 'Device Agent key', 'Use key for drafts', 'Confirm planner', 'Draft with AI', 'Needs Approval', 'Approve']) {
      assertions += assertIncludes(errors, labelText, label, `enabled Android UI label ${label}`);
    }
    for (const outcome of REQUIRED_FORBIDDEN_OUTCOMES) {
      assertions += assertIncludes(errors, forbiddenText, outcome, `enabled Android forbidden outcome ${outcome}`);
    }
  }

  if (scenario.surface === 'android-disabled') {
    assertions += assertIncludes(errors, commandText, 'pnpm android:build -- -PagenticDeviceAgent=false', 'opt-out Android build command');
    assertions += assertIncludes(errors, commandText, 'pnpm android:install -- -PagenticDeviceAgent=false', 'opt-out Android install command');
    assertions += assertIncludes(errors, failureText, 'Device Agent is not enabled for this build or wallet.', 'disabled failure state');
    assertions += assertIncludes(errors, failureText, 'Device Agent AI is hidden.', 'disabled hidden UI state');
  }

  if (scenario.surface === 'render-allowlist') {
    assertions += assertIncludes(errors, commandText, 'AGENTIC_DEVICE_AGENT=1', 'Render runtime env gate');
    assertions += assertIncludes(errors, commandText, 'VITE_AGENTIC_DEVICE_AGENT=1', 'Render browser env gate');
    assertions += assertIncludes(errors, text, 'Device Agent runtime is gated on Render; no cloud daemon is started.', 'Render no-daemon status');
    assertions += assertIncludes(errors, forbiddenText, 'Render stored a provider API key', 'Render provider key forbidden outcome');
    assertions += assertIncludes(errors, forbiddenText, 'Render executed a Device Agent provider call', 'Render provider call forbidden outcome');
  }

  if (scenario.id === 'render-allowlist-wallet-a') {
    assertions += assertIncludes(errors, text, REQUIRED_WALLETS[0], 'allowlisted wallet A');
  }

  if (scenario.id === 'render-allowlist-wallet-b') {
    assertions += assertIncludes(errors, text, REQUIRED_WALLETS[1], 'allowlisted wallet B');
  }

  if (scenario.surface === 'render-denylist') {
    assertions += assertIncludes(errors, failureText, 'Device Agent is not enabled for this wallet.', 'Render denylist failure state');
    assertions += assertIncludes(errors, failureText, 'Device Agent AI is hidden.', 'Render denylist hidden UI state');
  }

  if (scenario.surface === 'bridge-regression') {
    for (const label of ['Local Bridge AI', 'Check local bridge', 'Local bridge not connected', 'Device Agent AI']) {
      assertions += assertIncludes(errors, labelText, label, `bridge regression label ${label}`);
    }
    assertions += assertIncludes(errors, acceptanceText, 'Device Agent and Local Bridge stay separate.', 'bridge separation acceptance');
  }

  if (scenario.surface === 'boundary') {
    for (const outcome of REQUIRED_FORBIDDEN_OUTCOMES) {
      assertions += assertIncludes(errors, forbiddenText, outcome, `boundary forbidden outcome ${outcome}`);
    }
    assertions += assertIncludes(errors, acceptanceText, 'The agent never receives the wallet private key or seed phrase.', 'private key boundary');
  }

  if (scenario.surface === 'source-completion') {
    assertions += assertIncludes(errors, acceptanceText, 'Android Device Agent generation, review, and ask are wired through the native runtime queue.', 'source completion acceptance');
    assertions += assertIncludes(errors, acceptanceText, 'Render Device Agent remains status/control only.', 'Render control-only acceptance');
  }

  if (Array.isArray(scenario.sourceChecks)) {
    for (const check of scenario.sourceChecks) {
      const result = await evaluateSourceCheck(check);
      assertions += result.assertions;
      errors.push(...result.errors);
    }
  }

  if (scenario.commands.length === 0 && scenario.surface !== 'boundary') {
    warnings.push('scenario has no commands and is not a boundary-only check');
  }

  return {
    id: scenario.id,
    title: scenario.title,
    file,
    surface: scenario.surface,
    status: errors.length || warnings.length ? 'failed' : 'passed',
    assertions,
    errors,
    warnings,
  };
}

async function evaluateSourceCheck(check) {
  const errors = [];
  let assertions = 0;
  let text = '';
  try {
    text = await readSourceCheckText(check.path);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
    return { assertions: 1, errors };
  }
  const contains = Array.isArray(check.mustContain) ? check.mustContain : [];
  const excludes = Array.isArray(check.mustNotContain) ? check.mustNotContain : [];
  for (const phrase of contains) {
    assertions += 1;
    if (!includesNormalized(text, phrase)) {
      errors.push(`${check.path}: required source phrase not found: ${phrase}`);
    }
  }
  for (const phrase of excludes) {
    assertions += 1;
    if (includesNormalized(text, phrase)) {
      errors.push(`${check.path}: forbidden source phrase found: ${phrase}`);
    }
  }
  return { assertions, errors };
}

async function readSourceCheckText(relativePath) {
  const target = path.resolve(ROOT, relativePath);
  const relative = path.relative(ROOT, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Source check path must stay inside the repository: ${relativePath}`);
  }
  let info;
  try {
    info = await stat(target);
  } catch (err) {
    throw new Error(`Source check path not found: ${relativePath}. ${messageOf(err)}`);
  }
  if (info.isFile()) {
    return readText(target);
  }
  if (!info.isDirectory()) {
    throw new Error(`Source check path is neither a file nor directory: ${relativePath}`);
  }
  const files = await listSourceFiles(target);
  const contents = [];
  for (const file of files) {
    contents.push(await readText(file));
  }
  return contents.join('\n');
}

async function listSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listSourceFiles(absolute));
    } else if (entry.isFile() && isTextSourceFile(entry.name)) {
      files.push(absolute);
    }
  }
  return files.sort();
}

function isTextSourceFile(name) {
  return /\.(kt|java|ts|tsx|js|mjs|json|md|xml|kts)$/i.test(name);
}

function assertHasBoundaryPhrase(errors, text) {
  if (REQUIRED_BOUNDARY_PHRASES.some((phrase) => includesNormalized(text, phrase))) return 1;
  errors.push('missing required Device Agent wallet-boundary phrase');
  return 1;
}

function assertIncludes(errors, haystack, needle, label) {
  if (!includesNormalized(haystack, needle)) {
    errors.push(`${label} not found: ${needle}`);
  }
  return 1;
}

function printScenarioResult(result) {
  const marker = result.status === 'passed' ? 'PASS' : 'FAIL';
  console.log(`${marker} ${result.id} (${result.assertions} assertions)`);
  for (const warning of result.warnings) console.log(`  warning-as-failure: ${warning}`);
  for (const error of result.errors) console.log(`  error: ${error}`);
}

function summarizeBySurface(results) {
  const summary = {};
  for (const result of results) {
    const entry = summary[result.surface] ?? { passed: 0, failed: 0 };
    if (result.status === 'failed') entry.failed += 1;
    else entry.passed += 1;
    summary[result.surface] = entry;
  }
  return summary;
}

async function writeReport(file, report) {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  } catch (err) {
    throw exitError(`Could not write report ${path.relative(ROOT, file)}. ${messageOf(err)}`, 3);
  }
}

function scenarioText(scenario) {
  return [
    scenario.id,
    scenario.title,
    scenario.surface,
    ...(Array.isArray(scenario.commands) ? scenario.commands : []),
    ...(Array.isArray(scenario.requiredUiLabels) ? scenario.requiredUiLabels : []),
    ...(Array.isArray(scenario.steps) ? scenario.steps.flatMap((step) => isRecord(step) ? [step.action, step.expect] : []) : []),
    ...(Array.isArray(scenario.expectedFailureStates) ? scenario.expectedFailureStates : []),
    ...(Array.isArray(scenario.forbiddenOutcomes) ? scenario.forbiddenOutcomes : []),
    ...(Array.isArray(scenario.acceptance) ? scenario.acceptance : []),
    ...(Array.isArray(scenario.sourceChecks)
      ? scenario.sourceChecks.flatMap((check) => isRecord(check)
        ? [
            check.path,
            ...(Array.isArray(check.mustContain) ? check.mustContain : []),
            ...(Array.isArray(check.mustNotContain) ? check.mustNotContain : []),
          ]
        : [])
      : []),
  ].join('\n');
}

function globToRegExp(glob) {
  let source = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*') source += '.*';
    else if (char === '?') source += '.';
    else if (char === '[') {
      const end = glob.indexOf(']', index + 1);
      if (end === -1) {
        source += '\\[';
      } else {
        source += glob.slice(index, end + 1);
        index = end;
      }
    } else {
      source += char.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
    }
  }
  source += '$';
  return new RegExp(source);
}

function ensureReportPathAllowed(file) {
  const relative = path.relative(ROOT, file);
  const isOutsideRoot = relative.startsWith('..') || path.isAbsolute(relative);
  const isAllowedBuildPath = relative === 'build/android-device-agent-smoke' || relative.startsWith('build/android-device-agent-smoke/');
  if (isOutsideRoot || !isAllowedBuildPath) {
    throw exitError(`Report path must stay under build/android-device-agent-smoke/: ${relative}`, 3);
  }
}

function includesNormalized(haystack, needle) {
  return normalizeText(haystack).includes(normalizeText(needle));
}

function normalizeText(value) {
  return String(value).replace(/\s+/g, ' ').trim().toLowerCase();
}

function requireString(errors, record, key, where) {
  if (typeof record[key] !== 'string' || !record[key].trim()) {
    errors.push(`${where}: ${key} must be a non-empty string.`);
  }
}

function requireStringArray(errors, record, key, where) {
  const value = record[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    errors.push(`${where}: ${key} must be an array of non-empty strings.`);
  }
}

function requireEnum(errors, record, key, values, where) {
  if (!values.has(record[key])) {
    errors.push(`${where}: ${key} must be one of ${[...values].join(', ')}.`);
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}

function exitError(message, exitCode) {
  const err = new Error(message);
  err.exitCode = exitCode;
  return err;
}
