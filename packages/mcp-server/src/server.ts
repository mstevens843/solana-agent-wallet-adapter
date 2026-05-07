import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  newSigningRequestId,
  ProtocolError,
  type ApprovalResource,
  type Cluster,
  type SigningRequest,
  type WalletBackend,
} from '@solana-agent-wallet-adapter/core';

import { registerActionTools } from './actionTools.js';
import type { AgentWalletConfig } from './config.js';
import type { PreparedActionStore } from './preparedActions.js';
import { newTraceId, trace } from './trace.js';

export interface CreateServerOptions {
  backend: WalletBackend;
  serverName?: string;
  serverVersion?: string;
  actionConfig?: AgentWalletConfig;
  preparedActions?: PreparedActionStore;
}

const ClusterSchema = z.enum(['mainnet-beta', 'testnet', 'devnet', 'localnet']);

interface ConnectableWalletBackend extends WalletBackend {
  connectWallet(): Promise<ApprovalResource>;
}

export function createServer(options: CreateServerOptions): McpServer {
  const { backend } = options;
  const server = new McpServer({
    name: options.serverName ?? 'solana-agent-wallet-mcp',
    version: options.serverVersion ?? '0.0.1',
  });

  if (options.actionConfig) {
    registerActionTools(server, {
      backend,
      config: options.actionConfig,
      ...(options.preparedActions !== undefined && { preparedActions: options.preparedActions }),
    });
  }

  server.registerTool(
    'solana_connect_wallet',
    {
      description:
        'Request user approval to connect/authorize the configured wallet transport. For iOS link mode, returns an ApprovalResource with an approvalUri to open on the phone.',
      inputSchema: {},
    },
    async () => {
      return traceServerTool('solana_connect_wallet', {}, async () => {
        if (isConnectableBackend(backend)) {
          return approvalReply(await backend.connectWallet());
        }
        const address = await backend.getAddress();
        return jsonReply({ address });
      });
    },
  );

  server.registerTool(
    'solana_get_address',
    {
      description:
        'Returns the Solana address the connected wallet will sign with. May trigger a user approval if the wallet has not yet been authorized.',
      inputSchema: {},
    },
    async () => {
      return traceServerTool('solana_get_address', {}, async () => {
        const address = await backend.getAddress();
        return jsonReply({ address });
      });
    },
  );

  server.registerTool(
    'solana_sign_message',
    {
      description:
        'Request a user approval to sign a UTF-8 message. Returns an ApprovalResource; poll solana_check_approval until status is approved or rejected.',
      inputSchema: {
        message: z.string().min(1),
        cluster: ClusterSchema,
        summary: z.string().optional(),
      },
    },
    async ({ message, cluster, summary }) => {
      return traceServerTool('solana_sign_message', { cluster, summary }, async () =>
        submitOrError(backend, buildRequest('sign_message', message, 'utf8', cluster, summary)),
      );
    },
  );

  server.registerTool(
    'solana_sign_transaction',
    {
      description:
        'Request a user approval to sign a base64-encoded Solana transaction without broadcasting. Returns an ApprovalResource.',
      inputSchema: {
        transactionBase64: z.string().min(1),
        cluster: ClusterSchema,
        summary: z.string().optional(),
      },
    },
    async ({ transactionBase64, cluster, summary }) => {
      return traceServerTool('solana_sign_transaction', { cluster, summary }, async () => {
        const blocked = rejectArbitraryMainnetTransaction(options.actionConfig, cluster);
        if (blocked) return blocked;
        return submitOrError(
          backend,
          buildRequest('sign_transaction', transactionBase64, 'base64', cluster, summary),
        );
      });
    },
  );

  server.registerTool(
    'solana_sign_and_send_transaction',
    {
      description:
        'Request a user approval to sign AND broadcast a transaction. Returns an ApprovalResource that resolves with a tx signature on success.',
      inputSchema: {
        transactionBase64: z.string().min(1),
        cluster: ClusterSchema,
        summary: z.string().optional(),
      },
    },
    async ({ transactionBase64, cluster, summary }) => {
      return traceServerTool('solana_sign_and_send_transaction', { cluster, summary }, async () => {
        const blocked = rejectArbitraryMainnetTransaction(options.actionConfig, cluster);
        if (blocked) return blocked;
        return submitOrError(
          backend,
          buildRequest('sign_and_send_transaction', transactionBase64, 'base64', cluster, summary),
        );
      });
    },
  );

  server.registerTool(
    'solana_simulate_transaction',
    {
      description:
        'Preflight-simulate a base64-encoded Solana transaction without requesting a wallet signature.',
      inputSchema: {
        transactionBase64: z.string().min(1),
        cluster: ClusterSchema,
        summary: z.string().optional(),
      },
    },
    async ({ transactionBase64, cluster, summary }) => {
      return traceServerTool('solana_simulate_transaction', { cluster, summary }, async () => {
        if (!backend.simulate) {
          return errorReply(
            new ProtocolError(
              'unsupported_method',
              'The configured wallet backend does not support transaction simulation.',
            ),
          );
        }
        const result = await backend.simulate(
          buildRequest('sign_transaction', transactionBase64, 'base64', cluster, summary),
        );
        return jsonReply({ simulation: result });
      });
    },
  );

  server.registerTool(
    'solana_check_approval',
    {
      description:
        'Poll an in-flight ApprovalResource by id. Returns the current status; once status is approved or rejected, the result/error is populated.',
      inputSchema: {
        requestId: z.string().min(1),
      },
    },
    async ({ requestId }) => {
      return traceServerTool('solana_check_approval', { requestId }, async () => {
        const approval = await backend.poll(requestId);
        return approvalReply(approval);
      });
    },
  );

  return server;
}

function isConnectableBackend(backend: WalletBackend): backend is ConnectableWalletBackend {
  return typeof (backend as Partial<ConnectableWalletBackend>).connectWallet === 'function';
}

async function traceServerTool<T>(tool: string, payload: Record<string, unknown>, run: () => Promise<T> | T) {
  const traceId = newTraceId('tool');
  trace('mcp.tool.start', { traceId, tool, ...payload });
  try {
    const result = await run();
    trace('mcp.tool.success', { traceId, tool });
    return result;
  } catch (err) {
    trace('mcp.tool.error', {
      traceId,
      tool,
      message: err instanceof Error ? err.message : String(err),
    });
    return errorReply(err);
  }
}

function rejectArbitraryMainnetTransaction(
  config: AgentWalletConfig | undefined,
  cluster: Cluster,
): ReturnType<typeof errorReply> | null {
  if (
    config &&
    cluster === 'mainnet-beta' &&
    !config.mainnet.allowArbitraryTransactions
  ) {
    return errorReply(
      new ProtocolError(
        'unauthorized',
        'Arbitrary mainnet transaction signing is disabled. Use solana_transfer_sol, solana_transfer_spl, or solana_swap so caps and summaries are enforced.',
      ),
    );
  }
  return null;
}

async function submitOrError(backend: WalletBackend, request: SigningRequest) {
  try {
    const approval = await backend.submit(request);
    return approvalReply(approval);
  } catch (err) {
    return errorReply(err);
  }
}

function buildRequest(
  kind: SigningRequest['kind'],
  data: string,
  encoding: SigningRequest['payload']['encoding'],
  cluster: Cluster,
  summary?: string,
): SigningRequest {
  const request: SigningRequest = {
    id: newSigningRequestId(),
    kind,
    payload: { data, encoding },
    cluster,
  };
  if (summary !== undefined) {
    request.display = { summary };
  }
  return request;
}

function jsonReply(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: stringify(payload) }],
  };
}

function approvalReply(approval: ApprovalResource) {
  return {
    content: [{ type: 'text' as const, text: renderApproval(approval) }],
    isError:
      approval.status === 'rejected' ||
      approval.status === 'failed' ||
      approval.status === 'expired',
  };
}

function errorReply(err: unknown) {
  const protocolErr =
    err instanceof ProtocolError
      ? err
      : new ProtocolError(
          'wallet_unreachable',
          err instanceof Error ? err.message : 'Unknown backend error',
        );
  return {
    content: [{ type: 'text' as const, text: renderError(protocolErr) }],
    isError: true,
  };
}

function renderApproval(approval: ApprovalResource): string {
  const header = approvalHeader(approval);
  const body = approvalBody(approval);
  return `${header}\n\n${body}\n\nMachine-readable JSON:\n${stringify(approval)}`;
}

function approvalHeader(approval: ApprovalResource): string {
  switch (approval.status) {
    case 'pending':
      return `Solana wallet approval pending. Request id: ${approval.requestId}`;
    case 'approved':
      return `Solana wallet approval granted. Request id: ${approval.requestId}`;
    case 'rejected':
      return `Solana wallet approval rejected. Request id: ${approval.requestId}`;
    case 'expired':
      return `Solana wallet approval expired. Request id: ${approval.requestId}`;
    case 'failed':
      return `Solana wallet approval failed. Request id: ${approval.requestId}`;
  }
}

function approvalBody(approval: ApprovalResource): string {
  switch (approval.status) {
    case 'pending': {
      const next = approval.approvalUri
        ? `Open this URL in your wallet to approve, then call solana_check_approval with requestId="${approval.requestId}":\n${approval.approvalUri}`
        : `Open the connected wallet's approval popup, then call solana_check_approval with requestId="${approval.requestId}".`;
      return next;
    }
    case 'approved': {
      const sig = approval.result?.signature ?? '(no signature returned)';
      const tx = approval.result?.txid ? `\nTransaction id: ${approval.result.txid}` : '';
      return `Signature: ${sig}${tx}`;
    }
    case 'rejected':
    case 'expired':
    case 'failed': {
      const detail = approval.error
        ? `${approval.error.message} (code: ${approval.error.code}, recoverable: ${approval.error.recoverable})`
        : '(no error detail provided)';
      return detail;
    }
  }
}

function renderError(err: ProtocolError): string {
  const payload = err.toPayload();
  return `Solana wallet adapter error.\n\nCode: ${payload.code}\nRecoverable: ${payload.recoverable}\nMessage: ${payload.message}\n\nMachine-readable JSON:\n${stringify(payload)}`;
}

function stringify(payload: unknown): string {
  return JSON.stringify(payload, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}
