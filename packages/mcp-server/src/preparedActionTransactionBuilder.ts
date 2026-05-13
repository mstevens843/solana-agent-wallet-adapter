import type { Cluster } from '@solana-agent-wallet-adapter/core';

import { AdapterError, type DAppAdapterContext } from './adapters/types.js';
import { adapterForKind } from './adapters/registry.js';
import type { PreparedAction } from './preparedActions.js';

export interface PreparedTransactionPayload {
  transactionBase64: string;
  summary: string;
  preview?: Record<string, unknown>;
  cluster: Cluster;
}

const CAPTURE_SENTINEL = '__captured__';

interface CapturedRef {
  base64?: string;
  summary?: string;
}

export function createCaptureContext(ctx: DAppAdapterContext): {
  ctx: DAppAdapterContext;
  captured: CapturedRef;
} {
  const captured: CapturedRef = {};
  const captureCtx: DAppAdapterContext = {
    ...ctx,
    signAndBroadcast: async (transactionBase64: string, summary: string) => {
      if (captured.base64 !== undefined) {
        throw new AdapterError(
          'registry',
          'multi_tx_not_supported',
          'Adapter attempted to broadcast more than one transaction; capture supports a single transaction per approval.',
        );
      }
      captured.base64 = transactionBase64;
      captured.summary = summary;
      return CAPTURE_SENTINEL;
    },
    signAndBroadcastMany: async () => {
      throw new AdapterError(
        'registry',
        'multi_tx_not_supported',
        'Adapter requires multi-transaction broadcast; capture supports a single transaction per approval.',
      );
    },
  };
  return { ctx: captureCtx, captured };
}

/**
 * Sentinel that every adapter's `prepare()` stamps into its previewParams. If an action's
 * params don't carry this field, the params were produced by the form-driven template path
 * (or an AI plan) and have NOT yet been run through `adapter.prepare()` — so the adapter's
 * `execute()` would fail looking up enriched keys like `reserveMint` / `amountRaw`.
 */
const PREPARED_SNAPSHOT_KEY = 'preparedSnapshotAt';

function actionParamsAreEnriched(action: PreparedAction): boolean {
  return typeof action.params[PREPARED_SNAPSHOT_KEY] === 'string';
}

async function enrichActionParams(
  action: PreparedAction,
  adapterAction: ReturnType<typeof adapterForKind> & {},
  ctx: DAppAdapterContext,
): Promise<PreparedAction> {
  // The adapter's prepare() accepts an opaque input; the form-keyed action.params shape
  // is compatible with every adapter we have (e.g., Kamino reads `input.token`, MarginFi reads
  // `input.bank`, etc.). Adapters tolerate unknown fields.
  const prepared = await adapterAction.prepare(action.params as never, ctx);
  return {
    ...action,
    summary: prepared.addInput.summary || action.summary,
    params: {
      ...action.params,
      ...prepared.addInput.params,
    },
  };
}

export async function prepareTransactionForApproval(
  action: PreparedAction,
  ctx: DAppAdapterContext,
): Promise<PreparedTransactionPayload> {
  const adapterAction = adapterForKind(action.kind);
  if (!adapterAction) {
    throw new AdapterError(
      'registry',
      'unknown_kind',
      `No adapter registered for kind ${action.kind}`,
    );
  }

  const enrichedAction = actionParamsAreEnriched(action)
    ? action
    : await enrichActionParams(action, adapterAction, ctx);

  const { ctx: captureCtx, captured } = createCaptureContext(ctx);
  const result = await adapterAction.execute(enrichedAction, captureCtx);

  if (captured.base64 === undefined || captured.summary === undefined) {
    throw new AdapterError(
      'registry',
      'not_executable',
      `Adapter for ${action.kind} did not produce a transaction`,
    );
  }

  return {
    transactionBase64: captured.base64,
    summary: captured.summary,
    preview: result.preview,
    cluster: ctx.config.cluster,
  };
}
