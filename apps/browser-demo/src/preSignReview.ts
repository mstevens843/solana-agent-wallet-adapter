// Pure pre-sign review model.
//
// Turns transaction facts (sends, swaps, custom transactions) into compact,
// UI-ready review models. The functions are pure: no I/O, no DOM, no clock.
//
// Invariants:
//   * Title is always `Review before wallet opens`.
//   * Missing/empty/undefined/null fields are OMITTED — never rendered as `n/a`
//     or placeholder dashes.
//   * Long addresses are shortened in `value`; the full address stays in
//     `title` and `copyValue` so the UI can copy and tooltip it.
//   * Warnings are short factual phrases; they do not advise the user.

export type ReviewTone = 'neutral' | 'good' | 'warn' | 'danger';

export interface PreSignReviewRow {
  label: string;
  value: string;
  title?: string;
  copyValue?: string;
  tone?: ReviewTone;
}

export interface PreSignReviewSection {
  title: string;
  rows: PreSignReviewRow[];
  note?: string;
}

export interface PreSignReviewModel {
  title: string;
  subtitle: string;
  riskTone: ReviewTone;
  primaryAction: string;
  sections: PreSignReviewSection[];
  warnings: string[];
}

export interface TouchedProgramInput {
  programId: string;
  label?: string;
  source?: 'parsed' | 'known' | 'unknown';
  writable?: boolean;
}

export interface SendPreSignReviewInput {
  cluster: string;
  sender?: string;
  recipient?: string;
  amount?: string;
  token?: string;
  memo?: string;
  estimatedFee?: string;
  currentBalance?: string;
  postSendBalance?: string;
  balanceIsInsufficient?: boolean;
  mainnetWarning?: boolean;
  touchedPrograms?: TouchedProgramInput[];
}

export interface SwapPreSignReviewInput {
  cluster: string;
  taker?: string;
  inputToken?: string;
  inputAmount?: string;
  outputToken?: string;
  expectedOutput?: string;
  minimumReceived?: string;
  slippageBps?: number;
  routeLabel?: string;
  jupiterRequestId?: string;
  priceImpactPct?: number;
  priceImpactWarnPct?: number;
  platformFee?: string;
  touchedPrograms?: TouchedProgramInput[];
}

export interface CustomTransactionPreSignReviewInput {
  cluster: string;
  transactionHash?: string;
  transactionByteLength?: number;
  feePayer?: string;
  instructionCount?: number;
  writableAccountCount?: number;
  signerCount?: number;
  touchedPrograms?: TouchedProgramInput[];
  warnings?: string[];
}

export const PRE_SIGN_REVIEW_TITLE = 'Review before wallet opens';

const SEND_PRIMARY_ACTION = 'Open wallet to send';
const SWAP_PRIMARY_ACTION = 'Open wallet to swap';
const CUSTOM_PRIMARY_ACTION = 'Open wallet to sign transaction';

const SEND_SUBTITLE = 'Confirm the transfer details before your wallet opens to sign.';
const SWAP_SUBTITLE = 'Confirm the swap quote and route before your wallet opens to sign.';
const CUSTOM_SUBTITLE = 'Confirm the transaction details before your wallet opens to sign.';

export function shortAddress(value: string, head = 4, tail = 4): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  const safeHead = head > 0 ? head : 0;
  const safeTail = tail > 0 ? tail : 0;
  if (trimmed.length <= safeHead + safeTail + 1) {
    return trimmed;
  }
  return `${trimmed.slice(0, safeHead)}…${trimmed.slice(trimmed.length - safeTail)}`;
}

export function formatTouchedPrograms(programs?: TouchedProgramInput[]): PreSignReviewRow[] {
  if (!Array.isArray(programs) || programs.length === 0) return [];
  const rows: PreSignReviewRow[] = [];
  for (const program of programs) {
    if (!program || typeof program.programId !== 'string') continue;
    const programId = program.programId.trim();
    if (!programId) continue;
    const label = nonEmptyString(program.label) ? program.label!.trim() : '';
    const value = label || shortAddress(programId);
    const row: PreSignReviewRow = {
      label: 'Program',
      value,
      title: programId,
      copyValue: programId,
    };
    const tone = touchedProgramTone(program);
    if (tone) row.tone = tone;
    rows.push(row);
  }
  return rows;
}

export function buildSendPreSignReview(input: SendPreSignReviewInput): PreSignReviewModel {
  const sections: PreSignReviewSection[] = [];

  const transferRows: PreSignReviewRow[] = [];
  pushAddressRow(transferRows, 'Recipient', input.recipient);
  pushAmountAndTokenRows(transferRows, input.amount, input.token);
  pushPlainRow(transferRows, 'Fee', input.estimatedFee);
  pushPlainRow(transferRows, 'Balance', input.currentBalance);
  pushPlainRow(
    transferRows,
    'Post-send',
    input.postSendBalance,
    input.balanceIsInsufficient ? 'warn' : undefined,
  );
  pushPlainRow(transferRows, 'Memo', input.memo);
  pushSection(sections, 'Transfer', transferRows);

  const walletRows: PreSignReviewRow[] = [];
  pushAddressRow(walletRows, 'Wallet', input.sender);
  pushSection(sections, 'Wallet', walletRows);

  pushNetworkSection(sections, input.cluster);
  pushProgramsSection(sections, input.touchedPrograms);

  const warnings: string[] = [];
  if (!nonEmptyString(input.recipient)) warnings.push('Recipient is missing.');
  if (input.balanceIsInsufficient) warnings.push('Amount exceeds current balance.');
  if (!nonEmptyString(input.estimatedFee)) warnings.push('Fee estimate is missing.');
  if (input.mainnetWarning) warnings.push('This sends on mainnet-beta with real funds.');
  pushUnknownProgramWarnings(warnings, input.touchedPrograms);

  return {
    title: PRE_SIGN_REVIEW_TITLE,
    subtitle: SEND_SUBTITLE,
    riskTone: deriveRiskTone(
      warnings,
      input.touchedPrograms,
      input.balanceIsInsufficient ? 'danger' : undefined,
    ),
    primaryAction: SEND_PRIMARY_ACTION,
    sections,
    warnings,
  };
}

export function buildSwapPreSignReview(input: SwapPreSignReviewInput): PreSignReviewModel {
  const sections: PreSignReviewSection[] = [];

  const swapRows: PreSignReviewRow[] = [];
  pushAmountAndTokenRows(swapRows, input.inputAmount, input.inputToken);
  if (nonEmptyString(input.expectedOutput)) {
    pushPlainRow(swapRows, 'Expected out', combineAmountAndToken(input.expectedOutput, input.outputToken));
  }
  if (nonEmptyString(input.minimumReceived)) {
    pushPlainRow(swapRows, 'Min received', combineAmountAndToken(input.minimumReceived, input.outputToken));
  }
  pushSlippageRow(swapRows, input.slippageBps);
  pushPriceImpactRow(swapRows, input.priceImpactPct, input.priceImpactWarnPct);
  pushPlainRow(swapRows, 'Fee', input.platformFee);
  pushSection(sections, 'Swap', swapRows);

  const routeRows: PreSignReviewRow[] = [];
  pushPlainRow(routeRows, 'Route', input.routeLabel);
  pushJupiterIdRow(routeRows, input.jupiterRequestId);
  pushSection(sections, 'Route', routeRows);

  const walletRows: PreSignReviewRow[] = [];
  pushAddressRow(walletRows, 'Wallet', input.taker);
  pushSection(sections, 'Wallet', walletRows);

  pushNetworkSection(sections, input.cluster);
  pushProgramsSection(sections, input.touchedPrograms);

  const warnings: string[] = [];
  if (!nonEmptyString(input.expectedOutput)) warnings.push('Expected output is missing.');
  if (!nonEmptyString(input.routeLabel)) warnings.push('Route label is missing.');
  if (typeof input.slippageBps === 'number' && Number.isFinite(input.slippageBps) && input.slippageBps > 100) {
    warnings.push(`Slippage is high at ${formatBps(input.slippageBps)}.`);
  }
  if (
    typeof input.priceImpactPct === 'number' &&
    Number.isFinite(input.priceImpactPct) &&
    typeof input.priceImpactWarnPct === 'number' &&
    Number.isFinite(input.priceImpactWarnPct) &&
    input.priceImpactPct > input.priceImpactWarnPct
  ) {
    warnings.push(`Price impact is ${formatPercent(input.priceImpactPct)}.`);
  }
  pushUnknownProgramWarnings(warnings, input.touchedPrograms);

  return {
    title: PRE_SIGN_REVIEW_TITLE,
    subtitle: SWAP_SUBTITLE,
    riskTone: deriveRiskTone(warnings, input.touchedPrograms),
    primaryAction: SWAP_PRIMARY_ACTION,
    sections,
    warnings,
  };
}

export function buildCustomTransactionPreSignReview(
  input: CustomTransactionPreSignReviewInput,
): PreSignReviewModel {
  const sections: PreSignReviewSection[] = [];

  const txRows: PreSignReviewRow[] = [];
  pushFingerprintRow(txRows, input.transactionHash);
  pushByteLengthRow(txRows, input.transactionByteLength);
  pushIntegerRow(txRows, 'Instructions', input.instructionCount);
  pushIntegerRow(txRows, 'Writable accounts', input.writableAccountCount);
  pushSignerRow(txRows, input.signerCount);
  pushSection(sections, 'Transaction', txRows);

  const walletRows: PreSignReviewRow[] = [];
  pushAddressRow(walletRows, 'Fee payer', input.feePayer);
  pushSection(sections, 'Wallet', walletRows);

  pushNetworkSection(sections, input.cluster);
  pushProgramsSection(sections, input.touchedPrograms);

  const warnings: string[] = [];
  if (hasWritableUnknownProgram(input.touchedPrograms)) {
    warnings.push('Writable unknown program account.');
  }
  pushUnknownProgramWarnings(warnings, input.touchedPrograms);
  if (typeof input.signerCount === 'number' && Number.isFinite(input.signerCount) && input.signerCount > 1) {
    warnings.push(`Transaction has ${input.signerCount} signers.`);
  }
  if (Array.isArray(input.warnings)) {
    for (const extra of input.warnings) {
      if (nonEmptyString(extra)) warnings.push(extra.trim());
    }
  }

  return {
    title: PRE_SIGN_REVIEW_TITLE,
    subtitle: CUSTOM_SUBTITLE,
    riskTone: deriveRiskTone(warnings, input.touchedPrograms),
    primaryAction: CUSTOM_PRIMARY_ACTION,
    sections,
    warnings,
  };
}

// ─── row builders ─────────────────────────────────────────────────────────────

function pushPlainRow(
  rows: PreSignReviewRow[],
  label: string,
  value: string | undefined,
  tone?: ReviewTone,
): void {
  if (!nonEmptyString(value)) return;
  const row: PreSignReviewRow = { label, value: value!.trim() };
  if (tone) row.tone = tone;
  rows.push(row);
}

function pushAddressRow(
  rows: PreSignReviewRow[],
  label: string,
  value: string | undefined,
): void {
  if (!nonEmptyString(value)) return;
  const trimmed = value!.trim();
  rows.push({
    label,
    value: shortAddress(trimmed),
    title: trimmed,
    copyValue: trimmed,
  });
}

function pushAmountAndTokenRows(
  rows: PreSignReviewRow[],
  amount: string | undefined,
  token: string | undefined,
): void {
  const combined = combineAmountAndToken(amount, token);
  if (combined) {
    rows.push({ label: 'Amount', value: combined });
    return;
  }
  pushPlainRow(rows, 'Amount', amount);
  pushPlainRow(rows, 'Token', token);
}

function pushSlippageRow(rows: PreSignReviewRow[], slippageBps: number | undefined): void {
  const value = formatSlippage(slippageBps);
  if (!value) return;
  const tone: ReviewTone | undefined =
    typeof slippageBps === 'number' && slippageBps > 100 ? 'warn' : undefined;
  const row: PreSignReviewRow = { label: 'Slippage', value };
  if (tone) row.tone = tone;
  rows.push(row);
}

function pushPriceImpactRow(
  rows: PreSignReviewRow[],
  priceImpactPct: number | undefined,
  priceImpactWarnPct: number | undefined,
): void {
  const value = formatPriceImpact(priceImpactPct);
  if (!value) return;
  const tone: ReviewTone | undefined =
    typeof priceImpactWarnPct === 'number' &&
    Number.isFinite(priceImpactWarnPct) &&
    typeof priceImpactPct === 'number' &&
    Number.isFinite(priceImpactPct) &&
    priceImpactPct > priceImpactWarnPct
      ? 'warn'
      : undefined;
  const row: PreSignReviewRow = { label: 'Price impact', value };
  if (tone) row.tone = tone;
  rows.push(row);
}

function pushJupiterIdRow(rows: PreSignReviewRow[], jupiterRequestId: string | undefined): void {
  if (!nonEmptyString(jupiterRequestId)) return;
  const value = jupiterRequestId!.trim();
  rows.push({
    label: 'Jupiter id',
    value: shortAddress(value, 6, 6),
    title: value,
    copyValue: value,
  });
}

function pushFingerprintRow(rows: PreSignReviewRow[], transactionHash: string | undefined): void {
  if (!nonEmptyString(transactionHash)) return;
  const hash = transactionHash!.trim();
  rows.push({
    label: 'Fingerprint',
    value: shortAddress(hash, 6, 6),
    title: hash,
    copyValue: hash,
  });
}

function pushByteLengthRow(rows: PreSignReviewRow[], byteLength: number | undefined): void {
  if (typeof byteLength !== 'number' || !Number.isFinite(byteLength)) return;
  rows.push({ label: 'Size', value: `${byteLength} bytes` });
}

function pushIntegerRow(
  rows: PreSignReviewRow[],
  label: string,
  value: number | undefined,
): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) return;
  rows.push({ label, value: String(value) });
}

function pushSignerRow(rows: PreSignReviewRow[], signerCount: number | undefined): void {
  if (typeof signerCount !== 'number' || !Number.isFinite(signerCount)) return;
  const tone: ReviewTone | undefined = signerCount > 1 ? 'warn' : undefined;
  const row: PreSignReviewRow = { label: 'Signers', value: String(signerCount) };
  if (tone) row.tone = tone;
  rows.push(row);
}

function pushSection(
  sections: PreSignReviewSection[],
  title: string,
  rows: PreSignReviewRow[],
): void {
  if (rows.length === 0) return;
  sections.push({ title, rows });
}

function pushNetworkSection(sections: PreSignReviewSection[], cluster: string | undefined): void {
  if (!nonEmptyString(cluster)) return;
  sections.push({
    title: 'Network',
    rows: [{ label: 'Cluster', value: cluster!.trim() }],
  });
}

function pushProgramsSection(
  sections: PreSignReviewSection[],
  programs: TouchedProgramInput[] | undefined,
): void {
  const rows = formatTouchedPrograms(programs);
  if (rows.length === 0) return;
  sections.push({ title: 'Programs', rows });
}

function pushUnknownProgramWarnings(
  warnings: string[],
  programs: TouchedProgramInput[] | undefined,
): void {
  if (!Array.isArray(programs)) return;
  const seen = new Set<string>();
  for (const program of programs) {
    if (!program || program.source !== 'unknown') continue;
    const id = typeof program.programId === 'string' ? program.programId.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
  }
  if (seen.size === 0) return;
  warnings.push(seen.size === 1 ? 'Unknown program touched.' : `${seen.size} unknown programs touched.`);
}

function hasWritableUnknownProgram(programs: TouchedProgramInput[] | undefined): boolean {
  if (!Array.isArray(programs)) return false;
  return programs.some(
    (program) => Boolean(program) && program.source === 'unknown' && program.writable === true,
  );
}

function touchedProgramTone(program: TouchedProgramInput): ReviewTone | undefined {
  if (program.source === 'unknown') {
    return program.writable ? 'danger' : 'warn';
  }
  return undefined;
}

function deriveRiskTone(
  warnings: string[],
  programs: TouchedProgramInput[] | undefined,
  override?: ReviewTone,
): ReviewTone {
  if (override === 'danger') return 'danger';
  if (hasWritableUnknownProgram(programs)) return 'danger';
  if (override === 'warn') return 'warn';
  if (warnings.length > 0) return 'warn';
  return 'neutral';
}

function combineAmountAndToken(
  amount: string | undefined,
  token: string | undefined,
): string {
  const amountValue = nonEmptyString(amount) ? amount!.trim() : '';
  const tokenValue = nonEmptyString(token) ? token!.trim() : '';
  if (amountValue && tokenValue) return `${amountValue} ${tokenValue}`;
  if (amountValue) return amountValue;
  if (tokenValue) return tokenValue;
  return '';
}

function formatSlippage(slippageBps: number | undefined): string {
  if (typeof slippageBps !== 'number' || !Number.isFinite(slippageBps)) return '';
  const bps = formatBps(slippageBps);
  const pct = formatPercent(slippageBps / 100);
  return `${bps} (${pct})`;
}

function formatBps(slippageBps: number): string {
  return `${formatNumber(slippageBps)} bps`;
}

function formatPriceImpact(priceImpactPct: number | undefined): string {
  if (typeof priceImpactPct !== 'number' || !Number.isFinite(priceImpactPct)) return '';
  return formatPercent(priceImpactPct);
}

function formatPercent(value: number): string {
  return `${trimTrailingZeros(value.toFixed(2))}%`;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '';
  if (Number.isInteger(value)) return String(value);
  return trimTrailingZeros(value.toFixed(2));
}

function trimTrailingZeros(value: string): string {
  if (!value.includes('.')) return value;
  return value.replace(/\.?0+$/, '');
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
