import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  ProtocolError,
  type ProtocolErrorPayload,
  type WalletBackend,
} from '@solana-agent-wallet-adapter/core';

import {
  AgentWalletActionService,
  type RecurringPaymentInput,
} from './actionService.js';
import type { AgentWalletConfig } from './config.js';
import {
  JsonPreparedActionStore,
  defaultPreparedActionStorePath,
  type PreparedActionStore,
} from './preparedActions.js';
import { newTraceId, trace } from './trace.js';

export interface RegisterActionToolsOptions {
  backend: WalletBackend;
  config: AgentWalletConfig;
  preparedActions?: PreparedActionStore;
}

export function registerActionTools(
  server: McpServer,
  options: RegisterActionToolsOptions,
): void {
  const preparedActions =
    options.preparedActions ?? new JsonPreparedActionStore(defaultPreparedActionStorePath());
  const service = new AgentWalletActionService({
    backend: options.backend,
    config: options.config,
    preparedActions,
  });

  server.registerTool(
    'solana_useful_prompts',
    {
      description:
        'Return stable example prompts that show useful Solana wallet agent workflows and which ones are supported today.',
      inputSchema: {},
    },
    async () => traceTool('solana_useful_prompts', {}, async () => jsonReply(usefulPrompts(options.config))),
  );

  server.registerTool(
    'solana_wallet_status',
    {
      description:
        'Return the connected browser wallet status, configured cluster, RPC URL, and safety caps.',
      inputSchema: {},
    },
    async () => traceTool('solana_wallet_status', { cluster: options.config.cluster }, async () =>
      jsonReply(await service.walletStatus()),
    ),
  );

  server.registerTool(
    'solana_connector_capabilities',
    {
      description:
        'List MCP protocol connector capabilities, read tools, action tools, limitations, and wallet approval boundaries. Answers what Kamino, Jupiter, Meteora, Raydium, Orca, MarginFi, Drift, Lulo, and Save can do in this runtime.',
      inputSchema: {
        connectorId: z.string().min(2).optional().describe('Optional connector id or alias, for example kamino, jupiter, or meteora.'),
      },
    },
    async ({ connectorId }) => traceTool(
      'solana_connector_capabilities',
      { cluster: options.config.cluster, connectorId },
      async () => jsonReply(optionsConnectorCapabilities(service, connectorId)),
    ),
  );

  server.registerTool(
    'solana_connector_read_facts',
    {
      description:
        'Read normalized protocol connector facts as stable JSON. Supports Kamino positions/rewards/markets and Jupiter swap previews today. Unsupported connectors return structured missing-capability errors.',
      inputSchema: {
        connectorId: z.string().min(2).describe('Connector id or alias, for example kamino or jupiter.'),
        capability: connectorCapabilitySchema().optional(),
        walletAddress: z.string().min(32).optional(),
        token: z.string().min(2).optional(),
        reserveMint: z.string().min(32).optional(),
        inputToken: z.string().min(2).optional(),
        outputToken: z.string().min(2).optional(),
        amount: z.string().min(1).optional(),
        slippageBps: z.number().int().min(1).optional(),
        taker: z.string().min(32).optional(),
      },
    },
    async (input) => traceTool(
      'solana_connector_read_facts',
      { cluster: options.config.cluster, connectorId: input.connectorId, capability: input.capability },
      async () => jsonReply(await service.connectorReadFacts(input)),
    ),
  );

  server.registerTool(
    'solana_get_balances',
    {
      description: 'Read SOL and configured SPL token balances for the connected wallet.',
      inputSchema: {},
    },
    async () => traceTool('solana_get_balances', { cluster: options.config.cluster }, async () =>
      jsonReply(await service.balances()),
    ),
  );

  server.registerTool(
    'solana_portfolio_summary',
    {
      description:
        'Read wallet portfolio context before preparing transfers, swaps, cleanup actions, or rebalancing plans.',
      inputSchema: {},
    },
    async () => traceTool('solana_portfolio_summary', { cluster: options.config.cluster }, async () =>
      jsonReply(await service.portfolioSummary()),
    ),
  );

  server.registerTool(
    'solana_prepare_transfer_sol',
    {
      description:
        'Create a durable manual-approval inbox item for a capped SOL transfer. Does not open the wallet or sign.',
      inputSchema: {
        recipient: z.string().min(32),
        amountSol: z.string().min(1),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ recipient, amountSol, dueAt, note }) => traceTool(
      'solana_prepare_transfer_sol',
      { cluster: options.config.cluster, recipient, amountSol, dueAt },
      async () => jsonReply(await service.prepareTransferSol({
        recipient,
        amountSol,
        ...(dueAt !== undefined && { dueAt }),
        ...(note !== undefined && { note }),
      })),
    ),
  );

  server.registerTool(
    'solana_prepare_transfer_spl',
    {
      description:
        'Create a durable manual-approval inbox item for a capped allowlisted SPL token transfer. Does not open the wallet or sign.',
      inputSchema: {
        token: z.string().min(2),
        recipient: z.string().min(32),
        amount: z.string().min(1),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ token, recipient, amount, dueAt, note }) => traceTool(
      'solana_prepare_transfer_spl',
      { cluster: options.config.cluster, token, recipient, amount, dueAt },
      async () => jsonReply(await service.prepareTransferSpl({
        token,
        recipient,
        amount,
        ...(dueAt !== undefined && { dueAt }),
        ...(note !== undefined && { note }),
      })),
    ),
  );

  server.registerTool(
    'solana_prepare_swap',
    {
      description:
        'Create a durable manual-approval inbox item for a capped Jupiter swap. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Quote and transaction are refreshed at approval time.',
      inputSchema: {
        ...swapInputSchema(),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async (input) => traceTool(
      'solana_prepare_swap',
      { cluster: options.config.cluster, input },
      async () => jsonReply(await service.prepareSwap(input)),
    ),
  );

  server.registerTool(
    'solana_prepare_blink_action',
    {
      description:
        'Create a durable manual-approval inbox item for a Solana Action/Blink URL. The agent supplies the action URL and expected facts. Prepares wallet approval work only; it does not sign, submit, or grant delegated authority.',
      inputSchema: {
        connector: z.string().min(2).optional(),
        protocol: z.string().min(1).optional(),
        operation: z.string().min(1).optional(),
        blinkUrl: z.string().min(1),
        account: z.string().min(32).optional(),
        parameters: z.record(z.string()).optional(),
        expectedAmount: z.string().min(1).optional(),
        expectedToken: z.string().min(1).optional(),
        expectedRecipient: z.string().min(1).optional(),
        position: z.string().min(1).optional(),
        note: z.string().max(500).optional(),
        dueAt: z.string().datetime().optional(),
      },
    },
    async (input) => traceTool(
      'solana_prepare_blink_action',
      { cluster: options.config.cluster, input },
      async () => jsonReply(await service.prepareBlinkAction(input)),
    ),
  );

  server.registerTool(
    'solana_prepare_kamino_deposit',
    {
      description:
        "Create a manual-approval inbox item that deposits a token into a Kamino Lend reserve. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Natural-language synonyms: 'stake on Kamino', 'supply to Kamino', 'lend on Kamino', 'earn yield on Kamino'. Mainnet-beta only.",
      inputSchema: {
        amount: z.string().min(1).describe('Human token amount, for example 0.5.'),
        token: z.string().min(2).optional().describe('SOL, USDC, JitoSOL, mSOL, bSOL, or a known reserve symbol.'),
        reserveMint: z.string().min(32).optional().describe('Reserve mint address (overrides token).'),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ amount, token, reserveMint, dueAt, note }) => traceTool(
      'solana_prepare_kamino_deposit',
      { cluster: options.config.cluster, amount, token, reserveMint, dueAt },
      async () => jsonReply(
        await service.prepareKaminoDeposit({
          amount,
          ...(token !== undefined && { token }),
          ...(reserveMint !== undefined && { reserveMint }),
          ...(dueAt !== undefined && { dueAt }),
          ...(note !== undefined && { note }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_prepare_kamino_withdraw',
    {
      description:
        "Create a manual-approval inbox item that withdraws supplied tokens from a Kamino Lend reserve. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Natural-language synonyms: 'unstake from Kamino', 'redeem from Kamino', 'withdraw on Kamino'. Mainnet-beta only.",
      inputSchema: {
        amount: z.string().min(1).optional().describe("Human token amount. Pass 'all' or set withdrawAll to true to redeem the full position."),
        withdrawAll: z.boolean().optional(),
        token: z.string().min(2).optional(),
        reserveMint: z.string().min(32).optional(),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ amount, withdrawAll, token, reserveMint, dueAt, note }) => traceTool(
      'solana_prepare_kamino_withdraw',
      { cluster: options.config.cluster, amount, withdrawAll, token, reserveMint, dueAt },
      async () => jsonReply(
        await service.prepareKaminoWithdraw({
          ...(amount !== undefined && { amount }),
          ...(withdrawAll !== undefined && { withdrawAll }),
          ...(token !== undefined && { token }),
          ...(reserveMint !== undefined && { reserveMint }),
          ...(dueAt !== undefined && { dueAt }),
          ...(note !== undefined && { note }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_kamino_reserve_snapshot',
    {
      description:
        'Read a Kamino Lend reserve snapshot: supply APY, borrow APY, utilization, deposit cap, and withdraw availability. Read-only. Mainnet-beta only.',
      inputSchema: {
        token: z.string().min(2).optional().describe('Reserve symbol (defaults to SOL).'),
        reserveMint: z.string().min(32).optional(),
      },
    },
    async ({ token, reserveMint }) => traceTool(
      'solana_kamino_reserve_snapshot',
      { cluster: options.config.cluster, token, reserveMint },
      async () => jsonReply(
        await service.kaminoReserveSnapshot({
          ...(token !== undefined && { token }),
          ...(reserveMint !== undefined && { reserveMint }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_kamino_get_positions',
    {
      description:
        'List the connected wallet supplied positions on Kamino Lend, including supplied amount, current value, and earned interest per reserve. Read-only. Mainnet-beta only.',
      inputSchema: {
        walletAddress: z.string().min(32).optional().describe('Defaults to the connected wallet.'),
      },
    },
    async ({ walletAddress }) => traceTool(
      'solana_kamino_get_positions',
      { cluster: options.config.cluster, walletAddress },
      async () => jsonReply(
        await service.kaminoGetPositions({
          ...(walletAddress !== undefined && { walletAddress }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_kamino_prepare_earnings_proof',
    {
      description:
        "Build a deterministic earnings-proof payload (positions + supplied + earned interest) the user can sign via solana_sign_message to create a verifiable receipt of how much they have earned on Kamino. Read-only on chain. Mainnet-beta only.",
      inputSchema: {
        walletAddress: z.string().min(32).optional(),
        reserveMint: z.string().min(32).optional().describe('Optional: scope the proof to a single reserve.'),
      },
    },
    async ({ walletAddress, reserveMint }) => traceTool(
      'solana_kamino_prepare_earnings_proof',
      { cluster: options.config.cluster, walletAddress, reserveMint },
      async () => jsonReply(
        await service.kaminoPrepareEarningsProof({
          ...(walletAddress !== undefined && { walletAddress }),
          ...(reserveMint !== undefined && { reserveMint }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_list_prepared_actions',
    {
      description:
        'List durable manual-approval inbox items. Scheduled actions appear as ready or overdue until the user approves or rejects them.',
      inputSchema: {},
    },
    async () => traceTool('solana_list_prepared_actions', { cluster: options.config.cluster }, async () =>
      jsonReply(await service.listPreparedActions()),
    ),
  );

  server.registerTool(
    'solana_reject_prepared_action',
    {
      description: 'Reject a durable manual-approval inbox item without opening the wallet.',
      inputSchema: {
        actionId: z.string().min(1),
        reason: z.string().optional(),
      },
    },
    async ({ actionId, reason }) => traceTool(
      'solana_reject_prepared_action',
      { actionId },
      async () => jsonReply(await service.rejectPreparedAction(actionId, reason)),
    ),
  );

  server.registerTool(
    'solana_execute_prepared_action',
    {
      description:
        'Send a prepared inbox item to the wallet for user approval now. Rechecks caps and balances, rebuilds a fresh transaction, opens the wallet, then only the wallet can sign and send.',
      inputSchema: {
        actionId: z.string().min(1),
      },
    },
    async ({ actionId }) => traceTool(
      'solana_execute_prepared_action',
      { actionId },
      async () => jsonReply(await service.executePreparedAction(actionId)),
    ),
  );

  server.registerTool(
    'solana_create_recurring_payment',
    {
      description:
        'Create a recurring manual-approval payment schedule. Due payments become inbox items; they do not auto-sign.',
      inputSchema: recurringInputSchema(),
    },
    async (input) => traceTool(
      'solana_create_recurring_payment',
      { cluster: options.config.cluster, input },
      async () => jsonReply(await service.createRecurringPayment(input as RecurringPaymentInput)),
    ),
  );

  server.registerTool(
    'solana_list_recurring_payments',
    {
      description: 'List recurring manual-approval schedules, including next due time and occurrence count.',
      inputSchema: {},
    },
    async () => traceTool('solana_list_recurring_payments', { cluster: options.config.cluster }, async () =>
      jsonReply(await service.listRecurringPayments()),
    ),
  );

  server.registerTool(
    'solana_pause_recurring_payment',
    {
      description: 'Pause a recurring payment schedule so it stops creating future approval inbox items.',
      inputSchema: { recurringId: z.string().min(1) },
    },
    async ({ recurringId }) => traceTool(
      'solana_pause_recurring_payment',
      { recurringId },
      async () => jsonReply(await service.pauseRecurringPayment(recurringId)),
    ),
  );

  server.registerTool(
    'solana_resume_recurring_payment',
    {
      description: 'Resume a paused recurring payment schedule.',
      inputSchema: { recurringId: z.string().min(1) },
    },
    async ({ recurringId }) => traceTool(
      'solana_resume_recurring_payment',
      { recurringId },
      async () => jsonReply(await service.resumeRecurringPayment(recurringId)),
    ),
  );

  server.registerTool(
    'solana_delete_recurring_payment',
    {
      description:
        'Delete a recurring payment schedule. Existing prepared inbox items remain; only future materialization stops.',
      inputSchema: { recurringId: z.string().min(1) },
    },
    async ({ recurringId }) => traceTool(
      'solana_delete_recurring_payment',
      { recurringId },
      async () => jsonReply(await service.deleteRecurringPayment(recurringId)),
    ),
  );

  server.registerTool(
    'solana_archive_prepared_action',
    {
      description: 'Archive an approved, rejected, failed, or blocked inbox item so it no longer clutters the default browser inbox.',
      inputSchema: { actionId: z.string().min(1) },
    },
    async ({ actionId }) => traceTool(
      'solana_archive_prepared_action',
      { actionId },
      async () => jsonReply(await service.archivePreparedAction(actionId)),
    ),
  );

  server.registerTool(
    'solana_export_receipts',
    {
      description: 'Export terminal approval receipts with action id, txid, wallet, recipient, amount, note, and result.',
      inputSchema: {},
    },
    async () => traceTool('solana_export_receipts', { cluster: options.config.cluster }, async () =>
      jsonReply(await service.receipts()),
    ),
  );

  server.registerTool(
    'solana_health_check',
    {
      description: 'Check wallet, bridge/MCP config, RPC reachability, mainnet flag, safety caps, and prepared-action store path.',
      inputSchema: {},
    },
    async () => traceTool('solana_health_check', { cluster: options.config.cluster }, async () =>
      jsonReply(await service.health()),
    ),
  );

  server.registerTool(
    'solana_transfer_sol',
    {
      description:
        'Build, approve, and send a capped SOL transfer from the connected wallet. Real SOL is used on mainnet.',
      inputSchema: {
        recipient: z.string().min(32),
        amountSol: z.string().min(1),
      },
    },
    async ({ recipient, amountSol }) => traceTool(
      'solana_transfer_sol',
      { cluster: options.config.cluster, recipient, amountSol },
      async () => jsonReply(await service.transferSol({ recipient, amountSol })),
    ),
  );

  server.registerTool(
    'solana_transfer_spl',
    {
      description:
        'Build, approve, and send a capped SPL token transfer for an allowlisted token.',
      inputSchema: {
        token: z.string().min(2).describe('Configured token symbol or mint, for example USDC.'),
        recipient: z.string().min(32).describe('Recipient wallet address, not a token account.'),
        amount: z.string().min(1).describe('Human token amount, for example 1.25.'),
      },
    },
    async ({ token, recipient, amount }) => traceTool(
      'solana_transfer_spl',
      { cluster: options.config.cluster, token, recipient, amount },
      async () => jsonReply(await service.transferSpl({ token, recipient, amount })),
    ),
  );

  server.registerTool(
    'solana_get_swap_quote',
    {
      description:
        'Get a capped Jupiter Swap API v2 order preview and normalized connector facts for a supported token pair. Does not sign.',
      inputSchema: swapInputSchema(),
    },
    async (input) => traceTool(
      'solana_get_swap_quote',
      { cluster: options.config.cluster, input },
      async () => jsonReply(await service.getSwapQuote(input)),
    ),
  );

  server.registerTool(
    'solana_jupiter_order_preview',
    {
      description:
        'Get a Jupiter order preview as stable JSON with normalized connector facts. Read-only; does not sign, submit, or grant delegated authority.',
      inputSchema: {
        ...swapInputSchema(),
        taker: z.string().min(32).optional().describe('Optional wallet address for wallet-specific Jupiter preview. Defaults to the connected wallet.'),
      },
    },
    async (input) => traceTool(
      'solana_jupiter_order_preview',
      { cluster: options.config.cluster, input },
      async () => jsonReply(await service.jupiterOrderPreview(input)),
    ),
  );

  server.registerTool(
    'solana_swap',
    {
      description:
        'Create a capped Jupiter Swap API v2 order, request wallet approval, execute the wallet-signed transaction, and return the transaction id. Does not grant delegated authority.',
      inputSchema: swapInputSchema(),
    },
    async (input) => traceTool(
      'solana_swap',
      { cluster: options.config.cluster, input },
      async () => jsonReply(await service.swap(input)),
    ),
  );
}

async function traceTool<T>(tool: string, payload: Record<string, unknown>, run: () => Promise<T> | T) {
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

function swapInputSchema() {
  return {
    inputToken: z.string().default('SOL'),
    outputToken: z.string().default('USDC'),
    amount: z.string().min(1),
    slippageBps: z.number().int().min(1).optional(),
  };
}

function connectorCapabilitySchema() {
  return z.enum([
    'positions',
    'rewards',
    'markets',
    'blinks',
    'swap',
    'earn',
    'borrow',
    'withdraw',
    'repay',
    'add_liquidity',
    'close',
  ]);
}

function optionsConnectorCapabilities(
  service: AgentWalletActionService,
  connectorId: string | undefined,
) {
  return service.connectorCapabilities({
    ...(connectorId !== undefined && { connectorId }),
  });
}

function recurringInputSchema() {
  return {
    token: z.string().min(2).describe('SOL or an allowlisted token symbol such as USDC.'),
    recipient: z.string().min(32),
    amount: z.string().min(1),
    cadence: z.enum(['weekly', 'monthly', 'interval_days', 'interval_hours', 'interval_minutes']).default('weekly'),
    dayOfWeek: z.number().int().min(0).max(6).optional().describe('0 is Sunday, 5 is Friday. Required for weekly.'),
    dayOfMonth: z.number().int().min(1).max(31).optional().describe('Required for monthly. Values past month end clamp to the last day.'),
    intervalDays: z.number().int().min(1).max(365).optional().describe('Required for interval_days.'),
    intervalHours: z.number().int().min(1).max(8760).optional().describe('Required for interval_hours.'),
    intervalMinutes: z.number().int().min(1).max(525600).optional().describe('Required for interval_minutes.'),
    localTime: z.string().regex(/^\d{2}:\d{2}$/).optional().describe('24-hour local time, for example 00:00. Required for weekly/monthly.'),
    startAt: z.string().datetime().optional().describe('ISO start time for interval schedules. Defaults to creation time.'),
    maxOccurrences: z.number().int().min(1).max(1000).optional().describe('Omit for indefinite recurring approvals.'),
    note: z.string().max(500).optional(),
    expiresAt: z.string().datetime().optional().describe('Optional ISO timestamp; the schedule auto-completes when reached.'),
    notifications: z
      .object({
        inApp: z.boolean().optional(),
        webhookUrl: z.string().url().optional().describe('Optional http(s) URL notified when each occurrence becomes ready for approval.'),
      })
      .optional()
      .describe('Optional notification preferences for this schedule.'),
  };
}

function usefulPrompts(config: AgentWalletConfig) {
  return {
    title: 'Useful solana-agent-wallet prompts',
    cluster: config.cluster,
    worksNow: [
      {
        category: 'Wallet status',
        prompts: [
          'Use solana-agent-wallet to show my wallet status.',
          'Use solana-agent-wallet to show my SOL and allowlisted token balances.',
        ],
      },
      {
        category: 'Simple payments',
        prompts: [
          'Use solana-agent-wallet to send 0.01 SOL to <recipient>.',
          'Use solana-agent-wallet to send 1 USDC to <recipient> if I have enough USDC.',
        ],
      },
      {
        category: 'Swaps',
        prompts: [
          'Use solana-agent-wallet to quote swapping 0.01 SOL to USDC. Do not execute it.',
          'Use solana-agent-wallet to swap 0.01 SOL to USDC, staying within my configured slippage cap.',
        ],
      },
      {
        category: 'Approval inbox',
        prompts: [
          'Use solana-agent-wallet to prepare a 0.01 SOL payment to <recipient>, then list my prepared approval inbox actions.',
          'Use solana-agent-wallet to approve prepared action <actionId>.',
        ],
      },
      {
        category: 'Scheduled payments',
        prompts: [
          'Use solana-agent-wallet to prepare a 10 USDC payment to <recipient> for Friday at 8pm.',
          'Use solana-agent-wallet to create a weekly Friday 10 USDC recurring payment to <recipient> for manual approval.',
        ],
      },
      {
        category: 'Safety checks',
        prompts: [
          'Use solana-agent-wallet to show my safety caps before doing anything.',
          'Use solana-agent-wallet to tell me whether this requested SOL transfer is within my configured cap.',
        ],
      },
      {
        category: 'Kamino (Protocol Connector)',
        prompts: [
          'Use solana-agent-wallet to deposit 0.1 SOL into Kamino, then list my prepared approval inbox actions.',
          'Use solana-agent-wallet to show my Kamino positions and how much SOL I have earned.',
          'Use solana-agent-wallet to prepare a Kamino earnings proof for my SOL supply, then ask me to sign it.',
          'Use solana-agent-wallet to withdraw 0.05 SOL from Kamino for manual approval.',
        ],
      },
    ],
    roadmapNotAutomatedYet: [
      {
        category: 'Portfolio rebalancing',
        prompts: [
          'Partial today: check balances and quote a capped swap toward 70% SOL / 30% USDC. Automatic portfolio policy execution is not built yet.',
        ],
      },
      {
        category: 'DeFi cleanup',
        prompts: [
          'Partial today: inspect balances. Spam-token detection and cleanup transactions are not built yet.',
        ],
      },
      {
        category: 'Invoice parsing',
        prompts: [
          'Prompt workflow today: read an invoice, extract recipient and amount, then ask me before using solana-agent-wallet to pay it.',
        ],
      },
    ],
    safetyDefaults: {
      maxSolTransfer: config.mainnet.maxSolTransfer,
      maxSwapInput: config.mainnet.maxSwapInput,
      maxSlippageBps: config.mainnet.maxSlippageBps,
      arbitraryTransactionsAllowed: config.mainnet.allowArbitraryTransactions,
      allowlistedTokens: config.tokens.map((token) => ({
        symbol: token.symbol,
        mint: token.mint,
        maxTransfer: token.maxTransfer,
      })),
    },
  };
}

function jsonReply(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: stringify(payload) }],
  };
}

function errorReply(err: unknown) {
  const protocolErr =
    err instanceof ProtocolError
      ? err
      : new ProtocolError(
          'wallet_unreachable',
          err instanceof Error ? err.message : 'Unknown action error.',
        );
  const payload: ProtocolErrorPayload = protocolErr.toPayload();
  return {
    content: [
      {
        type: 'text' as const,
        text: `Solana wallet action error.\n\nCode: ${payload.code}\nRecoverable: ${payload.recoverable}\nMessage: ${payload.message}\n\nMachine-readable JSON:\n${stringify(payload)}`,
      },
    ],
    isError: true,
  };
}

function stringify(payload: unknown): string {
  return JSON.stringify(payload, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}
