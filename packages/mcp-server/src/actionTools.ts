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
        'List MCP protocol connector capabilities, read tools, action tools, limitations, and wallet approval boundaries. Answers what Kamino, Jupiter, Meteora, Raydium, Orca, MarginFi, Drift, Lulo, Save, Jito, Marinade, Sanctum, Magic Eden, and Tensor can do in this runtime.',
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
        'Read normalized protocol connector facts as stable JSON. Supports Kamino, Jupiter, Raydium, Orca, MarginFi, Lulo, Save, Jito, Marinade, Sanctum, Tensor, and other first-class connector reads. Unsupported connectors return structured missing-capability errors.',
      inputSchema: {
        connectorId: z.string().min(2).describe('Connector id or alias, for example kamino or jupiter.'),
        capability: connectorCapabilitySchema().optional(),
        walletAddress: z.string().min(32).optional(),
        token: z.string().min(2).optional(),
        reserveMint: z.string().min(32).optional(),
        lstMint: z.string().min(32).optional(),
        inputMint: z.string().min(32).optional(),
        outputMint: z.string().min(32).optional(),
        inputToken: z.string().min(2).optional(),
        outputToken: z.string().min(2).optional(),
        amount: z.string().min(1).optional(),
        slippageBps: z.number().int().min(1).optional(),
        taker: z.string().min(32).optional(),
        poolAddress: z.string().min(32).optional(),
        positionAddress: z.string().min(32).optional(),
        poolId: z.string().min(32).optional(),
        poolType: raydiumReadPoolTypeSchema().optional(),
        farmId: z.string().min(32).optional(),
        whirlpoolAddress: z.string().min(32).optional(),
        positionMint: z.string().min(32).optional(),
        bankAddress: z.string().min(32).optional(),
        bankMint: z.string().min(32).optional(),
        marginfiAccount: z.string().min(32).optional(),
        operation: marginfiOperationSchema().optional(),
        jitoOperation: z.enum(['stake_sol', 'deposit_stake_account', 'unstake_jitosol', 'withdraw_sol']).optional(),
        marinadeOperation: z.enum(['liquid_stake', 'liquid_unstake', 'delayed_unstake', 'claim_delayed_unstake']).optional(),
        stakeAccount: z.string().min(32).optional(),
        solAmount: z.string().min(1).optional(),
        jitoSolAmount: z.string().min(1).optional(),
        msolAmount: z.string().min(1).optional(),
        minJitoSolAmount: z.string().min(1).optional(),
        minMsolAmount: z.string().min(1).optional(),
        minSolAmount: z.string().min(1).optional(),
        ticketAccount: z.string().min(32).optional(),
        claimableOnly: z.boolean().optional(),
        expectedClaimableAt: z.string().datetime().optional(),
        maxFeeBps: z.number().int().min(0).optional(),
        withdrawMode: z.enum(['stake_account', 'reserve_sol']).optional(),
        includeValidators: z.boolean().optional(),
        includeStakeAccounts: z.boolean().optional(),
        delegatedOnly: z.boolean().optional(),
        eligibleForJitoDepositOnly: z.boolean().optional(),
        withdrawAll: z.boolean().optional(),
        repayAll: z.boolean().optional(),
        createAccountIfMissing: z.boolean().optional(),
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
    'solana_meteora_dlmm_pool_snapshot',
    {
      description:
        'Read a Meteora DLMM pool snapshot: token mints, active bin, bin step, fees, liquidity, and program id. Read-only. Mainnet-beta only.',
      inputSchema: {
        poolAddress: z.string().min(32),
      },
    },
    async ({ poolAddress }) => traceTool(
      'solana_meteora_dlmm_pool_snapshot',
      { cluster: options.config.cluster, poolAddress },
      async () => jsonReply(await service.meteoraPoolSnapshot({ poolAddress })),
    ),
  );

  server.registerTool(
    'solana_meteora_wallet_positions',
    {
      description:
        'List wallet-owned Meteora DLMM positions, optionally filtered to one pool. Read-only. Mainnet-beta only.',
      inputSchema: {
        walletAddress: z.string().min(32).optional().describe('Defaults to the connected wallet.'),
        poolAddress: z.string().min(32).optional(),
      },
    },
    async ({ walletAddress, poolAddress }) => traceTool(
      'solana_meteora_wallet_positions',
      { cluster: options.config.cluster, walletAddress, poolAddress },
      async () => jsonReply(await service.meteoraWalletPositions({
        ...(walletAddress !== undefined && { walletAddress }),
        ...(poolAddress !== undefined && { poolAddress }),
      })),
    ),
  );

  server.registerTool(
    'solana_meteora_position_detail',
    {
      description:
        'Read one Meteora DLMM position, including bin range, in-range status, liquidity, fees, and rewards. Read-only. Mainnet-beta only.',
      inputSchema: {
        poolAddress: z.string().min(32),
        positionAddress: z.string().min(32),
      },
    },
    async ({ poolAddress, positionAddress }) => traceTool(
      'solana_meteora_position_detail',
      { cluster: options.config.cluster, poolAddress, positionAddress },
      async () => jsonReply(await service.meteoraPositionDetail({ poolAddress, positionAddress })),
    ),
  );

  server.registerTool(
    'solana_prepare_meteora_claim_fees',
    {
      description:
        'Create a manual-approval inbox item to claim fees from one Meteora DLMM position, or all positions in a pool when claimAll is true. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Mainnet-beta only.',
      inputSchema: meteoraClaimInputSchema(),
    },
    async (input) => traceTool(
      'solana_prepare_meteora_claim_fees',
      { cluster: options.config.cluster, input },
      async () => jsonReply(await service.prepareMeteoraClaimFees(input)),
    ),
  );

  server.registerTool(
    'solana_prepare_meteora_claim_rewards',
    {
      description:
        'Create a manual-approval inbox item to claim rewards from one Meteora DLMM position, or all positions in a pool when claimAll is true. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Mainnet-beta only.',
      inputSchema: meteoraClaimInputSchema(),
    },
    async (input) => traceTool(
      'solana_prepare_meteora_claim_rewards',
      { cluster: options.config.cluster, input },
      async () => jsonReply(await service.prepareMeteoraClaimRewards(input)),
    ),
  );

  server.registerTool(
    'solana_prepare_meteora_add_liquidity',
    {
      description:
        'Create a manual-approval inbox item to add liquidity to an existing Meteora DLMM position. New position creation is not exposed because it requires an additional position keypair signer. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Mainnet-beta only.',
      inputSchema: {
        poolAddress: z.string().min(32),
        positionAddress: z.string().min(32),
        tokenXAmount: z.string().min(1).optional(),
        tokenYAmount: z.string().min(1).optional(),
        minBinId: z.number().int(),
        maxBinId: z.number().int(),
        strategyType: z.enum(['spot', 'curve', 'bidask']).optional(),
        singleSidedX: z.boolean().optional(),
        slippageBps: z.number().int().min(0).optional(),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async (input) => traceTool(
      'solana_prepare_meteora_add_liquidity',
      { cluster: options.config.cluster, input },
      async () => jsonReply(await service.prepareMeteoraAddLiquidity(input)),
    ),
  );

  server.registerTool(
    'solana_prepare_meteora_remove_liquidity',
    {
      description:
        'Create a manual-approval inbox item to remove liquidity from a Meteora DLMM position. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Mainnet-beta only.',
      inputSchema: {
        poolAddress: z.string().min(32),
        positionAddress: z.string().min(32),
        liquidityBps: z.number().int().min(1).max(10000).optional(),
        liquidityPercent: z.number().gt(0).max(100).optional(),
        minBinId: z.number().int().optional(),
        maxBinId: z.number().int().optional(),
        slippageBps: z.number().int().min(0).optional(),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async (input) => traceTool(
      'solana_prepare_meteora_remove_liquidity',
      { cluster: options.config.cluster, input },
      async () => jsonReply(await service.prepareMeteoraRemoveLiquidity(input)),
    ),
  );

  server.registerTool(
    'solana_prepare_meteora_close_position',
    {
      description:
        'Create a manual-approval inbox item to close an empty Meteora DLMM position. Non-empty positions are rejected; remove liquidity first. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Mainnet-beta only.',
      inputSchema: {
        poolAddress: z.string().min(32),
        positionAddress: z.string().min(32),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async (input) => traceTool(
      'solana_prepare_meteora_close_position',
      { cluster: options.config.cluster, input },
      async () => jsonReply(await service.prepareMeteoraClosePosition(input)),
    ),
  );

  server.registerTool(
    'solana_raydium_pool_snapshot',
    {
      description:
        'Read a Raydium pool snapshot: token mints, pool type, program id, TVL/liquidity, fee rate, current CLMM tick, and reward mints when available. Read-only. Mainnet-beta only.',
      inputSchema: {
        poolId: z.string().min(32).describe('Raydium pool id.'),
        poolType: raydiumReadPoolTypeSchema().optional().describe('Optional hint: cpmm, clmm, or amm_v4.'),
      },
    },
    async ({ poolId, poolType }) => traceTool(
      'solana_raydium_pool_snapshot',
      { cluster: options.config.cluster, poolId, poolType },
      async () => jsonReply(await service.raydiumPoolSnapshot({
        poolId,
        ...(poolType !== undefined && { poolType }),
      })),
    ),
  );

  server.registerTool(
    'solana_raydium_wallet_positions',
    {
      description:
        'List wallet-owned Raydium CLMM positions, CPMM LP balances for a pool, and farm reward context when a farm id is supplied. Read-only. Mainnet-beta only.',
      inputSchema: {
        walletAddress: z.string().min(32).optional().describe('Defaults to the connected wallet.'),
        poolId: z.string().min(32).optional(),
        poolType: raydiumReadPoolTypeSchema().optional(),
        farmId: z.string().min(32).optional(),
      },
    },
    async ({ walletAddress, poolId, poolType, farmId }) => traceTool(
      'solana_raydium_wallet_positions',
      { cluster: options.config.cluster, walletAddress, poolId, poolType, farmId },
      async () => jsonReply(await service.raydiumWalletPositions({
        ...(walletAddress !== undefined && { walletAddress }),
        ...(poolId !== undefined && { poolId }),
        ...(poolType !== undefined && { poolType }),
        ...(farmId !== undefined && { farmId }),
      })),
    ),
  );

  server.registerTool(
    'solana_raydium_position_detail',
    {
      description:
        'Read one wallet-owned Raydium CLMM position, including tick range, in-range status, liquidity, and claimable fees/rewards. Read-only. Mainnet-beta only.',
      inputSchema: {
        walletAddress: z.string().min(32).optional().describe('Defaults to the connected wallet.'),
        positionMint: z.string().min(32),
        poolId: z.string().min(32).optional(),
      },
    },
    async ({ walletAddress, positionMint, poolId }) => traceTool(
      'solana_raydium_position_detail',
      { cluster: options.config.cluster, walletAddress, positionMint, poolId },
      async () => jsonReply(await service.raydiumPositionDetail({
        positionMint,
        ...(walletAddress !== undefined && { walletAddress }),
        ...(poolId !== undefined && { poolId }),
      })),
    ),
  );

  server.registerTool(
    'solana_prepare_raydium_add_liquidity',
    {
      description:
        'Create a manual-approval inbox item to add liquidity to a Raydium CPMM pool or CLMM position. CLMM opens require a tick or price range; existing CLMM positions require positionMint. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Mainnet-beta only.',
      inputSchema: {
        ...raydiumLiquidityInputSchema(),
        positionMint: z.string().min(32).optional().describe('Existing CLMM position mint. Omit only when opening a new CLMM position.'),
        tokenAAmount: z.string().min(1).optional(),
        tokenBAmount: z.string().min(1).optional(),
        maxTokenAAmount: z.string().min(1).optional().describe('Required for CLMM when tokenBAmount is the base amount.'),
        maxTokenBAmount: z.string().min(1).optional().describe('Required for CLMM when tokenAAmount is the base amount.'),
        lowerTick: z.number().int().optional(),
        upperTick: z.number().int().optional(),
        lowerPrice: z.string().min(1).optional(),
        upperPrice: z.string().min(1).optional(),
        slippageBps: z.number().int().min(0).optional(),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async (input) => traceTool(
      'solana_prepare_raydium_add_liquidity',
      { cluster: options.config.cluster, input },
      async () => jsonReply(await service.prepareRaydiumAddLiquidity(input)),
    ),
  );

  server.registerTool(
    'solana_prepare_raydium_remove_liquidity',
    {
      description:
        'Create a manual-approval inbox item to remove liquidity from a Raydium CPMM pool or CLMM position. Provide exactly one of liquidityPercent or liquidityAmount. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Mainnet-beta only.',
      inputSchema: {
        ...raydiumLiquidityInputSchema(),
        positionMint: z.string().min(32).optional().describe('Required for CLMM remove-liquidity.'),
        liquidityPercent: z.number().gt(0).max(100).optional(),
        liquidityAmount: z.string().min(1).optional().describe('Raw CLMM liquidity amount or human CPMM LP token amount.'),
        minTokenAAmount: z.string().min(1).optional(),
        minTokenBAmount: z.string().min(1).optional(),
        closePosition: z.boolean().optional().describe('CLMM only: close the position when removing all liquidity.'),
        slippageBps: z.number().int().min(0).optional(),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async (input) => traceTool(
      'solana_prepare_raydium_remove_liquidity',
      { cluster: options.config.cluster, input },
      async () => jsonReply(await service.prepareRaydiumRemoveLiquidity(input)),
    ),
  );

  server.registerTool(
    'solana_prepare_raydium_collect_fees',
    {
      description:
        'Create a manual-approval inbox item to collect trading fees from one Raydium CLMM position. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Mainnet-beta only.',
      inputSchema: {
        positionMint: z.string().min(32),
        poolId: z.string().min(32).optional(),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async (input) => traceTool(
      'solana_prepare_raydium_collect_fees',
      { cluster: options.config.cluster, input },
      async () => jsonReply(await service.prepareRaydiumCollectFees(input)),
    ),
  );

  server.registerTool(
    'solana_prepare_raydium_farm_stake',
    {
      description:
        'Create a manual-approval inbox item to stake Raydium farm LP tokens. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Mainnet-beta only.',
      inputSchema: {
        farmId: z.string().min(32),
        amount: z.string().min(1).describe('Human LP token amount to stake.'),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async (input) => traceTool(
      'solana_prepare_raydium_farm_stake',
      { cluster: options.config.cluster, input },
      async () => jsonReply(await service.prepareRaydiumFarmStake(input)),
    ),
  );

  server.registerTool(
    'solana_prepare_raydium_farm_unstake',
    {
      description:
        'Create a manual-approval inbox item to unstake Raydium farm LP tokens. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Mainnet-beta only.',
      inputSchema: {
        farmId: z.string().min(32),
        amount: z.string().min(1).describe('Human LP token amount to unstake.'),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async (input) => traceTool(
      'solana_prepare_raydium_farm_unstake',
      { cluster: options.config.cluster, input },
      async () => jsonReply(await service.prepareRaydiumFarmUnstake(input)),
    ),
  );

  server.registerTool(
    'solana_prepare_raydium_harvest',
    {
      description:
        'Create a manual-approval inbox item to harvest rewards from a Raydium farm. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Mainnet-beta only.',
      inputSchema: {
        farmId: z.string().min(32),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async (input) => traceTool(
      'solana_prepare_raydium_harvest',
      { cluster: options.config.cluster, input },
      async () => jsonReply(await service.prepareRaydiumHarvest(input)),
    ),
  );

  server.registerTool(
    'solana_orca_whirlpool_snapshot',
    {
      description:
        'Read an Orca Whirlpool pool snapshot: token mints, tick spacing, current tick/price, liquidity, fee tier, vaults, rewards, and program id. Read-only. Mainnet-beta only.',
      inputSchema: {
        whirlpoolAddress: z.string().min(32),
      },
    },
    async ({ whirlpoolAddress }) => traceTool(
      'solana_orca_whirlpool_snapshot',
      { cluster: options.config.cluster, whirlpoolAddress },
      async () => jsonReply(await service.orcaWhirlpoolSnapshot({ whirlpoolAddress })),
    ),
  );

  server.registerTool(
    'solana_orca_wallet_positions',
    {
      description:
        'List wallet-owned Orca Whirlpool tokenized positions, optionally filtered to one Whirlpool. Read-only. Mainnet-beta only.',
      inputSchema: {
        walletAddress: z.string().min(32).optional().describe('Defaults to the connected wallet.'),
        whirlpoolAddress: z.string().min(32).optional(),
      },
    },
    async ({ walletAddress, whirlpoolAddress }) => traceTool(
      'solana_orca_wallet_positions',
      { cluster: options.config.cluster, walletAddress, whirlpoolAddress },
      async () => jsonReply(await service.orcaWalletPositions({
        ...(walletAddress !== undefined && { walletAddress }),
        ...(whirlpoolAddress !== undefined && { whirlpoolAddress }),
      })),
    ),
  );

  server.registerTool(
    'solana_orca_position_detail',
    {
      description:
        'Read one Orca Whirlpool tokenized position, including tick range, in-range status, liquidity, fees, and rewards. Read-only. Mainnet-beta only.',
      inputSchema: {
        positionMint: z.string().min(32),
        whirlpoolAddress: z.string().min(32).optional(),
      },
    },
    async ({ positionMint, whirlpoolAddress }) => traceTool(
      'solana_orca_position_detail',
      { cluster: options.config.cluster, positionMint, whirlpoolAddress },
      async () => jsonReply(await service.orcaPositionDetail({
        positionMint,
        ...(whirlpoolAddress !== undefined && { whirlpoolAddress }),
      })),
    ),
  );

  server.registerTool(
    'solana_prepare_orca_increase_liquidity',
    {
      description:
        'Create a manual-approval inbox item to increase liquidity in an Orca Whirlpool position or open a new ranged position. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Mainnet-beta only.',
      inputSchema: {
        whirlpoolAddress: z.string().min(32),
        positionMint: z.string().min(32).optional().describe('Existing position mint. Omit only when opening a new position.'),
        tokenAAmount: z.string().min(1).optional(),
        tokenBAmount: z.string().min(1).optional(),
        maxTokenAAmount: z.string().min(1).optional(),
        maxTokenBAmount: z.string().min(1).optional(),
        lowerTick: z.number().int().optional().describe('Required when opening a new position.'),
        upperTick: z.number().int().optional().describe('Required when opening a new position.'),
        slippageBps: z.number().int().min(0).optional(),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async (input) => traceTool(
      'solana_prepare_orca_increase_liquidity',
      { cluster: options.config.cluster, input },
      async () => jsonReply(await service.prepareOrcaIncreaseLiquidity(input)),
    ),
  );

  server.registerTool(
    'solana_prepare_orca_decrease_liquidity',
    {
      description:
        'Create a manual-approval inbox item to decrease liquidity from an Orca Whirlpool position. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Mainnet-beta only.',
      inputSchema: {
        whirlpoolAddress: z.string().min(32),
        positionMint: z.string().min(32),
        liquidityPercent: z.number().gt(0).max(100).optional(),
        liquidityAmount: z.string().min(1).optional(),
        minTokenAAmount: z.string().min(1).optional(),
        minTokenBAmount: z.string().min(1).optional(),
        slippageBps: z.number().int().min(0).optional(),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async (input) => traceTool(
      'solana_prepare_orca_decrease_liquidity',
      { cluster: options.config.cluster, input },
      async () => jsonReply(await service.prepareOrcaDecreaseLiquidity(input)),
    ),
  );

  server.registerTool(
    'solana_prepare_orca_collect_fees',
    {
      description:
        'Create a manual-approval inbox item to collect trading fees from one Orca Whirlpool position. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Mainnet-beta only.',
      inputSchema: {
        positionMint: z.string().min(32),
        whirlpoolAddress: z.string().min(32).optional(),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async (input) => traceTool(
      'solana_prepare_orca_collect_fees',
      { cluster: options.config.cluster, input },
      async () => jsonReply(await service.prepareOrcaCollectFees(input)),
    ),
  );

  server.registerTool(
    'solana_prepare_orca_collect_rewards',
    {
      description:
        'Create a manual-approval inbox item to collect rewards from one Orca Whirlpool position. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Mainnet-beta only.',
      inputSchema: {
        positionMint: z.string().min(32),
        whirlpoolAddress: z.string().min(32).optional(),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async (input) => traceTool(
      'solana_prepare_orca_collect_rewards',
      { cluster: options.config.cluster, input },
      async () => jsonReply(await service.prepareOrcaCollectRewards(input)),
    ),
  );

  server.registerTool(
    'solana_marginfi_bank_snapshot',
    {
      description:
        'Read a MarginFi bank snapshot: deposit APY, borrow APR, utilization, deposit/borrow capacity, oracle, and risk config. Read-only. Mainnet-beta only.',
      inputSchema: marginfiBankInputSchema(),
    },
    async ({ bankAddress, bankMint, token }) => traceTool(
      'solana_marginfi_bank_snapshot',
      { cluster: options.config.cluster, bankAddress, bankMint, token },
      async () => jsonReply(
        await service.marginfiBankSnapshot({
          ...(bankAddress !== undefined && { bankAddress }),
          ...(bankMint !== undefined && { bankMint }),
          ...(token !== undefined && { token }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_marginfi_wallet_accounts',
    {
      description:
        'List MarginFi accounts for a wallet, including active balance count and account health. Read-only. Mainnet-beta only.',
      inputSchema: {
        walletAddress: z.string().min(32).optional().describe('Defaults to the connected wallet.'),
      },
    },
    async ({ walletAddress }) => traceTool(
      'solana_marginfi_wallet_accounts',
      { cluster: options.config.cluster, walletAddress },
      async () => jsonReply(
        await service.marginfiWalletAccounts({
          ...(walletAddress !== undefined && { walletAddress }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_marginfi_account_detail',
    {
      description:
        'Read one MarginFi account with supplied/borrowed positions and health components. Read-only. Mainnet-beta only.',
      inputSchema: {
        walletAddress: z.string().min(32).optional().describe('Defaults to the connected wallet.'),
        marginfiAccount: z.string().min(32).optional().describe('Required when the wallet has multiple MarginFi accounts.'),
      },
    },
    async ({ walletAddress, marginfiAccount }) => traceTool(
      'solana_marginfi_account_detail',
      { cluster: options.config.cluster, walletAddress, marginfiAccount },
      async () => jsonReply(
        await service.marginfiAccountDetail({
          ...(walletAddress !== undefined && { walletAddress }),
          ...(marginfiAccount !== undefined && { marginfiAccount }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_marginfi_health_preview',
    {
      description:
        'Preview MarginFi account health after a deposit, withdraw, borrow, or repay action. Read-only; does not sign or submit. Mainnet-beta only.',
      inputSchema: {
        operation: marginfiOperationSchema(),
        ...marginfiActionInputSchema(),
      },
    },
    async (input) => traceTool(
      'solana_marginfi_health_preview',
      { cluster: options.config.cluster, input },
      async () => jsonReply(await service.marginfiHealthPreview(input)),
    ),
  );

  server.registerTool(
    'solana_prepare_marginfi_deposit',
    {
      description:
        'Create a manual-approval inbox item that deposits a token into a MarginFi bank. Runs a health preview and prepares wallet approval work only; does not sign, submit, or grant delegated authority. Mainnet-beta only.',
      inputSchema: {
        ...marginfiBankInputSchema(),
        amount: z.string().min(1).describe('Human token amount, for example 10.5.'),
        marginfiAccount: z.string().min(32).optional(),
        createAccountIfMissing: z.boolean().optional().describe('Currently rejected by the connector; included as an explicit safety signal.'),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async (input) => traceTool(
      'solana_prepare_marginfi_deposit',
      { cluster: options.config.cluster, input },
      async () => jsonReply(await service.prepareMarginfiDeposit(input)),
    ),
  );

  server.registerTool(
    'solana_prepare_marginfi_withdraw',
    {
      description:
        'Create a manual-approval inbox item that withdraws supplied tokens from MarginFi. Rechecks account health at execution time. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Mainnet-beta only.',
      inputSchema: {
        ...marginfiBankInputSchema(),
        amount: z.string().min(1).optional().describe("Human token amount. Pass 'all' or set withdrawAll to true to redeem the full supplied position."),
        withdrawAll: z.boolean().optional(),
        marginfiAccount: z.string().min(32).optional(),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async (input) => traceTool(
      'solana_prepare_marginfi_withdraw',
      { cluster: options.config.cluster, input },
      async () => jsonReply(await service.prepareMarginfiWithdraw(input)),
    ),
  );

  server.registerTool(
    'solana_prepare_marginfi_borrow',
    {
      description:
        'Create a manual-approval inbox item that borrows tokens from a MarginFi bank after a projected health check. Rechecks account health at execution time. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Mainnet-beta only.',
      inputSchema: {
        ...marginfiBankInputSchema(),
        amount: z.string().min(1).describe('Human token amount to borrow, for example 1.'),
        marginfiAccount: z.string().min(32).optional(),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async (input) => traceTool(
      'solana_prepare_marginfi_borrow',
      { cluster: options.config.cluster, input },
      async () => jsonReply(await service.prepareMarginfiBorrow(input)),
    ),
  );

  server.registerTool(
    'solana_prepare_marginfi_repay',
    {
      description:
        'Create a manual-approval inbox item that repays MarginFi debt. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Mainnet-beta only.',
      inputSchema: {
        ...marginfiBankInputSchema(),
        amount: z.string().min(1).optional().describe("Human token amount. Pass 'all' or set repayAll to true to repay the full debt for the bank."),
        repayAll: z.boolean().optional(),
        marginfiAccount: z.string().min(32).optional(),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async (input) => traceTool(
      'solana_prepare_marginfi_repay',
      { cluster: options.config.cluster, input },
      async () => jsonReply(await service.prepareMarginfiRepay(input)),
    ),
  );

  server.registerTool(
    'solana_drift_user_snapshot',
    {
      description:
        'Read a Drift user account snapshot for a wallet and optional subaccount: deposits, borrows, total/free collateral, margin ratio. Read-only. Mainnet-beta only. V1 does not surface perp positions or order placement.',
      inputSchema: {
        walletAddress: z.string().min(32).optional().describe('Defaults to the connected wallet.'),
        subAccountId: z.number().int().min(0).optional().describe('Drift subaccount index, defaults to 0.'),
      },
    },
    async ({ walletAddress, subAccountId }) => traceTool(
      'solana_drift_user_snapshot',
      { cluster: options.config.cluster, walletAddress, subAccountId },
      async () => jsonReply(
        await service.driftUserSnapshot({
          ...(walletAddress !== undefined && { walletAddress }),
          ...(subAccountId !== undefined && { subAccountId }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_drift_vault_snapshot',
    {
      description:
        'Read a Drift strategy vault snapshot: name, manager, deposit mint, share price, redeem period, lockup, profit share, management fee, pending withdraw shares. Read-only. Mainnet-beta only.',
      inputSchema: {
        vaultAddress: z.string().min(32).describe('Drift vault account address.'),
      },
    },
    async ({ vaultAddress }) => traceTool(
      'solana_drift_vault_snapshot',
      { cluster: options.config.cluster, vaultAddress },
      async () => jsonReply(await service.driftVaultSnapshot({ vaultAddress })),
    ),
  );

  server.registerTool(
    'solana_drift_wallet_vault_positions',
    {
      description:
        'List the connected wallet (or a given wallet) depositor positions across Drift strategy vaults, including shares, value, and pending withdraw shares. Optional vaultAddress filter. Read-only. Mainnet-beta only.',
      inputSchema: {
        walletAddress: z.string().min(32).optional().describe('Defaults to the connected wallet.'),
        vaultAddress: z.string().min(32).optional().describe('Filter to a single vault.'),
      },
    },
    async ({ walletAddress, vaultAddress }) => traceTool(
      'solana_drift_wallet_vault_positions',
      { cluster: options.config.cluster, walletAddress, vaultAddress },
      async () => jsonReply(
        await service.driftWalletVaultPositions({
          ...(walletAddress !== undefined && { walletAddress }),
          ...(vaultAddress !== undefined && { vaultAddress }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_drift_withdraw_status',
    {
      description:
        'Read the Drift vault withdraw status for a wallet and vault: hasPendingRequest, requested shares, redeemableAt, isReady. Read-only. Mainnet-beta only.',
      inputSchema: {
        walletAddress: z.string().min(32).optional().describe('Defaults to the connected wallet.'),
        vaultAddress: z.string().min(32).describe('Drift vault account address.'),
      },
    },
    async ({ walletAddress, vaultAddress }) => traceTool(
      'solana_drift_withdraw_status',
      { cluster: options.config.cluster, walletAddress, vaultAddress },
      async () => jsonReply(
        await service.driftWithdrawStatus({
          vaultAddress,
          ...(walletAddress !== undefined && { walletAddress }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_prepare_drift_vault_deposit',
    {
      description:
        "Create a manual-approval inbox item that deposits a token into a Drift strategy vault. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Set initializeDepositorIfMissing: true to create the depositor account as part of the same approval. Mainnet-beta only. V1 covers strategy vault deposit/withdraw lifecycle only; no perp or spot order placement.",
      inputSchema: {
        vaultAddress: z.string().min(32).describe('Drift vault account address.'),
        amount: z.string().min(1).describe('Human token amount in the vault deposit mint, for example 25.'),
        mint: z.string().min(32).optional().describe('Asserts the expected deposit mint when set.'),
        initializeDepositorIfMissing: z.boolean().optional().describe('Opt in to creating the vault depositor account when absent.'),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ vaultAddress, amount, mint, initializeDepositorIfMissing, dueAt, note }) => traceTool(
      'solana_prepare_drift_vault_deposit',
      { cluster: options.config.cluster, vaultAddress, amount, mint, initializeDepositorIfMissing, dueAt },
      async () => jsonReply(
        await service.prepareDriftVaultDeposit({
          vaultAddress,
          amount,
          ...(mint !== undefined && { mint }),
          ...(initializeDepositorIfMissing !== undefined && { initializeDepositorIfMissing }),
          ...(dueAt !== undefined && { dueAt }),
          ...(note !== undefined && { note }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_prepare_drift_vault_request_withdraw',
    {
      description:
        "Create a manual-approval inbox item that requests a Drift strategy vault withdraw. Pass amount with withdrawUnit 'token' or shares with withdrawUnit 'shares'. Rejected if a pending request already exists. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Mainnet-beta only.",
      inputSchema: {
        vaultAddress: z.string().min(32),
        amount: z.string().min(1).optional().describe('Human token amount (required when withdrawUnit is "token").'),
        shares: z.string().min(1).optional().describe('Vault share amount (required when withdrawUnit is "shares").'),
        withdrawUnit: z.enum(['token', 'shares']).optional().describe('Defaults to "token".'),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ vaultAddress, amount, shares, withdrawUnit, dueAt, note }) => traceTool(
      'solana_prepare_drift_vault_request_withdraw',
      { cluster: options.config.cluster, vaultAddress, amount, shares, withdrawUnit, dueAt },
      async () => jsonReply(
        await service.prepareDriftVaultRequestWithdraw({
          vaultAddress,
          ...(amount !== undefined && { amount }),
          ...(shares !== undefined && { shares }),
          ...(withdrawUnit !== undefined && { withdrawUnit }),
          ...(dueAt !== undefined && { dueAt }),
          ...(note !== undefined && { note }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_prepare_drift_vault_cancel_withdraw',
    {
      description:
        'Create a manual-approval inbox item that cancels a pending Drift strategy vault withdraw request. Rejected if no pending request exists. Prepares wallet approval work only. Mainnet-beta only.',
      inputSchema: {
        vaultAddress: z.string().min(32),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ vaultAddress, dueAt, note }) => traceTool(
      'solana_prepare_drift_vault_cancel_withdraw',
      { cluster: options.config.cluster, vaultAddress, dueAt },
      async () => jsonReply(
        await service.prepareDriftVaultCancelWithdraw({
          vaultAddress,
          ...(dueAt !== undefined && { dueAt }),
          ...(note !== undefined && { note }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_prepare_drift_vault_complete_withdraw',
    {
      description:
        'Create a manual-approval inbox item that completes a Drift strategy vault withdraw once the redeem period has elapsed. Rejected if the redeem period has not elapsed or there is no pending request. Prepares wallet approval work only. Mainnet-beta only.',
      inputSchema: {
        vaultAddress: z.string().min(32),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ vaultAddress, dueAt, note }) => traceTool(
      'solana_prepare_drift_vault_complete_withdraw',
      { cluster: options.config.cluster, vaultAddress, dueAt },
      async () => jsonReply(
        await service.prepareDriftVaultCompleteWithdraw({
          vaultAddress,
          ...(dueAt !== undefined && { dueAt }),
          ...(note !== undefined && { note }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_squads_wallet_authority',
    {
      description:
        'Read the connected wallet (or a given wallet) authority across Squads multisigs: per-multisig role (none, proposer, voter, executor, all), threshold, member count, and optional active proposals where the wallet has a vote. Read-only. Mainnet-beta only.',
      inputSchema: {
        walletAddress: z.string().min(32).optional().describe('Defaults to the connected wallet.'),
        includeProposals: z.boolean().optional().describe('Attach active proposals where the wallet has a role. Defaults to true at the adapter.'),
      },
    },
    async ({ walletAddress, includeProposals }) => traceTool(
      'solana_squads_wallet_authority',
      { cluster: options.config.cluster, walletAddress, includeProposals },
      async () => jsonReply(
        await service.squadsWalletAuthority({
          ...(walletAddress !== undefined && { walletAddress }),
          ...(includeProposals !== undefined && { includeProposals }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_squads_multisig_snapshot',
    {
      description:
        'Read a Squads multisig snapshot: members and their permissions, threshold, time-lock, config authority, current transaction index, and vault count. Read-only. Mainnet-beta only.',
      inputSchema: {
        multisigAddress: z.string().min(32).describe('Squads multisig account address.'),
        includeMembers: z.boolean().optional().describe('Include the member list. Default true.'),
        includeVaults: z.boolean().optional().describe('Include vault PDAs. Default true.'),
        includeProposals: z.boolean().optional().describe('Attach active proposals. Default false.'),
      },
    },
    async ({ multisigAddress, includeMembers, includeVaults, includeProposals }) => traceTool(
      'solana_squads_multisig_snapshot',
      { cluster: options.config.cluster, multisigAddress },
      async () => jsonReply(
        await service.squadsMultisigSnapshot({
          multisigAddress,
          ...(includeMembers !== undefined && { includeMembers }),
          ...(includeVaults !== undefined && { includeVaults }),
          ...(includeProposals !== undefined && { includeProposals }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_squads_vault_snapshot',
    {
      description:
        'Read a Squads vault snapshot for a multisig: vault PDA, lamports balance, SPL token accounts and balances. Provide either vaultIndex or vaultAddress. Read-only. Mainnet-beta only.',
      inputSchema: {
        multisigAddress: z.string().min(32).describe('Squads multisig account address.'),
        vaultIndex: z.number().int().min(0).optional().describe('Vault index inside the multisig.'),
        vaultAddress: z.string().min(32).optional().describe('Explicit vault PDA. Use either this or vaultIndex.'),
        includeBalances: z.boolean().optional().describe('Include token-account balances. Default true.'),
      },
    },
    async ({ multisigAddress, vaultIndex, vaultAddress, includeBalances }) => traceTool(
      'solana_squads_vault_snapshot',
      { cluster: options.config.cluster, multisigAddress, vaultIndex, vaultAddress },
      async () => jsonReply(
        await service.squadsVaultSnapshot({
          multisigAddress,
          ...(vaultIndex !== undefined && { vaultIndex }),
          ...(vaultAddress !== undefined && { vaultAddress }),
          ...(includeBalances !== undefined && { includeBalances }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_squads_proposal_snapshot',
    {
      description:
        'Read a Squads proposal snapshot: status, approvals vs threshold, time-lock readiness, and decoded instruction preview (SOL transfer, SPL transfer, memo, Squads admin instructions, compute-budget). Provide either proposalAddress or transactionIndex. Read-only. Mainnet-beta only.',
      inputSchema: {
        multisigAddress: z.string().min(32).describe('Squads multisig account address.'),
        proposalAddress: z.string().min(32).optional().describe('Explicit proposal PDA.'),
        transactionIndex: z.number().int().min(0).optional().describe('Transaction index inside the multisig.'),
        includeInstructions: z.boolean().optional().describe('Decode inner instructions for review. Default true.'),
      },
    },
    async ({ multisigAddress, proposalAddress, transactionIndex, includeInstructions }) => traceTool(
      'solana_squads_proposal_snapshot',
      { cluster: options.config.cluster, multisigAddress, proposalAddress, transactionIndex },
      async () => jsonReply(
        await service.squadsProposalSnapshot({
          multisigAddress,
          ...(proposalAddress !== undefined && { proposalAddress }),
          ...(transactionIndex !== undefined && { transactionIndex }),
          ...(includeInstructions !== undefined && { includeInstructions }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_squads_proposal_list',
    {
      description:
        'List Squads proposals for a multisig filtered by status (default active). Returns transactionIndex, status, approvals vs threshold, and timestamps. Read-only. Mainnet-beta only.',
      inputSchema: {
        multisigAddress: z.string().min(32).describe('Squads multisig account address.'),
        status: z
          .enum(['draft', 'active', 'approved', 'rejected', 'executed', 'cancelled', 'expired', 'all'])
          .optional()
          .describe('Defaults to "active".'),
        limit: z.number().int().min(1).max(100).optional().describe('Defaults to 20, max 100.'),
      },
    },
    async ({ multisigAddress, status, limit }) => traceTool(
      'solana_squads_proposal_list',
      { cluster: options.config.cluster, multisigAddress, status, limit },
      async () => jsonReply(
        await service.squadsProposalList({
          multisigAddress,
          ...(status !== undefined && { status }),
          ...(limit !== undefined && { limit }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_prepare_squads_create_transfer_proposal',
    {
      description:
        "Create a manual-approval inbox item that proposes a SOL or SPL transfer out of a Squads multisig vault. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Rejected if the connected wallet does not have proposer permission, the vault balance is insufficient, or the mint decimals do not match. Mainnet-beta only. V1 builds exactly one inner transfer instruction.",
      inputSchema: {
        multisigAddress: z.string().min(32).describe('Squads multisig account address.'),
        recipient: z.string().min(32).describe('Transfer recipient public key.'),
        amount: z.string().min(1).describe('Human token amount, for example 100 or 0.5.'),
        mintAddress: z.string().min(32).optional().describe('Omit for SOL transfer. Required for SPL transfer.'),
        vaultIndex: z.number().int().min(0).optional().describe('Squads vault index. Provide vaultIndex or vaultAddress.'),
        vaultAddress: z.string().min(32).optional().describe('Explicit vault PDA. Provide vaultIndex or vaultAddress.'),
        memo: z.string().max(280).optional().describe('Optional on-chain memo attached to the proposal.'),
        title: z.string().min(1).max(120).describe('Short proposal title for the wallet review surface.'),
        description: z.string().max(2000).optional().describe('Optional longer description.'),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({
      multisigAddress,
      recipient,
      amount,
      mintAddress,
      vaultIndex,
      vaultAddress,
      memo,
      title,
      description,
      dueAt,
      note,
    }) => traceTool(
      'solana_prepare_squads_create_transfer_proposal',
      { cluster: options.config.cluster, multisigAddress, recipient, amount, mintAddress, vaultIndex },
      async () => jsonReply(
        await service.prepareSquadsCreateTransferProposal({
          multisigAddress,
          recipient,
          amount,
          ...(mintAddress !== undefined && { mintAddress }),
          ...(vaultIndex !== undefined && { vaultIndex }),
          ...(vaultAddress !== undefined && { vaultAddress }),
          ...(memo !== undefined && { memo }),
          title,
          ...(description !== undefined && { description }),
          ...(dueAt !== undefined && { dueAt }),
          ...(note !== undefined && { note }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_prepare_squads_approve_proposal',
    {
      description:
        "Create a manual-approval inbox item that approves a Squads proposal. Rejected if the wallet is not a voter, or if the proposal is not in 'active' state. Prepares wallet approval work only. Mainnet-beta only.",
      inputSchema: {
        multisigAddress: z.string().min(32),
        proposalAddress: z.string().min(32).optional(),
        transactionIndex: z.number().int().min(0).optional(),
        reason: z.string().max(500).optional(),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ multisigAddress, proposalAddress, transactionIndex, reason, dueAt, note }) => traceTool(
      'solana_prepare_squads_approve_proposal',
      { cluster: options.config.cluster, multisigAddress, proposalAddress, transactionIndex },
      async () => jsonReply(
        await service.prepareSquadsApproveProposal({
          multisigAddress,
          ...(proposalAddress !== undefined && { proposalAddress }),
          ...(transactionIndex !== undefined && { transactionIndex }),
          ...(reason !== undefined && { reason }),
          ...(dueAt !== undefined && { dueAt }),
          ...(note !== undefined && { note }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_prepare_squads_reject_proposal',
    {
      description:
        "Create a manual-approval inbox item that rejects a Squads proposal. Rejected if the wallet is not a voter, or if the proposal is not in 'active' state. Prepares wallet approval work only. Mainnet-beta only.",
      inputSchema: {
        multisigAddress: z.string().min(32),
        proposalAddress: z.string().min(32).optional(),
        transactionIndex: z.number().int().min(0).optional(),
        reason: z.string().max(500).optional(),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ multisigAddress, proposalAddress, transactionIndex, reason, dueAt, note }) => traceTool(
      'solana_prepare_squads_reject_proposal',
      { cluster: options.config.cluster, multisigAddress, proposalAddress, transactionIndex },
      async () => jsonReply(
        await service.prepareSquadsRejectProposal({
          multisigAddress,
          ...(proposalAddress !== undefined && { proposalAddress }),
          ...(transactionIndex !== undefined && { transactionIndex }),
          ...(reason !== undefined && { reason }),
          ...(dueAt !== undefined && { dueAt }),
          ...(note !== undefined && { note }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_prepare_squads_cancel_proposal',
    {
      description:
        "Create a manual-approval inbox item that cancels a Squads proposal that has reached 'approved' state. Rejected if the wallet is not a voter, or if the proposal status does not allow cancellation. Prepares wallet approval work only. Mainnet-beta only.",
      inputSchema: {
        multisigAddress: z.string().min(32),
        proposalAddress: z.string().min(32).optional(),
        transactionIndex: z.number().int().min(0).optional(),
        reason: z.string().max(500).optional(),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ multisigAddress, proposalAddress, transactionIndex, reason, dueAt, note }) => traceTool(
      'solana_prepare_squads_cancel_proposal',
      { cluster: options.config.cluster, multisigAddress, proposalAddress, transactionIndex },
      async () => jsonReply(
        await service.prepareSquadsCancelProposal({
          multisigAddress,
          ...(proposalAddress !== undefined && { proposalAddress }),
          ...(transactionIndex !== undefined && { transactionIndex }),
          ...(reason !== undefined && { reason }),
          ...(dueAt !== undefined && { dueAt }),
          ...(note !== undefined && { note }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_prepare_squads_execute_proposal',
    {
      description:
        "Create a manual-approval inbox item that executes an approved Squads proposal. Rejected if the wallet is not an executor, the proposal status is not 'approved', the threshold is not met, or the time-lock has not elapsed. Execution moves treasury funds. Prepares wallet approval work only. Mainnet-beta only.",
      inputSchema: {
        multisigAddress: z.string().min(32),
        proposalAddress: z.string().min(32).optional(),
        transactionIndex: z.number().int().min(0).optional(),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ multisigAddress, proposalAddress, transactionIndex, dueAt, note }) => traceTool(
      'solana_prepare_squads_execute_proposal',
      { cluster: options.config.cluster, multisigAddress, proposalAddress, transactionIndex },
      async () => jsonReply(
        await service.prepareSquadsExecuteProposal({
          multisigAddress,
          ...(proposalAddress !== undefined && { proposalAddress }),
          ...(transactionIndex !== undefined && { transactionIndex }),
          ...(dueAt !== undefined && { dueAt }),
          ...(note !== undefined && { note }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_realms_wallet_governance',
    {
      description:
        "Read Realms / SPL Governance token-owner-records for the connected wallet (or a given wallet) across realms: deposit amount, outstanding proposals, unrelinquished votes, governance delegate, and plugin-detection flags. Read-only. Mainnet-beta only.",
      inputSchema: {
        walletAddress: z.string().min(32).optional().describe('Defaults to the connected wallet.'),
        realmAddress: z.string().min(32).optional().describe('Filter to a single realm.'),
        includeInactive: z.boolean().optional().describe('Include zero-balance token owner records.'),
      },
    },
    async ({ walletAddress, realmAddress, includeInactive }) => traceTool(
      'solana_realms_wallet_governance',
      { cluster: options.config.cluster, walletAddress, realmAddress, includeInactive },
      async () => jsonReply(
        await service.realmsWalletGovernance({
          ...(walletAddress !== undefined && { walletAddress }),
          ...(realmAddress !== undefined && { realmAddress }),
          ...(includeInactive !== undefined && { includeInactive }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_realms_realm_snapshot',
    {
      description:
        'Read a Realms / SPL Governance realm snapshot: name, community and council mint, governances, and plugin detection. Read-only. Mainnet-beta only.',
      inputSchema: {
        realmAddress: z.string().min(32).describe('Realm account address.'),
        includeGovernances: z.boolean().optional().describe('Default true. Include the realm\'s governance accounts.'),
        includeTokenMints: z.boolean().optional().describe('Default true. Include community/council mint decimals.'),
      },
    },
    async ({ realmAddress, includeGovernances, includeTokenMints }) => traceTool(
      'solana_realms_realm_snapshot',
      { cluster: options.config.cluster, realmAddress, includeGovernances, includeTokenMints },
      async () => jsonReply(
        await service.realmsRealmSnapshot({
          realmAddress,
          ...(includeGovernances !== undefined && { includeGovernances }),
          ...(includeTokenMints !== undefined && { includeTokenMints }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_realms_governance_snapshot',
    {
      description:
        'Read a Realms / SPL Governance governance snapshot: vote threshold, voting base seconds, cool-off seconds, and proposal headers. Read-only. Mainnet-beta only.',
      inputSchema: {
        governanceAddress: z.string().min(32).describe('Governance account address.'),
        includeConfig: z.boolean().optional().describe('Default true.'),
        includeProposals: z.boolean().optional().describe('Default false. Include proposal headers for this governance.'),
      },
    },
    async ({ governanceAddress, includeConfig, includeProposals }) => traceTool(
      'solana_realms_governance_snapshot',
      { cluster: options.config.cluster, governanceAddress, includeConfig, includeProposals },
      async () => jsonReply(
        await service.realmsGovernanceSnapshot({
          governanceAddress,
          ...(includeConfig !== undefined && { includeConfig }),
          ...(includeProposals !== undefined && { includeProposals }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_realms_proposal_list',
    {
      description:
        "List Realms / SPL Governance proposals for a realm, optionally filtered by governance and state ('voting' by default). Read-only. Mainnet-beta only.",
      inputSchema: {
        realmAddress: z.string().min(32),
        governanceAddress: z.string().min(32).optional(),
        state: z
          .enum([
            'draft',
            'signing_off',
            'voting',
            'succeeded',
            'defeated',
            'executing',
            'completed',
            'cancelled',
            'executing_with_errors',
            'vetoed',
            'all',
          ])
          .optional()
          .describe('Default "voting".'),
        limit: z.number().int().positive().max(200).optional().describe('Default 20.'),
      },
    },
    async ({ realmAddress, governanceAddress, state, limit }) => traceTool(
      'solana_realms_proposal_list',
      { cluster: options.config.cluster, realmAddress, governanceAddress, state, limit },
      async () => jsonReply(
        await service.realmsProposalList({
          realmAddress,
          ...(governanceAddress !== undefined && { governanceAddress }),
          ...(state !== undefined && { state }),
          ...(limit !== undefined && { limit }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_realms_proposal_snapshot',
    {
      description:
        'Read a Realms / SPL Governance proposal snapshot: state, vote type, choices, vote tally, voting expiry, cool-off, and decoded-or-marked-unknown instructions. Read-only. Mainnet-beta only.',
      inputSchema: {
        proposalAddress: z.string().min(32),
        includeInstructions: z.boolean().optional().describe('Default true.'),
        includeVoteBreakdown: z.boolean().optional().describe('Default true.'),
      },
    },
    async ({ proposalAddress, includeInstructions, includeVoteBreakdown }) => traceTool(
      'solana_realms_proposal_snapshot',
      { cluster: options.config.cluster, proposalAddress, includeInstructions, includeVoteBreakdown },
      async () => jsonReply(
        await service.realmsProposalSnapshot({
          proposalAddress,
          ...(includeInstructions !== undefined && { includeInstructions }),
          ...(includeVoteBreakdown !== undefined && { includeVoteBreakdown }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_realms_vote_record',
    {
      description:
        "Read a wallet's vote record for a Realms / SPL Governance proposal (returns { exists: false } if none). Read-only. Mainnet-beta only.",
      inputSchema: {
        proposalAddress: z.string().min(32),
        walletAddress: z.string().min(32).optional().describe('Defaults to the connected wallet.'),
      },
    },
    async ({ proposalAddress, walletAddress }) => traceTool(
      'solana_realms_vote_record',
      { cluster: options.config.cluster, proposalAddress, walletAddress },
      async () => jsonReply(
        await service.realmsVoteRecord({
          proposalAddress,
          ...(walletAddress !== undefined && { walletAddress }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_prepare_realms_cast_vote',
    {
      description:
        "Create a manual-approval inbox item that casts a Realms / SPL Governance vote (approve, deny, abstain, or veto). Prepares wallet approval work only; does not sign, submit, or grant delegated authority. V1 refuses cast vote when the realm uses a voting power plugin; deposit and withdraw remain available. Voting does not execute the proposal. Mainnet-beta only.",
      inputSchema: {
        proposalAddress: z.string().min(32),
        vote: z.enum(['approve', 'deny', 'abstain', 'veto']),
        choiceIndex: z.number().int().min(0).optional().describe('Required for multi-choice proposals; reject for single-choice.'),
        comment: z.string().max(500).optional().describe('Optional local note; not sent on-chain.'),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ proposalAddress, vote, choiceIndex, comment, dueAt, note }) => traceTool(
      'solana_prepare_realms_cast_vote',
      { cluster: options.config.cluster, proposalAddress, vote, choiceIndex, dueAt },
      async () => jsonReply(
        await service.prepareRealmsCastVote({
          proposalAddress,
          vote,
          ...(choiceIndex !== undefined && { choiceIndex }),
          ...(comment !== undefined && { comment }),
          ...(dueAt !== undefined && { dueAt }),
          ...(note !== undefined && { note }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_prepare_realms_relinquish_vote',
    {
      description:
        "Create a manual-approval inbox item that relinquishes a previously cast Realms / SPL Governance vote. Pre-finalization, this removes the vote from the tally. Post-finalization, this returns the vote deposit. Prepares wallet approval work only. Mainnet-beta only.",
      inputSchema: {
        proposalAddress: z.string().min(32),
        beneficiaryAddress: z.string().min(32).optional().describe('Defaults to the wallet.'),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ proposalAddress, beneficiaryAddress, dueAt, note }) => traceTool(
      'solana_prepare_realms_relinquish_vote',
      { cluster: options.config.cluster, proposalAddress, beneficiaryAddress, dueAt },
      async () => jsonReply(
        await service.prepareRealmsRelinquishVote({
          proposalAddress,
          ...(beneficiaryAddress !== undefined && { beneficiaryAddress }),
          ...(dueAt !== undefined && { dueAt }),
          ...(note !== undefined && { note }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_prepare_realms_deposit_governance_tokens',
    {
      description:
        "Create a manual-approval inbox item that deposits community or council governance tokens into a Realms / SPL Governance realm. Refused if the mint is neither the realm's community nor council mint. Prepares wallet approval work only. Mainnet-beta only.",
      inputSchema: {
        realmAddress: z.string().min(32),
        governingTokenMint: z.string().min(32).describe('Must be the realm community or council mint.'),
        amount: z.string().min(1).describe('Human token amount.'),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ realmAddress, governingTokenMint, amount, dueAt, note }) => traceTool(
      'solana_prepare_realms_deposit_governance_tokens',
      { cluster: options.config.cluster, realmAddress, governingTokenMint, amount, dueAt },
      async () => jsonReply(
        await service.prepareRealmsDepositGovernanceTokens({
          realmAddress,
          governingTokenMint,
          amount,
          ...(dueAt !== undefined && { dueAt }),
          ...(note !== undefined && { note }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_prepare_realms_withdraw_governance_tokens',
    {
      description:
        "Create a manual-approval inbox item that withdraws community or council governance tokens from a Realms / SPL Governance realm. Refused when the wallet has outstanding proposals, unrelinquished votes, or a governance delegate set to a third party. Set withdrawAll: true to release the full deposit. Prepares wallet approval work only. Mainnet-beta only.",
      inputSchema: {
        realmAddress: z.string().min(32),
        governingTokenMint: z.string().min(32),
        amount: z.string().min(1).optional(),
        withdrawAll: z.boolean().optional(),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ realmAddress, governingTokenMint, amount, withdrawAll, dueAt, note }) => traceTool(
      'solana_prepare_realms_withdraw_governance_tokens',
      { cluster: options.config.cluster, realmAddress, governingTokenMint, amount, withdrawAll, dueAt },
      async () => jsonReply(
        await service.prepareRealmsWithdrawGovernanceTokens({
          realmAddress,
          governingTokenMint,
          ...(amount !== undefined && { amount }),
          ...(withdrawAll !== undefined && { withdrawAll }),
          ...(dueAt !== undefined && { dueAt }),
          ...(note !== undefined && { note }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_lulo_rates',
    {
      description:
        'Read Lulo Protected/Boost/Regular APY by mint. Returns rate rows with APY, deposit type, and TVL/liquidity facts where the Lulo API exposes them. Read-only. Mainnet-beta only.',
      inputSchema: {
        mintAddress: z.string().min(32).optional().describe('SPL token mint address. Leave blank for the full catalog.'),
        depositType: z.enum(['protected', 'boost', 'regular']).optional(),
      },
    },
    async ({ mintAddress, depositType }) => traceTool(
      'solana_lulo_rates',
      { cluster: options.config.cluster, mintAddress, depositType },
      async () => jsonReply(
        await service.luloRates({
          ...(mintAddress !== undefined && { mintAddress }),
          ...(depositType !== undefined && { depositType }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_lulo_pool_meta',
    {
      description:
        'Read Lulo pool metadata: program ids, supported deposit types, decimals when reported, and regular-withdrawal cooldown seconds. Read-only. Mainnet-beta only.',
      inputSchema: {
        mintAddress: z.string().min(32).optional(),
      },
    },
    async ({ mintAddress }) => traceTool(
      'solana_lulo_pool_meta',
      { cluster: options.config.cluster, mintAddress },
      async () => jsonReply(
        await service.luloPoolMeta({
          ...(mintAddress !== undefined && { mintAddress }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_lulo_wallet_balances',
    {
      description:
        'Read a wallet\'s Lulo deposit balances and pending withdrawals. If the Lulo API does not expose balances for the wallet, returns a structured balances_unavailable fact. Read-only. Mainnet-beta only.',
      inputSchema: {
        walletAddress: z.string().min(32).optional().describe('Defaults to the connected wallet.'),
      },
    },
    async ({ walletAddress }) => traceTool(
      'solana_lulo_wallet_balances',
      { cluster: options.config.cluster, walletAddress },
      async () => jsonReply(
        await service.luloWalletBalances({
          ...(walletAddress !== undefined && { walletAddress }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_prepare_lulo_deposit',
    {
      description:
        "Create a manual-approval inbox item that deposits a token into Lulo Protected, Boost, or Regular. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Natural-language synonyms: 'supply to Lulo', 'lend on Lulo', 'earn yield on Lulo Protected'. Mainnet-beta only.",
      inputSchema: {
        amount: z.string().min(1).describe('Human token amount (e.g. 10).'),
        mintAddress: z.string().min(32).describe('SPL token mint address.'),
        depositType: z.enum(['protected', 'boost', 'regular']).optional().describe('Defaults to protected.'),
        priorityFee: z.number().int().nonnegative().optional().describe('Optional micro-lamport priority fee.'),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ amount, mintAddress, depositType, priorityFee, dueAt, note }) => traceTool(
      'solana_prepare_lulo_deposit',
      { cluster: options.config.cluster, amount, mintAddress, depositType, priorityFee, dueAt },
      async () => jsonReply(
        await service.prepareLuloDeposit({
          amount,
          mintAddress,
          ...(depositType !== undefined && { depositType }),
          ...(priorityFee !== undefined && { priorityFee }),
          ...(dueAt !== undefined && { dueAt }),
          ...(note !== undefined && { note }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_prepare_lulo_withdraw',
    {
      description:
        "Create a manual-approval inbox item that initiates a Lulo Protected or Regular withdrawal. Regular withdrawals require a separate complete step after the cooldown. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Mainnet-beta only.",
      inputSchema: {
        mintAddress: z.string().min(32),
        withdrawType: z.enum(['protected', 'regular']).optional().describe('Defaults to protected.'),
        amount: z.string().min(1).optional().describe('Human token amount. Provide amount OR percentage, not both.'),
        percentage: z.number().int().min(1).max(100).optional().describe('Percentage of position to withdraw (defaults to 100 when amount is omitted).'),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ mintAddress, withdrawType, amount, percentage, dueAt, note }) => traceTool(
      'solana_prepare_lulo_withdraw',
      { cluster: options.config.cluster, mintAddress, withdrawType, amount, percentage, dueAt },
      async () => jsonReply(
        await service.prepareLuloWithdraw({
          mintAddress,
          ...(withdrawType !== undefined && { withdrawType }),
          ...(amount !== undefined && { amount }),
          ...(percentage !== undefined && { percentage }),
          ...(dueAt !== undefined && { dueAt }),
          ...(note !== undefined && { note }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_prepare_lulo_complete_withdraw',
    {
      description:
        'Create a manual-approval inbox item that completes a Lulo regular withdrawal once the cooldown has elapsed. Requires the withdrawalId returned from the initiating withdrawal. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Mainnet-beta only.',
      inputSchema: {
        mintAddress: z.string().min(32),
        withdrawalId: z.string().min(1).describe('Withdrawal id returned by Lulo when the regular withdraw was initiated.'),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ mintAddress, withdrawalId, dueAt, note }) => traceTool(
      'solana_prepare_lulo_complete_withdraw',
      { cluster: options.config.cluster, mintAddress, withdrawalId, dueAt },
      async () => jsonReply(
        await service.prepareLuloCompleteWithdraw({
          mintAddress,
          withdrawalId,
          ...(dueAt !== undefined && { dueAt }),
          ...(note !== undefined && { note }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_sanctum_lst_list',
    {
      description:
        'Read Sanctum LST catalog metadata, including mint, symbol, decimals, disabled status, and validator/pool metadata where the API exposes it. Read-only. Mainnet-beta only.',
      inputSchema: {
        includeDisabled: z.boolean().optional().describe('Include disabled LSTs. Defaults to false.'),
      },
    },
    async ({ includeDisabled }) => traceTool(
      'solana_sanctum_lst_list',
      { cluster: options.config.cluster, includeDisabled },
      async () => jsonReply(
        await service.sanctumLstList({
          ...(includeDisabled !== undefined && { includeDisabled }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_sanctum_lst_snapshot',
    {
      description:
        'Read one Sanctum LST snapshot by mint or symbol, with optional APY history rows. Read-only. Mainnet-beta only.',
      inputSchema: {
        lstMint: z.string().min(32).optional().describe('LST mint address.'),
        mintOrSymbol: z.string().min(2).optional().describe('LST mint or symbol, for example JitoSOL.'),
        includeApy: z.boolean().optional().describe('Include APY rows when the API exposes them.'),
        apyLimit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ lstMint, mintOrSymbol, includeApy, apyLimit }) => traceTool(
      'solana_sanctum_lst_snapshot',
      { cluster: options.config.cluster, lstMint, mintOrSymbol, includeApy },
      async () => jsonReply(
        await service.sanctumLstSnapshot({
          ...(lstMint !== undefined && { lstMint }),
          ...(mintOrSymbol !== undefined && { mintOrSymbol }),
          ...(includeApy !== undefined && { includeApy }),
          ...(apyLimit !== undefined && { apyLimit }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_sanctum_infinity_pool_snapshot',
    {
      description:
        'Read Sanctum Infinity pool metadata, supported program ids, INF mint, and optional LST composition. Read-only. Mainnet-beta only.',
      inputSchema: {
        includeComposition: z.boolean().optional().describe('Include LST composition from the Sanctum catalog.'),
      },
    },
    async ({ includeComposition }) => traceTool(
      'solana_sanctum_infinity_pool_snapshot',
      { cluster: options.config.cluster, includeComposition },
      async () => jsonReply(
        await service.sanctumInfinityPoolSnapshot({
          ...(includeComposition !== undefined && { includeComposition }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_sanctum_wallet_positions',
    {
      description:
        'Read the connected wallet or supplied wallet Sanctum LST and INF token positions from SPL Token and Token-2022 accounts. Read-only. Mainnet-beta only.',
      inputSchema: {
        walletAddress: z.string().min(32).optional().describe('Defaults to the connected wallet.'),
        includeSmallBalances: z.boolean().optional().describe('Include zero and tiny balances. Defaults to false.'),
      },
    },
    async ({ walletAddress, includeSmallBalances }) => traceTool(
      'solana_sanctum_wallet_positions',
      { cluster: options.config.cluster, walletAddress, includeSmallBalances },
      async () => jsonReply(
        await service.sanctumWalletPositions({
          ...(walletAddress !== undefined && { walletAddress }),
          ...(includeSmallBalances !== undefined && { includeSmallBalances }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_sanctum_quote',
    {
      description:
        'Preview a Sanctum Token Swap order for LST, SOL, and Infinity routes. Does not sign or submit. Mainnet-beta only.',
      inputSchema: {
        inputMint: z.string().min(32),
        outputMint: z.string().min(32),
        amount: z.string().min(1).describe('Human token amount, for example 0.25.'),
        slippageBps: z.number().int().min(0).max(10000).optional(),
      },
    },
    async ({ inputMint, outputMint, amount, slippageBps }) => traceTool(
      'solana_sanctum_quote',
      { cluster: options.config.cluster, inputMint, outputMint, amount, slippageBps },
      async () => jsonReply(
        await service.sanctumQuote({
          inputMint,
          outputMint,
          amount,
          ...(slippageBps !== undefined && { slippageBps }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_prepare_sanctum_swap_lst',
    {
      description:
        'Create a manual-approval inbox item that swaps one Sanctum-supported LST/SOL token into another through Sanctum Router/Infinity. Quote and transaction are refreshed at execution time. Prepares wallet approval work only. Mainnet-beta only.',
      inputSchema: {
        inputMint: z.string().min(32),
        outputMint: z.string().min(32),
        amount: z.string().min(1).describe('Human input-token amount.'),
        minOutputAmount: z.string().min(1).optional().describe('Minimum human output-token amount.'),
        maxFeeBps: z.number().int().min(0).max(1000).optional(),
        slippageBps: z.number().int().min(0).max(10000).optional(),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async (input) => traceTool(
      'solana_prepare_sanctum_swap_lst',
      { cluster: options.config.cluster, input },
      async () => jsonReply(await service.prepareSanctumSwapLst(input)),
    ),
  );

  server.registerTool(
    'solana_prepare_sanctum_add_infinity_liquidity',
    {
      description:
        'Create a manual-approval inbox item that deposits a Sanctum-supported LST/SOL token into Infinity for INF. Uses Sanctum Infinity sources only and refreshes at execution time. Prepares wallet approval work only. Mainnet-beta only.',
      inputSchema: {
        inputMint: z.string().min(32),
        amount: z.string().min(1).describe('Human input-token amount.'),
        minInfAmount: z.string().min(1).optional().describe('Minimum human INF amount.'),
        maxFeeBps: z.number().int().min(0).max(1000).optional(),
        slippageBps: z.number().int().min(0).max(10000).optional(),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async (input) => traceTool(
      'solana_prepare_sanctum_add_infinity_liquidity',
      { cluster: options.config.cluster, input },
      async () => jsonReply(await service.prepareSanctumAddInfinityLiquidity(input)),
    ),
  );

  server.registerTool(
    'solana_prepare_sanctum_remove_infinity_liquidity',
    {
      description:
        'Create a manual-approval inbox item that redeems INF into a Sanctum-supported LST/SOL token. Uses Sanctum Infinity sources only and refreshes at execution time. Prepares wallet approval work only. Mainnet-beta only.',
      inputSchema: {
        infAmount: z.string().min(1).describe('Human INF amount.'),
        outputMint: z.string().min(32),
        minOutputAmount: z.string().min(1).optional().describe('Minimum human output-token amount.'),
        maxFeeBps: z.number().int().min(0).max(1000).optional(),
        slippageBps: z.number().int().min(0).max(10000).optional(),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async (input) => traceTool(
      'solana_prepare_sanctum_remove_infinity_liquidity',
      { cluster: options.config.cluster, input },
      async () => jsonReply(await service.prepareSanctumRemoveInfinityLiquidity(input)),
    ),
  );

  server.registerTool(
    'solana_prepare_sanctum_stake_sol_to_lst',
    {
      description:
        'Create a manual-approval inbox item that stakes SOL into a Sanctum-supported LST through Router/Infinity. Quote and transaction are refreshed at execution time. Prepares wallet approval work only. Mainnet-beta only.',
      inputSchema: {
        lstMint: z.string().min(32),
        solAmount: z.string().min(1).describe('Human SOL amount.'),
        minLstAmount: z.string().min(1).optional().describe('Minimum human LST amount.'),
        maxFeeBps: z.number().int().min(0).max(1000).optional(),
        slippageBps: z.number().int().min(0).max(10000).optional(),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async (input) => traceTool(
      'solana_prepare_sanctum_stake_sol_to_lst',
      { cluster: options.config.cluster, input },
      async () => jsonReply(await service.prepareSanctumStakeSolToLst(input)),
    ),
  );

  server.registerTool(
    'solana_prepare_sanctum_unstake_lst_to_sol',
    {
      description:
        'Create a manual-approval inbox item that unstakes a Sanctum-supported LST into SOL through Router/Infinity. Delayed unstake routes are blocked unless allowDelayedUnstake is true. Prepares wallet approval work only. Mainnet-beta only.',
      inputSchema: {
        lstMint: z.string().min(32),
        lstAmount: z.string().min(1).describe('Human LST amount.'),
        minSolAmount: z.string().min(1).optional().describe('Minimum human SOL amount.'),
        maxFeeBps: z.number().int().min(0).max(1000).optional(),
        slippageBps: z.number().int().min(0).max(10000).optional(),
        allowDelayedUnstake: z.boolean().optional().describe('Defaults to false; true accepts routes that mention a delayed stake-account unstake path.'),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async (input) => traceTool(
      'solana_prepare_sanctum_unstake_lst_to_sol',
      { cluster: options.config.cluster, input },
      async () => jsonReply(await service.prepareSanctumUnstakeLstToSol(input)),
    ),
  );

  server.registerTool(
    'solana_magiceden_api_health',
    {
      description:
        'Probe Magic Eden Solana API health for reads and trading endpoints. Returns operational flags, rate-limit info, and the active API transition warning. Read-only. Mainnet-beta only.',
      inputSchema: {
        includeTradingEndpoints: z.boolean().optional().describe('Defaults to true. Set false to skip the trading endpoint probe.'),
      },
    },
    async ({ includeTradingEndpoints }) => traceTool(
      'solana_magiceden_api_health',
      { cluster: options.config.cluster, includeTradingEndpoints },
      async () => jsonReply(
        await service.magicedenApiHealth({
          ...(includeTradingEndpoints !== undefined && { includeTradingEndpoints }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_magiceden_collection_snapshot',
    {
      description:
        'Read a Magic Eden Solana collection snapshot: floor, listed count, top bid, royalty, plus optional active listings and bids. Read-only. Mainnet-beta only.',
      inputSchema: {
        collectionSymbol: z.string().min(1).optional(),
        collectionId: z.string().min(1).optional(),
        includeListings: z.boolean().optional(),
        includeBids: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ collectionSymbol, collectionId, includeListings, includeBids, limit }) => traceTool(
      'solana_magiceden_collection_snapshot',
      { cluster: options.config.cluster, collectionSymbol, collectionId, limit },
      async () => jsonReply(
        await service.magicedenCollectionSnapshot({
          ...(collectionSymbol !== undefined && { collectionSymbol }),
          ...(collectionId !== undefined && { collectionId }),
          ...(includeListings !== undefined && { includeListings }),
          ...(includeBids !== undefined && { includeBids }),
          ...(limit !== undefined && { limit }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_magiceden_collection_listings',
    {
      description:
        'Read active Magic Eden listings for a Solana collection (rows with price, seller, listing id). Read-only. Mainnet-beta only.',
      inputSchema: {
        collectionSymbol: z.string().min(1).optional(),
        collectionId: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ collectionSymbol, collectionId, limit }) => traceTool(
      'solana_magiceden_collection_listings',
      { cluster: options.config.cluster, collectionSymbol, collectionId, limit },
      async () => jsonReply(
        await service.magicedenCollectionListings({
          ...(collectionSymbol !== undefined && { collectionSymbol }),
          ...(collectionId !== undefined && { collectionId }),
          ...(limit !== undefined && { limit }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_magiceden_collection_bids',
    {
      description:
        'Read active Magic Eden bids for a Solana collection. Read-only. Mainnet-beta only.',
      inputSchema: {
        collectionSymbol: z.string().min(1).optional(),
        collectionId: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ collectionSymbol, collectionId, limit }) => traceTool(
      'solana_magiceden_collection_bids',
      { cluster: options.config.cluster, collectionSymbol, collectionId, limit },
      async () => jsonReply(
        await service.magicedenCollectionBids({
          ...(collectionSymbol !== undefined && { collectionSymbol }),
          ...(collectionId !== undefined && { collectionId }),
          ...(limit !== undefined && { limit }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_magiceden_recent_activity',
    {
      description:
        'Read recent Magic Eden activity (list, buy, bid, transfer) for a Solana collection. Read-only. Mainnet-beta only.',
      inputSchema: {
        collectionSymbol: z.string().min(1).optional(),
        collectionId: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ collectionSymbol, collectionId, limit }) => traceTool(
      'solana_magiceden_recent_activity',
      { cluster: options.config.cluster, collectionSymbol, collectionId, limit },
      async () => jsonReply(
        await service.magicedenRecentActivity({
          ...(collectionSymbol !== undefined && { collectionSymbol }),
          ...(collectionId !== undefined && { collectionId }),
          ...(limit !== undefined && { limit }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_magiceden_wallet_nfts',
    {
      description:
        'Read a wallet\'s Magic Eden Solana NFTs and listed exposure. Defaults to the connected wallet. Read-only. Mainnet-beta only.',
      inputSchema: {
        walletAddress: z.string().min(32).optional(),
        collectionSymbol: z.string().min(1).optional(),
        collectionId: z.string().min(1).optional(),
        listedOnly: z.boolean().optional(),
      },
    },
    async ({ walletAddress, collectionSymbol, collectionId, listedOnly }) => traceTool(
      'solana_magiceden_wallet_nfts',
      { cluster: options.config.cluster, walletAddress, collectionSymbol, listedOnly },
      async () => jsonReply(
        await service.magicedenWalletNfts({
          ...(walletAddress !== undefined && { walletAddress }),
          ...(collectionSymbol !== undefined && { collectionSymbol }),
          ...(collectionId !== undefined && { collectionId }),
          ...(listedOnly !== undefined && { listedOnly }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_magiceden_nft_detail',
    {
      description:
        'Read a Magic Eden Solana NFT detail by mint: ownership, collection, current listing, top bid, last sale, royalty. Read-only. Mainnet-beta only.',
      inputSchema: {
        mintAddress: z.string().min(32),
        includeListing: z.boolean().optional(),
        includeBids: z.boolean().optional(),
      },
    },
    async ({ mintAddress, includeListing, includeBids }) => traceTool(
      'solana_magiceden_nft_detail',
      { cluster: options.config.cluster, mintAddress },
      async () => jsonReply(
        await service.magicedenNftDetail({
          mintAddress,
          ...(includeListing !== undefined && { includeListing }),
          ...(includeBids !== undefined && { includeBids }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_prepare_magiceden_buy',
    {
      description:
        'Create a manual-approval inbox item that buys a Magic Eden Solana listing for at most maxPriceSol. Refuses if the listing price, seller, or id changes before signing. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Mainnet-beta only.',
      inputSchema: {
        mintAddress: z.string().min(32),
        maxPriceSol: z.string().min(1).describe('Maximum acceptable buy price in SOL (decimal string).'),
        collectionSymbol: z.string().min(1).optional(),
        collectionId: z.string().min(1).optional(),
        expectedSeller: z.string().min(32).optional(),
        expectedListingId: z.string().min(1).optional(),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ mintAddress, maxPriceSol, collectionSymbol, collectionId, expectedSeller, expectedListingId, dueAt, note }) => traceTool(
      'solana_prepare_magiceden_buy',
      { cluster: options.config.cluster, mintAddress, maxPriceSol, collectionSymbol, dueAt },
      async () => jsonReply(
        await service.prepareMagicedenBuy({
          mintAddress,
          maxPriceSol,
          ...(collectionSymbol !== undefined && { collectionSymbol }),
          ...(collectionId !== undefined && { collectionId }),
          ...(expectedSeller !== undefined && { expectedSeller }),
          ...(expectedListingId !== undefined && { expectedListingId }),
          ...(dueAt !== undefined && { dueAt }),
          ...(note !== undefined && { note }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_prepare_magiceden_list',
    {
      description:
        'Create a manual-approval inbox item that lists an owned NFT on Magic Eden Solana at priceSol. Refuses if the wallet does not own the mint. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Mainnet-beta only.',
      inputSchema: {
        mintAddress: z.string().min(32),
        priceSol: z.string().min(1).describe('List price in SOL (decimal string).'),
        expiresAt: z.string().datetime().optional(),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ mintAddress, priceSol, expiresAt, dueAt, note }) => traceTool(
      'solana_prepare_magiceden_list',
      { cluster: options.config.cluster, mintAddress, priceSol, dueAt },
      async () => jsonReply(
        await service.prepareMagicedenList({
          mintAddress,
          priceSol,
          ...(expiresAt !== undefined && { expiresAt }),
          ...(dueAt !== undefined && { dueAt }),
          ...(note !== undefined && { note }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_prepare_magiceden_cancel_listing',
    {
      description:
        'Create a manual-approval inbox item that cancels the connected wallet\'s active Magic Eden listing for a given mint. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Mainnet-beta only.',
      inputSchema: {
        mintAddress: z.string().min(32),
        listingId: z.string().min(1).optional(),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ mintAddress, listingId, dueAt, note }) => traceTool(
      'solana_prepare_magiceden_cancel_listing',
      { cluster: options.config.cluster, mintAddress, listingId, dueAt },
      async () => jsonReply(
        await service.prepareMagicedenCancelListing({
          mintAddress,
          ...(listingId !== undefined && { listingId }),
          ...(dueAt !== undefined && { dueAt }),
          ...(note !== undefined && { note }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_prepare_magiceden_bid',
    {
      description:
        'Create a manual-approval inbox item that places a Magic Eden bid (item or collection) at bidPriceSol, capped by maxEscrowSol. Refuses if required escrow exceeds the cap. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Mainnet-beta only.',
      inputSchema: {
        bidPriceSol: z.string().min(1).describe('Bid price in SOL (decimal string).'),
        maxEscrowSol: z.string().min(1).describe('Maximum SOL the wallet may lock in escrow for this bid.'),
        mintAddress: z.string().min(32).optional().describe('Provide for an item bid. Omit for collection-wide bids.'),
        collectionSymbol: z.string().min(1).optional(),
        collectionId: z.string().min(1).optional(),
        quantity: z.number().int().positive().optional(),
        expiresAt: z.string().datetime().optional(),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ bidPriceSol, maxEscrowSol, mintAddress, collectionSymbol, collectionId, quantity, expiresAt, dueAt, note }) => traceTool(
      'solana_prepare_magiceden_bid',
      { cluster: options.config.cluster, bidPriceSol, maxEscrowSol, mintAddress, collectionSymbol, dueAt },
      async () => jsonReply(
        await service.prepareMagicedenBid({
          bidPriceSol,
          maxEscrowSol,
          ...(mintAddress !== undefined && { mintAddress }),
          ...(collectionSymbol !== undefined && { collectionSymbol }),
          ...(collectionId !== undefined && { collectionId }),
          ...(quantity !== undefined && { quantity }),
          ...(expiresAt !== undefined && { expiresAt }),
          ...(dueAt !== undefined && { dueAt }),
          ...(note !== undefined && { note }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_prepare_magiceden_cancel_bid',
    {
      description:
        'Create a manual-approval inbox item that cancels a Magic Eden bid by id, mint, or collection. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Mainnet-beta only.',
      inputSchema: {
        bidId: z.string().min(1).optional(),
        mintAddress: z.string().min(32).optional(),
        collectionSymbol: z.string().min(1).optional(),
        collectionId: z.string().min(1).optional(),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ bidId, mintAddress, collectionSymbol, collectionId, dueAt, note }) => traceTool(
      'solana_prepare_magiceden_cancel_bid',
      { cluster: options.config.cluster, bidId, mintAddress, collectionSymbol, dueAt },
      async () => jsonReply(
        await service.prepareMagicedenCancelBid({
          ...(bidId !== undefined && { bidId }),
          ...(mintAddress !== undefined && { mintAddress }),
          ...(collectionSymbol !== undefined && { collectionSymbol }),
          ...(collectionId !== undefined && { collectionId }),
          ...(dueAt !== undefined && { dueAt }),
          ...(note !== undefined && { note }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_tensor_collection_snapshot',
    {
      description:
        'Read a Tensor NFT collection snapshot: floor price, listed count, top bid, 24h volume, verification, and optional top listings and bids. Read-only. Mainnet-beta only.',
      inputSchema: {
        collectionId: z.string().min(1).describe('Tensor collection id, slug, or verified collection mint.'),
        includeListings: z.boolean().optional(),
        includeBids: z.boolean().optional(),
        maxListings: z.number().int().positive().max(50).optional(),
        maxBids: z.number().int().positive().max(50).optional(),
      },
    },
    async ({ collectionId, includeListings, includeBids, maxListings, maxBids }) => traceTool(
      'solana_tensor_collection_snapshot',
      { cluster: options.config.cluster, collectionId },
      async () => jsonReply(
        await service.tensorCollectionSnapshot({
          collectionId,
          ...(includeListings !== undefined && { includeListings }),
          ...(includeBids !== undefined && { includeBids }),
          ...(maxListings !== undefined && { maxListings }),
          ...(maxBids !== undefined && { maxBids }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_tensor_collection_listings',
    {
      description: 'Read Tensor cheapest listings for a collection. Read-only. Mainnet-beta only.',
      inputSchema: {
        collectionId: z.string().min(1),
        limit: z.number().int().positive().max(50).optional(),
      },
    },
    async ({ collectionId, limit }) => traceTool(
      'solana_tensor_collection_listings',
      { cluster: options.config.cluster, collectionId, limit },
      async () => jsonReply(
        await service.tensorCollectionListings({
          collectionId,
          ...(limit !== undefined && { limit }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_tensor_collection_bids',
    {
      description: 'Read Tensor top bids for a collection. Read-only. Mainnet-beta only.',
      inputSchema: {
        collectionId: z.string().min(1),
        limit: z.number().int().positive().max(50).optional(),
      },
    },
    async ({ collectionId, limit }) => traceTool(
      'solana_tensor_collection_bids',
      { cluster: options.config.cluster, collectionId, limit },
      async () => jsonReply(
        await service.tensorCollectionBids({
          collectionId,
          ...(limit !== undefined && { limit }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_tensor_recent_sales',
    {
      description: 'Read recent Tensor marketplace sales for a collection. Read-only. Mainnet-beta only.',
      inputSchema: {
        collectionId: z.string().min(1),
        limit: z.number().int().positive().max(100).optional(),
      },
    },
    async ({ collectionId, limit }) => traceTool(
      'solana_tensor_recent_sales',
      { cluster: options.config.cluster, collectionId, limit },
      async () => jsonReply(
        await service.tensorRecentSales({
          collectionId,
          ...(limit !== undefined && { limit }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_tensor_wallet_nfts',
    {
      description: 'List Tensor-tracked NFTs owned by a wallet, including listed status and compressed flag. Read-only. Mainnet-beta only.',
      inputSchema: {
        walletAddress: z.string().min(32).optional().describe('Defaults to the connected wallet.'),
        collectionId: z.string().min(1).optional(),
        includeCompressed: z.boolean().optional(),
      },
    },
    async ({ walletAddress, collectionId, includeCompressed }) => traceTool(
      'solana_tensor_wallet_nfts',
      { cluster: options.config.cluster, walletAddress, collectionId },
      async () => jsonReply(
        await service.tensorWalletNfts({
          ...(walletAddress !== undefined && { walletAddress }),
          ...(collectionId !== undefined && { collectionId }),
          ...(includeCompressed !== undefined && { includeCompressed }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_tensor_nft_detail',
    {
      description: 'Read one Tensor NFT detail by mint address or compressed asset id, including listing, top bids, and warnings. Read-only. Mainnet-beta only.',
      inputSchema: {
        mintAddress: z.string().min(32).optional(),
        assetId: z.string().min(32).optional(),
      },
    },
    async ({ mintAddress, assetId }) => traceTool(
      'solana_tensor_nft_detail',
      { cluster: options.config.cluster, mintAddress, assetId },
      async () => jsonReply(
        await service.tensorNftDetail({
          ...(mintAddress !== undefined && { mintAddress }),
          ...(assetId !== undefined && { assetId }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_tensor_wallet_marketplace_exposure',
    {
      description: 'Read a wallet\'s Tensor marketplace exposure: owned collections, open listings, open bids, and margin escrow balance. Read-only. Mainnet-beta only.',
      inputSchema: {
        walletAddress: z.string().min(32).optional().describe('Defaults to the connected wallet.'),
      },
    },
    async ({ walletAddress }) => traceTool(
      'solana_tensor_wallet_marketplace_exposure',
      { cluster: options.config.cluster, walletAddress },
      async () => jsonReply(
        await service.tensorWalletMarketplaceExposure({
          ...(walletAddress !== undefined && { walletAddress }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_prepare_tensor_buy',
    {
      description:
        'Create a manual-approval inbox item that buys a Tensor NFT at or below maxPriceSol. Refreshes listing state and rebuilds the transaction at execution time. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Mainnet-beta only.',
      inputSchema: {
        mintAddress: z.string().min(32).optional(),
        assetId: z.string().min(32).optional(),
        collectionId: z.string().min(1).optional(),
        maxPriceSol: z.string().min(1),
        expectedSeller: z.string().min(32).optional(),
        expectedMarketplace: z.enum(['tensor', 'any_tensor_supported']).optional(),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ mintAddress, assetId, collectionId, maxPriceSol, expectedSeller, expectedMarketplace, dueAt, note }) => traceTool(
      'solana_prepare_tensor_buy',
      { cluster: options.config.cluster, mintAddress, assetId, maxPriceSol, dueAt },
      async () => jsonReply(
        await service.prepareTensorBuy({
          ...(mintAddress !== undefined && { mintAddress }),
          ...(assetId !== undefined && { assetId }),
          ...(collectionId !== undefined && { collectionId }),
          maxPriceSol,
          ...(expectedSeller !== undefined && { expectedSeller }),
          ...(expectedMarketplace !== undefined && { expectedMarketplace }),
          ...(dueAt !== undefined && { dueAt }),
          ...(note !== undefined && { note }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_prepare_tensor_list',
    {
      description:
        'Create a manual-approval inbox item that lists a Tensor NFT for priceSol. Validates wallet ownership at prepare and at execute. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Mainnet-beta only.',
      inputSchema: {
        mintAddress: z.string().min(32).optional(),
        assetId: z.string().min(32).optional(),
        priceSol: z.string().min(1),
        expiresAt: z.string().datetime().optional(),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ mintAddress, assetId, priceSol, expiresAt, dueAt, note }) => traceTool(
      'solana_prepare_tensor_list',
      { cluster: options.config.cluster, mintAddress, assetId, priceSol, dueAt },
      async () => jsonReply(
        await service.prepareTensorList({
          ...(mintAddress !== undefined && { mintAddress }),
          ...(assetId !== undefined && { assetId }),
          priceSol,
          ...(expiresAt !== undefined && { expiresAt }),
          ...(dueAt !== undefined && { dueAt }),
          ...(note !== undefined && { note }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_prepare_tensor_cancel_listing',
    {
      description:
        'Create a manual-approval inbox item that cancels a Tensor listing. Pass listingId when multiple open listings exist. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Mainnet-beta only.',
      inputSchema: {
        mintAddress: z.string().min(32).optional(),
        assetId: z.string().min(32).optional(),
        listingId: z.string().min(1).optional(),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ mintAddress, assetId, listingId, dueAt, note }) => traceTool(
      'solana_prepare_tensor_cancel_listing',
      { cluster: options.config.cluster, mintAddress, assetId, listingId, dueAt },
      async () => jsonReply(
        await service.prepareTensorCancelListing({
          ...(mintAddress !== undefined && { mintAddress }),
          ...(assetId !== undefined && { assetId }),
          ...(listingId !== undefined && { listingId }),
          ...(dueAt !== undefined && { dueAt }),
          ...(note !== undefined && { note }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_prepare_tensor_bid',
    {
      description:
        'Create a manual-approval inbox item for a Tensor item or collection bid. Enforces maxEscrowSol cap against existing margin plus delta. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Mainnet-beta only.',
      inputSchema: {
        collectionId: z.string().min(1),
        mintAddress: z.string().min(32).optional().describe('Provide for an item bid; omit for collection bids.'),
        assetId: z.string().min(32).optional(),
        bidPriceSol: z.string().min(1),
        quantity: z.number().int().positive().optional(),
        expiresAt: z.string().datetime().optional(),
        maxEscrowSol: z.string().min(1),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ collectionId, mintAddress, assetId, bidPriceSol, quantity, expiresAt, maxEscrowSol, dueAt, note }) => traceTool(
      'solana_prepare_tensor_bid',
      { cluster: options.config.cluster, collectionId, bidPriceSol, maxEscrowSol, dueAt },
      async () => jsonReply(
        await service.prepareTensorBid({
          collectionId,
          ...(mintAddress !== undefined && { mintAddress }),
          ...(assetId !== undefined && { assetId }),
          bidPriceSol,
          ...(quantity !== undefined && { quantity }),
          ...(expiresAt !== undefined && { expiresAt }),
          maxEscrowSol,
          ...(dueAt !== undefined && { dueAt }),
          ...(note !== undefined && { note }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_prepare_tensor_cancel_bid',
    {
      description:
        'Create a manual-approval inbox item that cancels a Tensor bid by bidId. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Mainnet-beta only.',
      inputSchema: {
        bidId: z.string().min(1).optional(),
        collectionId: z.string().min(1).optional(),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ bidId, collectionId, dueAt, note }) => traceTool(
      'solana_prepare_tensor_cancel_bid',
      { cluster: options.config.cluster, bidId, collectionId, dueAt },
      async () => jsonReply(
        await service.prepareTensorCancelBid({
          ...(bidId !== undefined && { bidId }),
          ...(collectionId !== undefined && { collectionId }),
          ...(dueAt !== undefined && { dueAt }),
          ...(note !== undefined && { note }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_prepare_tensor_sweep',
    {
      description:
        'Create a manual-approval inbox item that sweeps up to ten Tensor listings under per-item and total SOL caps. Stores exact items; execution refreshes each listing and blocks changed price or compressed flag. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Mainnet-beta only.',
      inputSchema: {
        collectionId: z.string().min(32),
        maxItems: z.number().int().positive().max(10),
        maxTotalSol: z.string().min(1),
        maxPricePerItemSol: z.string().min(1),
        requiredMintAddresses: z.array(z.string().min(32)).optional(),
        excludeMintAddresses: z.array(z.string().min(32)).optional(),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ collectionId, maxItems, maxTotalSol, maxPricePerItemSol, requiredMintAddresses, excludeMintAddresses, dueAt, note }) => traceTool(
      'solana_prepare_tensor_sweep',
      { cluster: options.config.cluster, collectionId, maxItems, maxTotalSol, dueAt },
      async () => jsonReply(
        await service.prepareTensorSweep({
          collectionId,
          maxItems,
          maxTotalSol,
          maxPricePerItemSol,
          ...(requiredMintAddresses !== undefined && { requiredMintAddresses }),
          ...(excludeMintAddresses !== undefined && { excludeMintAddresses }),
          ...(dueAt !== undefined && { dueAt }),
          ...(note !== undefined && { note }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_pyth_price_feed',
    {
      description:
        'Read a Pyth price feed via the public Hermes API. Returns price, confidence, exponent, publish time, and freshness status. Provide priceFeedId (hex) or symbol (for example SOL/USD). Read-only. Mainnet-beta only.',
      inputSchema: {
        priceFeedId: z.string().min(1).optional().describe('Hex price feed id (with or without 0x prefix). Overrides symbol when provided.'),
        symbol: z.string().min(1).optional().describe('Common symbol like SOL/USD; resolved against the built-in alias list and then Hermes search.'),
        maxAgeSeconds: z.number().int().positive().optional().describe('Maximum staleness before status flips to "stale". Defaults to 60s.'),
        includeEma: z.boolean().optional().describe('Include EMA price/confidence in the snapshot. Defaults to true.'),
      },
    },
    async ({ priceFeedId, symbol, maxAgeSeconds, includeEma }) => traceTool(
      'solana_pyth_price_feed',
      { cluster: options.config.cluster, priceFeedId, symbol, maxAgeSeconds },
      async () => jsonReply(
        await service.pythPriceFeed({
          ...(priceFeedId !== undefined && { priceFeedId }),
          ...(symbol !== undefined && { symbol }),
          ...(maxAgeSeconds !== undefined && { maxAgeSeconds }),
          ...(includeEma !== undefined && { includeEma }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_pyth_price_feeds_batch',
    {
      description:
        'Read multiple Pyth price feeds in one Hermes request. Returns per-feed status (fresh, stale, missing) and totals. Up to 32 feed ids per call. Read-only. Mainnet-beta only.',
      inputSchema: {
        priceFeedIds: z.array(z.string().min(1)).min(1).max(32).describe('Array of hex price feed ids.'),
        maxAgeSeconds: z.number().int().positive().optional().describe('Maximum staleness before per-feed status flips to "stale". Defaults to 60s.'),
        includeEma: z.boolean().optional().describe('Include EMA values per feed. Defaults to true.'),
      },
    },
    async ({ priceFeedIds, maxAgeSeconds, includeEma }) => traceTool(
      'solana_pyth_price_feeds_batch',
      { cluster: options.config.cluster, count: priceFeedIds.length, maxAgeSeconds },
      async () => jsonReply(
        await service.pythPriceFeedsBatch({
          priceFeedIds,
          ...(maxAgeSeconds !== undefined && { maxAgeSeconds }),
          ...(includeEma !== undefined && { includeEma }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_pyth_feed_search',
    {
      description:
        'Search Pyth price-feed metadata by symbol or substring. Returns up to 50 matches with feed id, symbol, description, asset type, base, and quote currency. Read-only. Mainnet-beta only.',
      inputSchema: {
        query: z.string().min(1).describe('Search string, for example SOL or jitosol.'),
        assetType: z.enum(['crypto', 'equity', 'fx', 'commodity', 'all']).optional().describe('Filter by asset type. Defaults to crypto.'),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum results to return (default 20).'),
      },
    },
    async ({ query, assetType, limit }) => traceTool(
      'solana_pyth_feed_search',
      { cluster: options.config.cluster, query, assetType, limit },
      async () => jsonReply(
        await service.pythFeedSearch({
          query,
          ...(assetType !== undefined && { assetType }),
          ...(limit !== undefined && { limit }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_pyth_onchain_price_account',
    {
      description:
        'Read the Solana price-update account derived from a Pyth feed id. Returns existence, owner program, lamports, and optional base64 account data. Requires @pythnetwork/pyth-solana-receiver to be installed; otherwise reports sdk_missing without touching the RPC. Read-only. Mainnet-beta only.',
      inputSchema: {
        priceFeedId: z.string().min(1).optional().describe('Hex price feed id. Provide priceFeedId or symbol.'),
        symbol: z.string().min(1).optional().describe('Common symbol resolved through the alias map.'),
        includeRawAccount: z.boolean().optional().describe('Include the raw base64 account data. Defaults to false.'),
      },
    },
    async ({ priceFeedId, symbol, includeRawAccount }) => traceTool(
      'solana_pyth_onchain_price_account',
      { cluster: options.config.cluster, priceFeedId, symbol, includeRawAccount },
      async () => jsonReply(
        await service.pythOnchainPriceAccount({
          ...(priceFeedId !== undefined && { priceFeedId }),
          ...(symbol !== undefined && { symbol }),
          ...(includeRawAccount !== undefined && { includeRawAccount }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_pyth_oracle_evidence',
    {
      description:
        'Summarize Pyth oracle evidence (fresh, stale, wide_confidence, missing, api_unavailable) for downstream protocol planners. Read-only. Mainnet-beta only.',
      inputSchema: {
        priceFeedId: z.string().min(1).optional().describe('Hex price feed id. Provide priceFeedId or symbol.'),
        symbol: z.string().min(1).optional().describe('Common symbol resolved through the alias map.'),
        consumerProtocol: z.string().min(1).optional().describe('Optional protocol label included only as evidence metadata.'),
        maxAgeSeconds: z.number().int().positive().optional().describe('Max age before status flips to "stale". Defaults to 60s.'),
        maxConfidenceBps: z.number().int().positive().optional().describe('Max confidence (in bps) before status flips to "wide_confidence". Defaults to 200 bps.'),
      },
    },
    async ({ priceFeedId, symbol, consumerProtocol, maxAgeSeconds, maxConfidenceBps }) => traceTool(
      'solana_pyth_oracle_evidence',
      { cluster: options.config.cluster, priceFeedId, symbol, consumerProtocol, maxAgeSeconds, maxConfidenceBps },
      async () => jsonReply(
        await service.pythOracleEvidence({
          ...(priceFeedId !== undefined && { priceFeedId }),
          ...(symbol !== undefined && { symbol }),
          ...(consumerProtocol !== undefined && { consumerProtocol }),
          ...(maxAgeSeconds !== undefined && { maxAgeSeconds }),
          ...(maxConfidenceBps !== undefined && { maxConfidenceBps }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_prepare_pyth_post_price_update',
    {
      description:
        "Create a manual-approval inbox item that posts a fresh Pyth price update on Solana via the Pyth Solana Receiver program. V1 supports up to two feed ids per transaction and refuses requests that would require multiple transactions. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Mainnet-beta only.",
      inputSchema: {
        priceFeedIds: z.array(z.string().min(1)).min(1).max(2).describe('Hex price feed ids (max 2 for v1).'),
        maxAgeSeconds: z.number().int().positive().optional().describe('Reject feeds older than this at prepare time. Defaults to 60s.'),
        payerAddress: z.string().min(32).optional().describe('Optional payer address. Defaults to the connected wallet.'),
        closeUpdateAccounts: z.boolean().optional().describe('Close ephemeral update accounts at the end of the tx to recover rent. Defaults to true.'),
        computeUnitPriceMicroLamports: z.number().int().nonnegative().optional().describe('Optional priority fee in micro-lamports.'),
        consumerTransactionId: z.string().min(1).optional().describe('Optional local reference for a downstream prepared action that consumes this update.'),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ priceFeedIds, maxAgeSeconds, payerAddress, closeUpdateAccounts, computeUnitPriceMicroLamports, consumerTransactionId, dueAt, note }) => traceTool(
      'solana_prepare_pyth_post_price_update',
      { cluster: options.config.cluster, priceFeedIds, maxAgeSeconds, payerAddress, closeUpdateAccounts },
      async () => jsonReply(
        await service.preparePythPostPriceUpdate({
          priceFeedIds,
          ...(maxAgeSeconds !== undefined && { maxAgeSeconds }),
          ...(payerAddress !== undefined && { payerAddress }),
          ...(closeUpdateAccounts !== undefined && { closeUpdateAccounts }),
          ...(computeUnitPriceMicroLamports !== undefined && { computeUnitPriceMicroLamports }),
          ...(consumerTransactionId !== undefined && { consumerTransactionId }),
          ...(dueAt !== undefined && { dueAt }),
          ...(note !== undefined && { note }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_save_reserve_snapshot',
    {
      description:
        'Read a Save (Solend) Lend reserve snapshot: supply APY, borrow APY, utilization, collateral factor, liquidation threshold, deposit/borrow caps, and liquidity. Read-only. Mainnet-beta only.',
      inputSchema: {
        token: z.string().min(2).optional().describe('Reserve symbol (SOL, USDC, USDT).'),
        reserveMint: z.string().min(32).optional().describe('Reserve mint address (overrides token).'),
        marketAddress: z.string().min(32).optional().describe('Optional market address. Defaults to the Save main market.'),
      },
    },
    async ({ token, reserveMint, marketAddress }) => traceTool(
      'solana_save_reserve_snapshot',
      { cluster: options.config.cluster, token, reserveMint, marketAddress },
      async () => jsonReply(
        await service.saveReserveSnapshot({
          ...(token !== undefined && { token }),
          ...(reserveMint !== undefined && { reserveMint }),
          ...(marketAddress !== undefined && { marketAddress }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_save_market_snapshot',
    {
      description:
        'Read a Save (Solend) market snapshot: program id, reserve count, total deposits and borrows, and per-reserve APY/utilization. Read-only. Mainnet-beta only.',
      inputSchema: {
        marketAddress: z.string().min(32).optional().describe('Optional market address. Defaults to the Save main market.'),
      },
    },
    async ({ marketAddress }) => traceTool(
      'solana_save_market_snapshot',
      { cluster: options.config.cluster, marketAddress },
      async () => jsonReply(
        await service.saveMarketSnapshot({
          ...(marketAddress !== undefined && { marketAddress }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_save_wallet_obligation',
    {
      description:
        'Read the connected wallet (or another address) Save obligation: supplied and borrowed reserves, total deposit/borrow value, borrow limit, liquidation threshold, and health factor. Returns null when no obligation exists. Read-only. Mainnet-beta only.',
      inputSchema: {
        walletAddress: z.string().min(32).optional().describe('Defaults to the connected wallet.'),
        marketAddress: z.string().min(32).optional().describe('Optional market address. Defaults to the Save main market.'),
      },
    },
    async ({ walletAddress, marketAddress }) => traceTool(
      'solana_save_wallet_obligation',
      { cluster: options.config.cluster, walletAddress, marketAddress },
      async () => jsonReply(
        await service.saveWalletObligation({
          ...(walletAddress !== undefined && { walletAddress }),
          ...(marketAddress !== undefined && { marketAddress }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_save_health_preview',
    {
      description:
        'Preview the projected Save obligation health factor for a hypothetical deposit, withdraw, borrow, or repay, including breaches against the configured minimum health factor (default 1.10). Read-only. Mainnet-beta only.',
      inputSchema: {
        operation: z.enum(['deposit', 'withdraw', 'borrow', 'repay']),
        amount: z.string().min(1).describe('Human token amount, for example 10.'),
        token: z.string().min(2).optional(),
        reserveMint: z.string().min(32).optional(),
        marketAddress: z.string().min(32).optional(),
        walletAddress: z.string().min(32).optional(),
        minHealthFactor: z.number().min(1).optional(),
      },
    },
    async ({ operation, amount, token, reserveMint, marketAddress, walletAddress, minHealthFactor }) => traceTool(
      'solana_save_health_preview',
      { cluster: options.config.cluster, operation, amount, token, reserveMint, marketAddress, walletAddress },
      async () => jsonReply(
        await service.saveHealthPreview({
          operation,
          amount,
          ...(token !== undefined && { token }),
          ...(reserveMint !== undefined && { reserveMint }),
          ...(marketAddress !== undefined && { marketAddress }),
          ...(walletAddress !== undefined && { walletAddress }),
          ...(minHealthFactor !== undefined && { minHealthFactor }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_prepare_save_deposit',
    {
      description:
        "Create a manual-approval inbox item that deposits a token into a Save (Solend) Lend reserve. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Mainnet-beta only.",
      inputSchema: {
        amount: z.string().min(1).describe('Human token amount, for example 10.'),
        token: z.string().min(2).optional().describe('SOL, USDC, USDT, or a known reserve symbol.'),
        reserveMint: z.string().min(32).optional().describe('Reserve mint address (overrides token).'),
        marketAddress: z.string().min(32).optional(),
        depositCollateral: z.boolean().optional().describe('Whether to deposit as collateral (defaults to true).'),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ amount, token, reserveMint, marketAddress, depositCollateral, dueAt, note }) => traceTool(
      'solana_prepare_save_deposit',
      { cluster: options.config.cluster, amount, token, reserveMint, marketAddress, depositCollateral, dueAt },
      async () => jsonReply(
        await service.prepareSaveDeposit({
          amount,
          ...(token !== undefined && { token }),
          ...(reserveMint !== undefined && { reserveMint }),
          ...(marketAddress !== undefined && { marketAddress }),
          ...(depositCollateral !== undefined && { depositCollateral }),
          ...(dueAt !== undefined && { dueAt }),
          ...(note !== undefined && { note }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_prepare_save_withdraw',
    {
      description:
        "Create a manual-approval inbox item that withdraws supplied tokens from a Save Lend reserve. Refuses to execute if projected obligation health factor breaches the configured minimum (default 1.10). Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Mainnet-beta only.",
      inputSchema: {
        amount: z.string().min(1).optional().describe("Human token amount. Pass 'all' or set withdrawAll to true to redeem the full position."),
        withdrawAll: z.boolean().optional(),
        token: z.string().min(2).optional(),
        reserveMint: z.string().min(32).optional(),
        marketAddress: z.string().min(32).optional(),
        minHealthFactor: z.number().min(1).optional().describe('Minimum projected health factor; defaults to 1.10.'),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ amount, withdrawAll, token, reserveMint, marketAddress, minHealthFactor, dueAt, note }) => traceTool(
      'solana_prepare_save_withdraw',
      { cluster: options.config.cluster, amount, withdrawAll, token, reserveMint, marketAddress, dueAt },
      async () => jsonReply(
        await service.prepareSaveWithdraw({
          ...(amount !== undefined && { amount }),
          ...(withdrawAll !== undefined && { withdrawAll }),
          ...(token !== undefined && { token }),
          ...(reserveMint !== undefined && { reserveMint }),
          ...(marketAddress !== undefined && { marketAddress }),
          ...(minHealthFactor !== undefined && { minHealthFactor }),
          ...(dueAt !== undefined && { dueAt }),
          ...(note !== undefined && { note }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_prepare_save_borrow',
    {
      description:
        "Create a manual-approval inbox item that borrows from a Save Lend reserve. Refuses to execute if projected obligation health factor breaches the configured minimum (default 1.10) or if the requested amount exceeds the borrow limit. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Mainnet-beta only.",
      inputSchema: {
        amount: z.string().min(1).describe('Human token amount, for example 5.'),
        token: z.string().min(2).optional(),
        reserveMint: z.string().min(32).optional(),
        marketAddress: z.string().min(32).optional(),
        minHealthFactor: z.number().min(1).optional().describe('Minimum projected health factor; defaults to 1.10.'),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ amount, token, reserveMint, marketAddress, minHealthFactor, dueAt, note }) => traceTool(
      'solana_prepare_save_borrow',
      { cluster: options.config.cluster, amount, token, reserveMint, marketAddress, dueAt },
      async () => jsonReply(
        await service.prepareSaveBorrow({
          amount,
          ...(token !== undefined && { token }),
          ...(reserveMint !== undefined && { reserveMint }),
          ...(marketAddress !== undefined && { marketAddress }),
          ...(minHealthFactor !== undefined && { minHealthFactor }),
          ...(dueAt !== undefined && { dueAt }),
          ...(note !== undefined && { note }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_prepare_save_repay',
    {
      description:
        "Create a manual-approval inbox item that repays borrowed tokens to a Save Lend reserve. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Mainnet-beta only.",
      inputSchema: {
        amount: z.string().min(1).optional().describe("Human token amount. Pass 'all' or set repayAll to true to repay the full debt."),
        repayAll: z.boolean().optional(),
        token: z.string().min(2).optional(),
        reserveMint: z.string().min(32).optional(),
        marketAddress: z.string().min(32).optional(),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ amount, repayAll, token, reserveMint, marketAddress, dueAt, note }) => traceTool(
      'solana_prepare_save_repay',
      { cluster: options.config.cluster, amount, repayAll, token, reserveMint, marketAddress, dueAt },
      async () => jsonReply(
        await service.prepareSaveRepay({
          ...(amount !== undefined && { amount }),
          ...(repayAll !== undefined && { repayAll }),
          ...(token !== undefined && { token }),
          ...(reserveMint !== undefined && { reserveMint }),
          ...(marketAddress !== undefined && { marketAddress }),
          ...(dueAt !== undefined && { dueAt }),
          ...(note !== undefined && { note }),
        }),
      ),
    ),
  );

  server.registerTool(
    'solana_jito_stake_pool_snapshot',
    {
      description:
        'Read the JitoSOL stake pool snapshot: JitoSOL mint, pool exchange rate, total lamports, pool token supply, fees, and optional validator list. Read-only. Mainnet-beta only.',
      inputSchema: {
        includeValidators: z.boolean().optional().describe('Include validator stake list rows; defaults to false.'),
      },
    },
    async ({ includeValidators }) => traceTool(
      'solana_jito_stake_pool_snapshot',
      { cluster: options.config.cluster, includeValidators },
      async () => jsonReply(await service.jitoStakePoolSnapshot({
        ...(includeValidators !== undefined && { includeValidators }),
      })),
    ),
  );

  server.registerTool(
    'solana_jito_wallet_positions',
    {
      description:
        'Read wallet JitoSOL token balances and, optionally, stake accounts that can be deposited into Jito. Read-only. Mainnet-beta only.',
      inputSchema: {
        walletAddress: z.string().min(32).optional().describe('Defaults to the connected wallet.'),
        includeStakeAccounts: z.boolean().optional().describe('Defaults to false.'),
        delegatedOnly: z.boolean().optional(),
        eligibleForJitoDepositOnly: z.boolean().optional(),
      },
    },
    async ({ walletAddress, includeStakeAccounts, delegatedOnly, eligibleForJitoDepositOnly }) => traceTool(
      'solana_jito_wallet_positions',
      { cluster: options.config.cluster, walletAddress, includeStakeAccounts },
      async () => jsonReply(await service.jitoWalletPositions({
        ...(walletAddress !== undefined && { walletAddress }),
        ...(includeStakeAccounts !== undefined && { includeStakeAccounts }),
        ...(delegatedOnly !== undefined && { delegatedOnly }),
        ...(eligibleForJitoDepositOnly !== undefined && { eligibleForJitoDepositOnly }),
      })),
    ),
  );

  server.registerTool(
    'solana_jito_wallet_stake_accounts',
    {
      description:
        'List wallet stake accounts with Jito deposit eligibility, withdraw authority, validator vote account, lockup, and deactivation state. Read-only. Mainnet-beta only.',
      inputSchema: {
        walletAddress: z.string().min(32).optional().describe('Defaults to the connected wallet.'),
        delegatedOnly: z.boolean().optional(),
        eligibleForJitoDepositOnly: z.boolean().optional(),
      },
    },
    async ({ walletAddress, delegatedOnly, eligibleForJitoDepositOnly }) => traceTool(
      'solana_jito_wallet_stake_accounts',
      { cluster: options.config.cluster, walletAddress, delegatedOnly, eligibleForJitoDepositOnly },
      async () => jsonReply(await service.jitoWalletStakeAccounts({
        ...(walletAddress !== undefined && { walletAddress }),
        ...(delegatedOnly !== undefined && { delegatedOnly }),
        ...(eligibleForJitoDepositOnly !== undefined && { eligibleForJitoDepositOnly }),
      })),
    ),
  );

  server.registerTool(
    'solana_jito_quote',
    {
      description:
        'Quote JitoSOL liquid staking operations without signing: stake SOL, deposit an existing stake account, unstake JitoSOL, or withdraw SOL from a deactivated stake account. Read-only. Mainnet-beta only.',
      inputSchema: {
        operation: z.enum(['stake_sol', 'deposit_stake_account', 'unstake_jitosol', 'withdraw_sol']),
        solAmount: z.string().min(1).optional(),
        jitoSolAmount: z.string().min(1).optional(),
        stakeAccount: z.string().min(32).optional(),
        amount: z.string().min(1).optional(),
        withdrawMode: z.enum(['stake_account', 'reserve_sol']).optional(),
      },
    },
    async (input) => traceTool(
      'solana_jito_quote',
      { cluster: options.config.cluster, input },
      async () => jsonReply(await service.jitoQuote(input)),
    ),
  );

  server.registerTool(
    'solana_prepare_jito_stake_sol',
    {
      description:
        'Create a manual-approval inbox item that stakes SOL into the Jito stake pool for JitoSOL. Requotes before the wallet prompt and enforces minJitoSolAmount as an execution-time off-chain guard. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Mainnet-beta only.',
      inputSchema: {
        solAmount: z.string().min(1).describe('Human SOL amount, for example 0.5.'),
        minJitoSolAmount: z.string().min(1).optional().describe('Minimum acceptable JitoSOL output; enforced before wallet approval.'),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ solAmount, minJitoSolAmount, dueAt, note }) => traceTool(
      'solana_prepare_jito_stake_sol',
      { cluster: options.config.cluster, solAmount, minJitoSolAmount, dueAt },
      async () => jsonReply(await service.prepareJitoStakeSol({
        solAmount,
        ...(minJitoSolAmount !== undefined && { minJitoSolAmount }),
        ...(dueAt !== undefined && { dueAt }),
        ...(note !== undefined && { note }),
      })),
    ),
  );

  server.registerTool(
    'solana_prepare_jito_deposit_stake_account',
    {
      description:
        'Create a manual-approval inbox item that deposits an existing delegated stake account into Jito through the Jito stake-deposit interceptor. The interceptor creates a claimable receipt; JitoSOL may be claimable after cooldown rather than immediately delivered. Enforces minJitoSolAmount before wallet approval. Mainnet-beta only.',
      inputSchema: {
        stakeAccount: z.string().min(32),
        minJitoSolAmount: z.string().min(1).optional().describe('Minimum acceptable claimable JitoSOL output; enforced before wallet approval.'),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ stakeAccount, minJitoSolAmount, dueAt, note }) => traceTool(
      'solana_prepare_jito_deposit_stake_account',
      { cluster: options.config.cluster, stakeAccount, minJitoSolAmount, dueAt },
      async () => jsonReply(await service.prepareJitoDepositStakeAccount({
        stakeAccount,
        ...(minJitoSolAmount !== undefined && { minJitoSolAmount }),
        ...(dueAt !== undefined && { dueAt }),
        ...(note !== undefined && { note }),
      })),
    ),
  );

  server.registerTool(
    'solana_prepare_jito_unstake_jitosol',
    {
      description:
        'Create a manual-approval inbox item that unstakes JitoSOL through the Jito stake pool, either to a stake account or directly from reserve SOL when available. Requotes before the wallet prompt and enforces minSolAmount as an execution-time off-chain guard. Mainnet-beta only.',
      inputSchema: {
        jitoSolAmount: z.string().min(1).describe('Human JitoSOL amount, for example 0.1.'),
        minSolAmount: z.string().min(1).optional().describe('Minimum acceptable SOL/stake-account value; enforced before wallet approval.'),
        withdrawMode: z.enum(['stake_account', 'reserve_sol']).optional().describe('Defaults to stake_account.'),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ jitoSolAmount, minSolAmount, withdrawMode, dueAt, note }) => traceTool(
      'solana_prepare_jito_unstake_jitosol',
      { cluster: options.config.cluster, jitoSolAmount, minSolAmount, withdrawMode, dueAt },
      async () => jsonReply(await service.prepareJitoUnstakeJitosol({
        jitoSolAmount,
        ...(minSolAmount !== undefined && { minSolAmount }),
        ...(withdrawMode !== undefined && { withdrawMode }),
        ...(dueAt !== undefined && { dueAt }),
        ...(note !== undefined && { note }),
      })),
    ),
  );

  server.registerTool(
    'solana_prepare_jito_withdraw_sol',
    {
      description:
        'Create a manual-approval inbox item that withdraws SOL from an inactive/deactivated stake account returned by a Jito unstake flow. Refuses active stake accounts at execution time. Mainnet-beta only.',
      inputSchema: {
        stakeAccount: z.string().min(32),
        amountSol: z.string().min(1).optional().describe('Human SOL amount. Omit or set withdrawAll to true to close/empty the stake account.'),
        withdrawAll: z.boolean().optional(),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ stakeAccount, amountSol, withdrawAll, dueAt, note }) => traceTool(
      'solana_prepare_jito_withdraw_sol',
      { cluster: options.config.cluster, stakeAccount, amountSol, withdrawAll, dueAt },
      async () => jsonReply(await service.prepareJitoWithdrawSol({
        stakeAccount,
        ...(amountSol !== undefined && { amountSol }),
        ...(withdrawAll !== undefined && { withdrawAll }),
        ...(dueAt !== undefined && { dueAt }),
        ...(note !== undefined && { note }),
      })),
    ),
  );

  server.registerTool(
    'solana_marinade_state_snapshot',
    {
      description:
        'Read Marinade state: mSOL mint, program id, mSOL price, pool totals, reserve liquidity, reward fee, delayed-unstake cooldown, and optional warnings. Read-only. Mainnet-beta only.',
      inputSchema: {},
    },
    async () => traceTool(
      'solana_marinade_state_snapshot',
      { cluster: options.config.cluster },
      async () => jsonReply(await service.marinadeStateSnapshot()),
    ),
  );

  server.registerTool(
    'solana_marinade_wallet_positions',
    {
      description:
        'Read wallet Marinade positions: mSOL balance, estimated SOL value, native stake-account summaries, and delayed unstake tickets. Read-only. Mainnet-beta only.',
      inputSchema: {
        walletAddress: z.string().min(32).optional().describe('Defaults to the connected wallet.'),
      },
    },
    async ({ walletAddress }) => traceTool(
      'solana_marinade_wallet_positions',
      { cluster: options.config.cluster, walletAddress },
      async () => jsonReply(await service.marinadeWalletPositions({
        ...(walletAddress !== undefined && { walletAddress }),
      })),
    ),
  );

  server.registerTool(
    'solana_marinade_wallet_stake_accounts',
    {
      description:
        'List wallet native stake accounts for Marinade planning context. Read-only; this connector does not edit validator delegation or liquidate native stake accounts. Mainnet-beta only.',
      inputSchema: {
        walletAddress: z.string().min(32).optional().describe('Defaults to the connected wallet.'),
      },
    },
    async ({ walletAddress }) => traceTool(
      'solana_marinade_wallet_stake_accounts',
      { cluster: options.config.cluster, walletAddress },
      async () => jsonReply(await service.marinadeWalletStakeAccounts({
        ...(walletAddress !== undefined && { walletAddress }),
      })),
    ),
  );

  server.registerTool(
    'solana_marinade_unstake_tickets',
    {
      description:
        'List Marinade delayed unstake tickets for a wallet, optionally only claimable tickets. Read-only. Mainnet-beta only.',
      inputSchema: {
        walletAddress: z.string().min(32).optional().describe('Defaults to the connected wallet.'),
        claimableOnly: z.boolean().optional(),
      },
    },
    async ({ walletAddress, claimableOnly }) => traceTool(
      'solana_marinade_unstake_tickets',
      { cluster: options.config.cluster, walletAddress, claimableOnly },
      async () => jsonReply(await service.marinadeUnstakeTickets({
        ...(walletAddress !== undefined && { walletAddress }),
        ...(claimableOnly !== undefined && { claimableOnly }),
      })),
    ),
  );

  server.registerTool(
    'solana_marinade_quote',
    {
      description:
        'Quote Marinade operations without signing: SOL to mSOL liquid stake, instant mSOL to SOL unstake through Jupiter, delayed unstake, or claimable delayed-unstake ticket value. Read-only. Mainnet-beta only.',
      inputSchema: {
        operation: z.enum(['liquid_stake', 'liquid_unstake', 'delayed_unstake', 'claim_delayed_unstake']),
        walletAddress: z.string().min(32).optional().describe('Defaults to the connected wallet.'),
        solAmount: z.string().min(1).optional(),
        msolAmount: z.string().min(1).optional(),
        minSolAmount: z.string().min(1).optional(),
        minMsolAmount: z.string().min(1).optional(),
        ticketAccount: z.string().min(32).optional(),
        slippageBps: z.number().int().min(0).optional(),
      },
    },
    async (input) => traceTool(
      'solana_marinade_quote',
      { cluster: options.config.cluster, input },
      async () => jsonReply(await service.marinadeQuote(input)),
    ),
  );

  server.registerTool(
    'solana_prepare_marinade_liquid_stake',
    {
      description:
        'Create a manual-approval inbox item that stakes SOL into Marinade for mSOL. Requotes before the wallet prompt and enforces minMsolAmount as an execution-time guard. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Mainnet-beta only.',
      inputSchema: {
        solAmount: z.string().min(1).describe('Human SOL amount, for example 0.5.'),
        minMsolAmount: z.string().min(1).optional().describe('Minimum acceptable mSOL output; enforced before wallet approval.'),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ solAmount, minMsolAmount, dueAt, note }) => traceTool(
      'solana_prepare_marinade_liquid_stake',
      { cluster: options.config.cluster, solAmount, minMsolAmount, dueAt },
      async () => jsonReply(await service.prepareMarinadeLiquidStake({
        solAmount,
        ...(minMsolAmount !== undefined && { minMsolAmount }),
        ...(dueAt !== undefined && { dueAt }),
        ...(note !== undefined && { note }),
      })),
    ),
  );

  server.registerTool(
    'solana_prepare_marinade_liquid_unstake',
    {
      description:
        'Create a manual-approval inbox item that instant-unstakes mSOL to SOL through Jupiter Ultra. The route is refreshed before wallet approval and minSolAmount is enforced. Prepares wallet approval work only; does not sign, submit, or grant delegated authority. Mainnet-beta only.',
      inputSchema: {
        msolAmount: z.string().min(1).describe('Human mSOL amount, for example 0.1.'),
        minSolAmount: z.string().min(1).optional().describe('Minimum acceptable SOL output; enforced before wallet approval.'),
        slippageBps: z.number().int().min(0).optional(),
        maxFeeBps: z.number().int().min(0).optional(),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ msolAmount, minSolAmount, slippageBps, maxFeeBps, dueAt, note }) => traceTool(
      'solana_prepare_marinade_liquid_unstake',
      { cluster: options.config.cluster, msolAmount, minSolAmount, slippageBps, maxFeeBps, dueAt },
      async () => jsonReply(await service.prepareMarinadeLiquidUnstake({
        msolAmount,
        ...(minSolAmount !== undefined && { minSolAmount }),
        ...(slippageBps !== undefined && { slippageBps }),
        ...(maxFeeBps !== undefined && { maxFeeBps }),
        ...(dueAt !== undefined && { dueAt }),
        ...(note !== undefined && { note }),
      })),
    ),
  );

  server.registerTool(
    'solana_prepare_marinade_delayed_unstake',
    {
      description:
        'Create a manual-approval inbox item that requests a Marinade delayed unstake order for mSOL. Claims are a separate prepared action after the ticket becomes claimable. Mainnet-beta only.',
      inputSchema: {
        msolAmount: z.string().min(1).describe('Human mSOL amount, for example 0.1.'),
        minSolAmount: z.string().min(1).optional().describe('Minimum expected delayed unstake SOL value; enforced before wallet approval when quoted.'),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ msolAmount, minSolAmount, dueAt, note }) => traceTool(
      'solana_prepare_marinade_delayed_unstake',
      { cluster: options.config.cluster, msolAmount, minSolAmount, dueAt },
      async () => jsonReply(await service.prepareMarinadeDelayedUnstake({
        msolAmount,
        ...(minSolAmount !== undefined && { minSolAmount }),
        ...(dueAt !== undefined && { dueAt }),
        ...(note !== undefined && { note }),
      })),
    ),
  );

  server.registerTool(
    'solana_prepare_marinade_claim_delayed_unstake',
    {
      description:
        'Create a manual-approval inbox item that claims a Marinade delayed unstake ticket. The connector rejects tickets that are not claimable when prepared and rechecks before execution. Mainnet-beta only.',
      inputSchema: {
        ticketAccount: z.string().min(32),
        expectedClaimableAt: z.string().datetime().optional(),
        dueAt: z.string().datetime().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ ticketAccount, expectedClaimableAt, dueAt, note }) => traceTool(
      'solana_prepare_marinade_claim_delayed_unstake',
      { cluster: options.config.cluster, ticketAccount, expectedClaimableAt, dueAt },
      async () => jsonReply(await service.prepareMarinadeClaimDelayedUnstake({
        ticketAccount,
        ...(expectedClaimableAt !== undefined && { expectedClaimableAt }),
        ...(dueAt !== undefined && { dueAt }),
        ...(note !== undefined && { note }),
      })),
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

function meteoraClaimInputSchema() {
  return {
    poolAddress: z.string().min(32),
    positionAddress: z.string().min(32).optional(),
    claimAll: z.boolean().optional(),
    dueAt: z.string().datetime().optional(),
    note: z.string().max(500).optional(),
  };
}

function raydiumReadPoolTypeSchema() {
  return z.enum(['cpmm', 'clmm', 'amm_v4']);
}

function raydiumLiquidityPoolTypeSchema() {
  return z.enum(['cpmm', 'clmm']);
}

function raydiumLiquidityInputSchema() {
  return {
    poolId: z.string().min(32),
    poolType: raydiumLiquidityPoolTypeSchema().optional().describe('Defaults to cpmm.'),
  };
}

function marginfiOperationSchema() {
  return z.enum(['deposit', 'withdraw', 'borrow', 'repay']);
}

function marginfiBankInputSchema() {
  return {
    bankAddress: z.string().min(32).optional().describe('MarginFi bank account address.'),
    bankMint: z.string().min(32).optional().describe('Bank mint address.'),
    token: z.string().min(2).optional().describe('Bank token symbol, for example SOL or USDC.'),
  };
}

function marginfiActionInputSchema() {
  return {
    ...marginfiBankInputSchema(),
    walletAddress: z.string().min(32).optional().describe('Defaults to the connected wallet.'),
    amount: z.string().min(1).optional().describe('Human token amount. Required unless withdrawAll or repayAll resolves the amount.'),
    marginfiAccount: z.string().min(32).optional().describe('Required when the wallet has multiple MarginFi accounts.'),
    withdrawAll: z.boolean().optional(),
    repayAll: z.boolean().optional(),
    createAccountIfMissing: z.boolean().optional(),
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
    'marketplace',
    'oracle',
    'governance',
    'treasury',
    'bridge',
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
      {
        category: 'Raydium (Protocol Connector)',
        prompts: [
          'Use solana-agent-wallet to read this Raydium pool snapshot without signing.',
          'Use solana-agent-wallet to show my Raydium positions.',
          'Use solana-agent-wallet to prepare adding liquidity to this Raydium CPMM pool for manual approval.',
          'Use solana-agent-wallet to harvest rewards from this Raydium farm for manual approval.',
        ],
      },
      {
        category: 'MarginFi (Protocol Connector)',
        prompts: [
          'Use solana-agent-wallet to show my MarginFi accounts and health.',
          'Use solana-agent-wallet to read the MarginFi SOL bank snapshot.',
          'Use solana-agent-wallet to preview borrowing 0.1 SOL on MarginFi without signing.',
          'Use solana-agent-wallet to prepare a MarginFi USDC repay for manual approval.',
        ],
      },
      {
        category: 'Save (Protocol Connector)',
        prompts: [
          'Use solana-agent-wallet to show the USDC Save reserve APY and liquidity.',
          'Use solana-agent-wallet to show my Save obligation and current health factor.',
          'Use solana-agent-wallet to preview borrowing 5 USDC on Save without signing.',
          'Use solana-agent-wallet to prepare depositing 10 USDC into Save for manual approval.',
          'Use solana-agent-wallet to prepare repaying all my Save USDC debt.',
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
