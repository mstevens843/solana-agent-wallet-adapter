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

export interface CreateServerOptions {
  backend: WalletBackend;
  serverName?: string;
  serverVersion?: string;
}

const ClusterSchema = z.enum(['mainnet-beta', 'testnet', 'devnet', 'localnet']);

export function createServer(options: CreateServerOptions): McpServer {
  const { backend } = options;
  const server = new McpServer({
    name: options.serverName ?? 'solana-agent-wallet-mcp',
    version: options.serverVersion ?? '0.0.1',
  });

  server.registerTool(
    'solana_get_address',
    {
      description:
        'Returns the Solana address the connected wallet will sign with. May trigger a user approval if the wallet has not yet been authorized.',
      inputSchema: {},
    },
    async () => {
      try {
        const address = await backend.getAddress();
        return jsonReply({ address });
      } catch (err) {
        return errorReply(err);
      }
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
      return submitOrError(backend, buildRequest('sign_message', message, 'utf8', cluster, summary));
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
      return submitOrError(
        backend,
        buildRequest('sign_transaction', transactionBase64, 'base64', cluster, summary),
      );
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
      return submitOrError(
        backend,
        buildRequest('sign_and_send_transaction', transactionBase64, 'base64', cluster, summary),
      );
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
      try {
        const approval = await backend.poll(requestId);
        return approvalReply(approval);
      } catch (err) {
        return errorReply(err);
      }
    },
  );

  return server;
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
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
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
  return `${header}\n\n${body}\n\nMachine-readable JSON:\n${JSON.stringify(approval)}`;
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
  return `Solana wallet adapter error.\n\nCode: ${payload.code}\nRecoverable: ${payload.recoverable}\nMessage: ${payload.message}\n\nMachine-readable JSON:\n${JSON.stringify(payload)}`;
}
