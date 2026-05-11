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
  badge?: string;
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
  recipientBadge?: string;
  recipientTone?: ReviewTone;
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
  quoteRequired?: boolean;
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

export interface KaminoDepositPreSignReviewInput {
  cluster: string;
  wallet?: string;
  reserveSymbol?: string;
  reserveMint?: string;
  amount?: string;
  supplyApy?: number;
  utilization?: number;
  withdrawalDelaySec?: number;
  depositLimitRemaining?: string;
  withdrawAvailable?: string;
  mainnetWarning?: boolean;
  /** When false, the adapter was disabled mid-flow — render a hard-block warning. */
  adapterEnabled?: boolean;
  touchedPrograms?: TouchedProgramInput[];
}

export interface KaminoWithdrawPreSignReviewInput {
  cluster: string;
  wallet?: string;
  reserveSymbol?: string;
  reserveMint?: string;
  amount?: string;
  withdrawAll?: boolean;
  suppliedBefore?: string;
  earnedInterest?: string;
  supplyApy?: number;
  utilization?: number;
  withdrawalDelaySec?: number;
  withdrawAvailable?: string;
  mainnetWarning?: boolean;
  adapterEnabled?: boolean;
  touchedPrograms?: TouchedProgramInput[];
}

export interface KaminoEarningsProofPreSignReviewInput {
  cluster: string;
  wallet?: string;
  reserveSymbol?: string;
  suppliedAmount?: string;
  currentValue?: string;
  earnedInterest?: string;
  supplyApy?: number;
  asOfBlockTime?: number;
  asOfIso?: string;
  payloadByteLength?: number;
}

export const PRE_SIGN_REVIEW_TITLE = 'Review before wallet opens';

const SEND_PRIMARY_ACTION = 'Open wallet to send';
const SWAP_PRIMARY_ACTION = 'Open wallet to swap';
const CUSTOM_PRIMARY_ACTION = 'Open wallet to sign transaction';
const KAMINO_DEPOSIT_PRIMARY_ACTION = 'Open wallet to deposit';
const KAMINO_WITHDRAW_PRIMARY_ACTION = 'Open wallet to withdraw';
const KAMINO_EARNINGS_PROOF_PRIMARY_ACTION = 'Open wallet to sign proof';

const SEND_SUBTITLE = 'Confirm the transfer details before your wallet opens to sign.';
const SWAP_SUBTITLE = 'Confirm the swap quote before your wallet opens to sign.';
const CUSTOM_SUBTITLE = 'Confirm the transaction details before your wallet opens to sign.';
const KAMINO_DEPOSIT_SUBTITLE = 'Confirm the Kamino deposit details before your wallet opens to sign.';
const KAMINO_WITHDRAW_SUBTITLE = 'Confirm the Kamino withdrawal details before your wallet opens to sign.';
const KAMINO_EARNINGS_PROOF_SUBTITLE = 'Sign a verifiable receipt of your Kamino supply and earnings.';

const KAMINO_HIGH_UTILIZATION_PCT = 90;

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
  pushAddressRow(transferRows, 'Recipient', input.recipient, {
    badge: input.recipientBadge,
    tone: input.recipientTone,
  });
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

  pushProgramsSection(sections, input.touchedPrograms);

  const warnings: string[] = [];
  const quoteRequired = input.quoteRequired !== false;
  if (quoteRequired && !nonEmptyString(input.expectedOutput)) warnings.push('Expected output is missing.');
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

export function buildKaminoDepositPreSignReview(
  input: KaminoDepositPreSignReviewInput,
): PreSignReviewModel {
  const sections: PreSignReviewSection[] = [];
  const reserve = nonEmptyString(input.reserveSymbol) ? input.reserveSymbol!.trim() : '';

  const depositRows: PreSignReviewRow[] = [];
  if (reserve) pushPlainRow(depositRows, 'Pool', `${reserve} reserve · Kamino`);
  pushAmountAndTokenRows(depositRows, input.amount, reserve || input.reserveSymbol);
  pushApyRow(depositRows, 'Est. APY', input.supplyApy);
  pushSection(sections, 'Deposit', depositRows);

  const healthRows: PreSignReviewRow[] = [];
  pushPercentRow(healthRows, 'Utilization', input.utilization, KAMINO_HIGH_UTILIZATION_PCT);
  pushDelayRow(healthRows, 'Withdraw delay', input.withdrawalDelaySec);
  if (nonEmptyString(input.withdrawAvailable)) {
    pushPlainRow(healthRows, 'Withdraw available', combineAmountAndToken(input.withdrawAvailable, reserve));
  }
  if (nonEmptyString(input.depositLimitRemaining)) {
    pushPlainRow(healthRows, 'Cap remaining', combineAmountAndToken(input.depositLimitRemaining, reserve));
  }
  pushSection(sections, 'Pool health', healthRows);

  const walletRows: PreSignReviewRow[] = [];
  pushAddressRow(walletRows, 'Wallet', input.wallet);
  pushSection(sections, 'Wallet', walletRows);

  pushNetworkSection(sections, input.cluster);
  pushProgramsSection(sections, input.touchedPrograms);

  const warnings: string[] = [];
  if (!reserve) warnings.push('Reserve is missing.');
  if (!nonEmptyString(input.amount)) warnings.push('Deposit amount is missing.');
  if (input.adapterEnabled === false) {
    warnings.push('Kamino is not connected in Connected dApps. Reconnect before approving.');
  }
  if (typeof input.utilization === 'number' && Number.isFinite(input.utilization) && input.utilization > KAMINO_HIGH_UTILIZATION_PCT) {
    warnings.push('Withdrawals may be delayed when utilization is high.');
  }
  if (input.mainnetWarning) warnings.push('This deposits on mainnet-beta with real funds.');
  pushUnknownProgramWarnings(warnings, input.touchedPrograms);

  return {
    title: PRE_SIGN_REVIEW_TITLE,
    subtitle: KAMINO_DEPOSIT_SUBTITLE,
    riskTone: deriveRiskTone(
      warnings,
      input.touchedPrograms,
      input.adapterEnabled === false ? 'danger' : undefined,
    ),
    primaryAction: KAMINO_DEPOSIT_PRIMARY_ACTION,
    sections,
    warnings,
  };
}

export function buildKaminoWithdrawPreSignReview(
  input: KaminoWithdrawPreSignReviewInput,
): PreSignReviewModel {
  const sections: PreSignReviewSection[] = [];
  const reserve = nonEmptyString(input.reserveSymbol) ? input.reserveSymbol!.trim() : '';

  const withdrawRows: PreSignReviewRow[] = [];
  if (reserve) pushPlainRow(withdrawRows, 'Pool', `${reserve} reserve · Kamino`);
  if (input.withdrawAll) {
    pushPlainRow(withdrawRows, 'Amount', combineAmountAndToken(input.amount, reserve) || 'Full position');
  } else {
    pushAmountAndTokenRows(withdrawRows, input.amount, reserve || input.reserveSymbol);
  }
  pushPlainRow(withdrawRows, 'Supplied before', combineAmountAndToken(input.suppliedBefore, reserve));
  pushPlainRow(withdrawRows, 'Earned', combineAmountAndToken(input.earnedInterest, reserve));
  pushSection(sections, 'Withdraw', withdrawRows);

  const healthRows: PreSignReviewRow[] = [];
  pushPercentRow(healthRows, 'Utilization', input.utilization, KAMINO_HIGH_UTILIZATION_PCT);
  pushDelayRow(healthRows, 'Withdraw delay', input.withdrawalDelaySec);
  if (nonEmptyString(input.withdrawAvailable)) {
    pushPlainRow(healthRows, 'Withdraw available', combineAmountAndToken(input.withdrawAvailable, reserve));
  }
  pushApyRow(healthRows, 'Est. APY now', input.supplyApy);
  pushSection(sections, 'Pool health', healthRows);

  const walletRows: PreSignReviewRow[] = [];
  pushAddressRow(walletRows, 'Wallet', input.wallet);
  pushSection(sections, 'Wallet', walletRows);

  pushNetworkSection(sections, input.cluster);
  pushProgramsSection(sections, input.touchedPrograms);

  const warnings: string[] = [];
  if (!reserve) warnings.push('Reserve is missing.');
  if (!input.withdrawAll && !nonEmptyString(input.amount)) {
    warnings.push('Withdraw amount is missing.');
  }
  if (input.adapterEnabled === false) {
    warnings.push('Kamino is not connected in Connected dApps. Reconnect before approving.');
  }
  if (typeof input.utilization === 'number' && Number.isFinite(input.utilization) && input.utilization > KAMINO_HIGH_UTILIZATION_PCT) {
    warnings.push('Withdrawals may be delayed when utilization is high.');
  }
  if (input.mainnetWarning) warnings.push('This withdraws on mainnet-beta with real funds.');
  pushUnknownProgramWarnings(warnings, input.touchedPrograms);

  return {
    title: PRE_SIGN_REVIEW_TITLE,
    subtitle: KAMINO_WITHDRAW_SUBTITLE,
    riskTone: deriveRiskTone(
      warnings,
      input.touchedPrograms,
      input.adapterEnabled === false ? 'danger' : undefined,
    ),
    primaryAction: KAMINO_WITHDRAW_PRIMARY_ACTION,
    sections,
    warnings,
  };
}

export function buildKaminoEarningsProofPreSignReview(
  input: KaminoEarningsProofPreSignReviewInput,
): PreSignReviewModel {
  const sections: PreSignReviewSection[] = [];
  const reserve = nonEmptyString(input.reserveSymbol) ? input.reserveSymbol!.trim() : '';

  const proofRows: PreSignReviewRow[] = [];
  pushPlainRow(proofRows, 'Pool', reserve ? `${reserve} reserve · Kamino` : 'All Kamino reserves');
  pushPlainRow(proofRows, 'Supplied', combineAmountAndToken(input.suppliedAmount, reserve));
  pushPlainRow(proofRows, 'Current value', combineAmountAndToken(input.currentValue, reserve));
  pushPlainRow(proofRows, 'Earned', combineAmountAndToken(input.earnedInterest, reserve));
  pushApyRow(proofRows, 'Est. APY', input.supplyApy);
  pushSection(sections, 'Earnings', proofRows);

  const proofMetaRows: PreSignReviewRow[] = [];
  pushPlainRow(proofMetaRows, 'As of', input.asOfIso);
  if (typeof input.payloadByteLength === 'number' && Number.isFinite(input.payloadByteLength)) {
    pushPlainRow(proofMetaRows, 'Payload', `${input.payloadByteLength} bytes`);
  }
  pushPlainRow(proofMetaRows, 'Schema', 'kamino-earnings-v1');
  pushSection(sections, 'Proof', proofMetaRows);

  const walletRows: PreSignReviewRow[] = [];
  pushAddressRow(walletRows, 'Wallet', input.wallet);
  pushSection(sections, 'Wallet', walletRows);

  pushNetworkSection(sections, input.cluster);

  const warnings: string[] = [];
  if (!nonEmptyString(input.suppliedAmount) && !nonEmptyString(input.currentValue) && !nonEmptyString(input.earnedInterest)) {
    warnings.push('No supplied positions found for this wallet.');
  }

  return {
    title: PRE_SIGN_REVIEW_TITLE,
    subtitle: KAMINO_EARNINGS_PROOF_SUBTITLE,
    riskTone: warnings.length > 0 ? 'warn' : 'neutral',
    primaryAction: KAMINO_EARNINGS_PROOF_PRIMARY_ACTION,
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

interface PushAddressRowOptions {
  badge?: string;
  tone?: ReviewTone;
}

function pushAddressRow(
  rows: PreSignReviewRow[],
  label: string,
  value: string | undefined,
  options?: PushAddressRowOptions,
): void {
  if (!nonEmptyString(value)) return;
  const trimmed = value!.trim();
  const row: PreSignReviewRow = {
    label,
    value: shortAddress(trimmed),
    title: trimmed,
    copyValue: trimmed,
  };
  if (options?.badge && options.badge.trim()) row.badge = options.badge.trim();
  if (options?.tone) row.tone = options.tone;
  rows.push(row);
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

function pushApyRow(
  rows: PreSignReviewRow[],
  label: string,
  apyPct: number | undefined,
): void {
  if (typeof apyPct !== 'number' || !Number.isFinite(apyPct)) return;
  rows.push({ label, value: formatApy(apyPct) });
}

function pushPercentRow(
  rows: PreSignReviewRow[],
  label: string,
  pct: number | undefined,
  warnAbovePct?: number,
): void {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return;
  const row: PreSignReviewRow = { label, value: formatPercent(pct) };
  if (typeof warnAbovePct === 'number' && pct > warnAbovePct) row.tone = 'warn';
  rows.push(row);
}

function pushDelayRow(
  rows: PreSignReviewRow[],
  label: string,
  delaySec: number | undefined,
): void {
  if (typeof delaySec !== 'number' || !Number.isFinite(delaySec) || delaySec < 0) return;
  rows.push({ label, value: formatDuration(delaySec) });
}

function formatApy(apyPct: number): string {
  if (!Number.isFinite(apyPct)) return '';
  if (apyPct >= 1) return `${trimTrailingZeros(apyPct.toFixed(2))}%`;
  // tiny APYs render with more precision so 0.04% doesn't collapse to "0%"
  return `${trimTrailingZeros(apyPct.toFixed(3))}%`;
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return 'Instant';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const minutes = Math.round(seconds / 60);
    return `${minutes} min${minutes === 1 ? '' : 's'}`;
  }
  if (seconds < 86_400) {
    const hours = Math.round(seconds / 3600);
    return `${hours} hr${hours === 1 ? '' : 's'}`;
  }
  const days = Math.round(seconds / 86_400);
  return `${days} day${days === 1 ? '' : 's'}`;
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
