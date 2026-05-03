import { tool } from 'ai';
import { z } from 'zod';

import {
  ProtocolError,
  type Cluster,
  type SolanaSigningClient,
} from '@solana-agent-wallet-adapter/core';

const ClusterSchema = z.enum(['mainnet-beta', 'testnet', 'devnet', 'localnet']);

export interface CreateSolanaToolsOptions {
  client: SolanaSigningClient;
}

export function createSolanaTools(options: CreateSolanaToolsOptions) {
  const { client } = options;

  const solanaGetAddress = tool({
    description:
      'Return the Solana address that the connected wallet will sign with. No user approval required.',
    inputSchema: z.object({}),
    execute: async () => {
      try {
        const address = await client.getAddress();
        return { address };
      } catch (err) {
        return errorPayload(err);
      }
    },
  });

  const solanaSignMessage = tool({
    description:
      "Sign a UTF-8 message with the user's connected Solana wallet. Blocks until the user approves in their wallet. Use the optional `summary` field to give the user context during approval.",
    inputSchema: z.object({
      message: z.string().min(1).describe('UTF-8 message to sign.'),
      cluster: ClusterSchema.describe('Solana cluster the message is being signed for.'),
      summary: z
        .string()
        .optional()
        .describe('Short human-readable summary shown to the user during approval.'),
    }),
    execute: async ({ message, cluster, summary }) => {
      try {
        const result = await client.signMessage(message, signOptions(cluster, summary));
        return { signature: result.signature };
      } catch (err) {
        return errorPayload(err);
      }
    },
  });

  const solanaSignTransaction = tool({
    description:
      "Sign a base64-encoded Solana transaction without broadcasting. Blocks until the user approves in their wallet.",
    inputSchema: z.object({
      transactionBase64: z.string().min(1),
      cluster: ClusterSchema,
      summary: z.string().optional(),
    }),
    execute: async ({ transactionBase64, cluster, summary }) => {
      try {
        const result = await client.signTransaction(transactionBase64, signOptions(cluster, summary));
        return { signedTransaction: result.signature };
      } catch (err) {
        return errorPayload(err);
      }
    },
  });

  const solanaSignAndSendTransaction = tool({
    description:
      'Sign AND broadcast a Solana transaction. Blocks until the user approves. Returns the on-chain transaction id on success.',
    inputSchema: z.object({
      transactionBase64: z.string().min(1),
      cluster: ClusterSchema,
      summary: z.string().optional(),
    }),
    execute: async ({ transactionBase64, cluster, summary }) => {
      try {
        const result = await client.signAndSendTransaction(
          transactionBase64,
          signOptions(cluster, summary),
        );
        return { signature: result.signature, txid: result.txid ?? result.signature };
      } catch (err) {
        return errorPayload(err);
      }
    },
  });

  return {
    solanaGetAddress,
    solanaSignMessage,
    solanaSignTransaction,
    solanaSignAndSendTransaction,
  };
}

function signOptions(
  cluster: Cluster,
  summary: string | undefined,
): { cluster: Cluster; summary?: string } {
  if (summary !== undefined) {
    return { cluster, summary };
  }
  return { cluster };
}

function errorPayload(err: unknown): { error: { code: string; message: string; recoverable: boolean } } {
  if (err instanceof ProtocolError) {
    return { error: err.toPayload() };
  }
  return {
    error: {
      code: 'wallet_unreachable',
      message: err instanceof Error ? err.message : 'Unknown error.',
      recoverable: false,
    },
  };
}
