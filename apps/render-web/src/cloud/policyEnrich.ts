/**
 * /api/policy/enrich
 *
 * Runs the same atom-extraction + capability-resolver pipeline that
 * `BridgeAiPlanner.review()` calls internally, but **without invoking any LLM**.
 * Returns a compact `PolicyEvaluationBundle` the caller can splice into
 * `context.policyBundle` before they call their own LLM (BYOK device-agent path).
 *
 * Why this exists: on the hosted-AI path the cloud calls the LLM with the server's
 * own API key, so `aiPlanner.enrichRequestWithPolicyBundle` runs there and the
 * model gets a pre-resolved bundle. On the BYOK path (Android/iOS device-agent
 * with the user's own Anthropic/OpenAI/Gemini key), the LLM call happens on-device
 * and bypasses the cloud entirely — without this endpoint the BYOK LLM would
 * receive raw user prose and try to resolve facts from its training data instead
 * of from authoritative providers. This endpoint closes that gap.
 *
 * Contract:
 *   Request body (JSON):
 *     {
 *       instruction?: string,             // user request (primary atom source)
 *       userNotes?: string,               // additional plan notes
 *       intent?: string,                  // plan.intent
 *       knownTokenSymbols?: string[],     // symbols to disambiguate price atoms
 *       walletAddress?: string,           // for balance/age/recipient atoms
 *       draftParameters?: object,         // for token/amount-driven atoms
 *       transactionBase64?: string,       // triggers tx-gate analyzers via simulation
 *       simulationDigest?: object,        // pre-built simulation digest (skip server sim)
 *       txGateContext?: object,           // override allowedPrograms / swapProgramIds
 *       actionType?: string,              // 'swap' | 'transfer' | ... for default tx-gate ctx
 *     }
 *   Response (JSON):
 *     { policyBundle: <compacted bundle>, ok: true }
 *   Or, on hard error:
 *     { ok: false, error: string }
 *
 * Errors are swallowed when possible: any single-atom failure is recorded in the
 * bundle as `unresolved: true`. Only fundamental failures (invalid JSON, runtime
 * exception in the pipeline itself) return ok:false.
 */

import {
  Connection,
} from '@solana/web3.js';
import {
  VERIFIED_PROGRAM_IDS,
} from '@solana-agent-wallet-adapter/workflow';
import {
  createMcpCapabilityResolver,
  DEFAULT_CONFIG,
  makeTransactionSimulator,
  runPolicyPipeline,
  type PolicyEvaluationBundle,
  type SimulationDigest,
  type TxGateContext,
} from '@solana-agent-wallet-adapter/mcp-server';

const JUPITER_AGGREGATOR_PROGRAM_IDS: ReadonlySet<string> = new Set([
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',
]);

interface PolicyEnrichRequest {
  instruction?: string;
  userNotes?: string;
  intent?: string;
  knownTokenSymbols?: string[];
  walletAddress?: string;
  draftParameters?: Record<string, string>;
  transactionBase64?: string;
  simulationDigest?: SimulationDigest;
  txGateContext?: TxGateContext;
  actionType?: string;
}

interface PolicyEnrichResult {
  ok: true;
  policyBundle: Record<string, unknown>;
}

interface PolicyEnrichFailure {
  ok: false;
  error: string;
}

export async function handlePolicyEnrich(
  rawBody: unknown,
): Promise<PolicyEnrichResult | PolicyEnrichFailure> {
  const body = isObject(rawBody) ? (rawBody as PolicyEnrichRequest) : ({} as PolicyEnrichRequest);
  try {
    if (process.env.AGENT_WALLET_POLICY_ORCHESTRATOR === '0') {
      return { ok: true, policyBundle: emptyBundle() };
    }
    const text = [body.instruction ?? '', body.userNotes ?? '', body.intent ?? '']
      .filter(Boolean)
      .join('\n');
    if (!text.trim()) {
      // No text to extract atoms from — return an empty-but-shaped bundle so
      // the caller can splice it without conditional checks.
      return {
        ok: true,
        policyBundle: {
          ...emptyBundle(),
        },
      };
    }
    const knownSymbols = Array.isArray(body.knownTokenSymbols)
      ? body.knownTokenSymbols.filter((s): s is string => typeof s === 'string' && s.length > 0)
      : [];

    let simulation = body.simulationDigest;
    if (!simulation && body.transactionBase64) {
      simulation = await simulateTransactionBase64(body.transactionBase64).catch(() => undefined);
    }

    // Tx gate context: prefer caller-supplied; otherwise build from actionType.
    const txGateContext = body.txGateContext
      ?? (simulation || body.transactionBase64 ? defaultTxGateContext(body.actionType) : undefined);

    // Resolver: no Connection wired here (cloud route doesn't own one); resolvers
    // that need RPC (wallet_balance, network_metric, etc.) will surface as
    // unresolved. Jupiter/CoinGecko/BirdEye/Helius/AlternativeMe/web all work fine.
    const resolver = createMcpCapabilityResolver({
      config: DEFAULT_CONFIG,
      requestContext: {
        ...(body.walletAddress ? { walletAddress: body.walletAddress } : {}),
        ...(body.draftParameters ? { draftParameters: body.draftParameters } : {}),
        ...(simulation ? { simulationDigest: simulation } : {}),
        ...(body.transactionBase64 ? { transactionBase64: body.transactionBase64 } : {}),
      },
    });

    const bundle: PolicyEvaluationBundle = await runPolicyPipeline({
      text,
      knownTokenSymbols: knownSymbols,
      resolver,
      simulation,
      txGateContext,
    });

    return { ok: true, policyBundle: compactBundle(bundle) };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

let cachedSimulatorRpcUrl: string | undefined;
let cachedSimulator: ReturnType<typeof makeTransactionSimulator> | undefined;

function emptyBundle(): Record<string, unknown> {
  return {
    atoms: [],
    evaluations: [],
    hasBlockingFailure: false,
    finishedAt: new Date().toISOString(),
  };
}

function simulatorForDefaultConfig(): ReturnType<typeof makeTransactionSimulator> {
  if (!cachedSimulator || cachedSimulatorRpcUrl !== DEFAULT_CONFIG.rpcUrl) {
    cachedSimulatorRpcUrl = DEFAULT_CONFIG.rpcUrl;
    cachedSimulator = makeTransactionSimulator(new Connection(DEFAULT_CONFIG.rpcUrl, 'confirmed'));
  }
  return cachedSimulator;
}

async function simulateTransactionBase64(transactionBase64: string): Promise<SimulationDigest | undefined> {
  const simulator = simulatorForDefaultConfig();
  return simulator(transactionBase64);
}

function compactBundle(bundle: PolicyEvaluationBundle): Record<string, unknown> {
  return {
    atoms: bundle.atoms.map((atom) => ({
      id: atom.id,
      type: atom.type,
      rawText: atom.rawText,
    })),
    evaluations: bundle.evaluations.map((evaluation) => ({
      atomId: evaluation.atomId,
      pass: evaluation.pass,
      ...(evaluation.unresolved ? { unresolved: true } : {}),
      finding: evaluation.finding,
    })),
    ...(Object.keys(bundle.txGateOutcomes).length > 0 ? { txGateOutcomes: bundle.txGateOutcomes } : {}),
    hasBlockingFailure: bundle.hasBlockingFailure,
    finishedAt: bundle.finishedAt,
  };
}

function defaultTxGateContext(actionType: string | undefined): TxGateContext {
  const isSwap = actionType === 'swap';
  return {
    allowedPrograms: VERIFIED_PROGRAM_IDS,
    swapProgramIds: isSwap ? JUPITER_AGGREGATOR_PROGRAM_IDS : undefined,
    isSwap,
    expectedSolTransfers: isSwap ? 2 : undefined,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
