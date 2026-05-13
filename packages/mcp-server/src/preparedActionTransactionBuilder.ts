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

  const { ctx: captureCtx, captured } = createCaptureContext(ctx);
  const result = await adapterAction.execute(action, captureCtx);

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
