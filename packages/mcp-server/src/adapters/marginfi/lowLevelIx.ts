// MarginFi v6.4.1 ships an Anchor IDL whose enum-variant decode crashes inside
// `@coral-xyz/borsh`'s `rustEnum` (variant struct is undefined) when the
// high-level `MarginfiAccountWrapper.makeXxxIx` path is exercised. The SDK
// also exposes a pure low-level `instructions.makeXxxIx` builder that takes
// pre-resolved accounts and only needs the program for ix data encoding —
// which works fine because the deposit/withdraw/borrow/repay args are
// `{ amount: BN }` (plus optional flags), not enums. This module re-implements
// the SDK's `pure.js:453-617` body using the low-level builder so we avoid
// the broken decoder path while keeping behavior identical.

import {
  PublicKey,
  type AccountMeta,
  type TransactionInstruction,
} from '@solana/web3.js';

type AnyClient = Record<string, any>;
type AnyAccount = Record<string, any>;

export interface InstructionsWrapper {
  instructions: TransactionInstruction[];
  keys: never[];
}

export interface MarginfiActionContext {
  client: AnyClient;
  account: AnyAccount;
  bankAddress: PublicKey;
}

// Imported lazily so test harnesses that swap the SDK loader still work.
// Types are kept loose because `bignumber.js` / `bn.js` flow through the
// MarginFi SDK as transitive deps; this module only invokes them and never
// owns their typings.
async function loadSdkBits(): Promise<{
  instructions: any;
  utils: any;
  common: any;
  BigNumber: any;
}> {
  const [sdk, common, bnPkg] = await Promise.all([
    import('@mrgnlabs/marginfi-client-v2') as Promise<any>,
    import('@mrgnlabs/mrgn-common') as Promise<any>,
    import('bignumber.js' as any) as Promise<any>,
  ]);
  const instructions = sdk.instructions ?? sdk.default?.instructions;
  const utils = sdk.utils ?? sdk.default?.utils;
  if (!instructions || typeof instructions.makeDepositIx !== 'function') {
    throw new Error('MarginFi SDK did not expose instructions.makeDepositIx');
  }
  if (!utils || typeof utils.makeWrapSolIxs !== 'function') {
    throw new Error('MarginFi SDK did not expose utils.makeWrapSolIxs / utils.makeUnwrapSolIx');
  }
  const BigNumber = bnPkg.default ?? bnPkg.BigNumber ?? bnPkg;
  if (typeof BigNumber !== 'function') {
    throw new Error('bignumber.js could not be loaded; required for SOL wrap/unwrap helpers.');
  }
  return { instructions, utils, common, BigNumber };
}

function resolveAccountAndBank(
  client: AnyClient,
  account: AnyAccount,
  bankAddress: PublicKey,
): {
  bank: AnyClient;
  mintData: AnyClient;
  authority: PublicKey;
  marginfiAccount: PublicKey;
  group: PublicKey;
} {
  const bank = client.banks?.get(bankAddress.toBase58());
  if (!bank) {
    throw new Error(`MarginFi bank ${bankAddress.toBase58()} is not in the SDK cache.`);
  }
  const mintData = client.mintDatas?.get(bankAddress.toBase58());
  if (!mintData) {
    throw new Error(`MarginFi mint data for bank ${bankAddress.toBase58()} is not in the SDK cache.`);
  }
  const marginfiAccount = account.address as PublicKey | undefined;
  const authority = (account.authority ?? account._marginfiAccount?.authority) as PublicKey | undefined;
  const group = (account.group ?? account._marginfiAccount?.group ?? bank.group) as PublicKey | undefined;
  if (!marginfiAccount || !authority || !group) {
    throw new Error('MarginFi account is missing address/authority/group needed to build the instruction.');
  }
  return { bank, mintData, authority, marginfiAccount, group };
}

function getProgramFromAccount(account: AnyAccount, client: AnyClient): AnyClient {
  return account._program ?? account.program ?? client.program ?? client._program;
}

function getBankMetadataMap(client: AnyClient): unknown {
  return client.bankMetadataMap ?? client._bankMetadataMap ?? {};
}

function computeHealthCheckAccounts(
  account: AnyAccount,
  bankMap: unknown,
  borrows: PublicKey[],
  withdraws: PublicKey[],
): unknown[] {
  if (typeof account.getHealthCheckAccounts !== 'function') {
    throw new Error('MarginFi account does not expose getHealthCheckAccounts; SDK shape changed.');
  }
  return account.getHealthCheckAccounts(bankMap, borrows, withdraws);
}

async function computeHealthAccountMetas(
  healthAccounts: unknown[],
  bankMetadataMap: unknown,
): Promise<AccountMeta[]> {
  const sdk: any = await import('@mrgnlabs/marginfi-client-v2');
  const fn = sdk.computeHealthAccountMetas ?? sdk.default?.computeHealthAccountMetas;
  if (typeof fn !== 'function') {
    throw new Error('MarginFi SDK did not expose computeHealthAccountMetas; cannot build borrow/withdraw remaining accounts.');
  }
  return fn(healthAccounts, bankMetadataMap) as AccountMeta[];
}

export async function buildDepositInstructions(
  ctx: MarginfiActionContext,
  amount: string,
): Promise<InstructionsWrapper> {
  const { instructions, utils, common, BigNumber } = await loadSdkBits();
  const { client, account, bankAddress } = ctx;
  const { bank, mintData, authority, marginfiAccount, group } = resolveAccountAndBank(client, account, bankAddress);
  const program = getProgramFromAccount(account, client);

  const userAta = common.getAssociatedTokenAddressSync(
    bank.mint as PublicKey,
    authority,
    true,
    mintData.tokenProgram as PublicKey,
  );

  const remainingAccounts: AccountMeta[] = mintData.tokenProgram.equals(common.TOKEN_2022_PROGRAM_ID)
    ? [{ pubkey: mintData.mint as PublicKey, isSigner: false, isWritable: false }]
    : [];

  const ixs: TransactionInstruction[] = [];
  if ((bank.mint as PublicKey).equals(common.NATIVE_MINT)) {
    ixs.push(...utils.makeWrapSolIxs(authority, new BigNumber(amount)));
  }

  const depositIx: TransactionInstruction = await instructions.makeDepositIx(
    program,
    {
      marginfiAccount,
      signerTokenAccount: userAta,
      bank: bankAddress,
      tokenProgram: mintData.tokenProgram as PublicKey,
      authority,
      group,
    },
    { amount: common.uiToNative(amount, bank.mintDecimals) as any },
    remainingAccounts,
  );
  ixs.push(depositIx);

  return { instructions: ixs, keys: [] };
}

export async function buildRepayInstructions(
  ctx: MarginfiActionContext,
  amount: string,
  repayAll: boolean,
): Promise<InstructionsWrapper> {
  const { instructions, utils, common, BigNumber } = await loadSdkBits();
  const { client, account, bankAddress } = ctx;
  const { bank, mintData, authority, marginfiAccount, group } = resolveAccountAndBank(client, account, bankAddress);
  const program = getProgramFromAccount(account, client);

  const userAta = common.getAssociatedTokenAddressSync(
    bank.mint as PublicKey,
    authority,
    true,
    mintData.tokenProgram as PublicKey,
  );

  const ixs: TransactionInstruction[] = [];
  if (repayAll && bank.emissionsMint && !(bank.emissionsMint as PublicKey).equals(PublicKey.default)) {
    const emissionsIxs = await buildWithdrawEmissionsInstructions(ctx);
    ixs.push(...emissionsIxs.instructions);
  }

  const remainingAccounts: AccountMeta[] = mintData.tokenProgram.equals(common.TOKEN_2022_PROGRAM_ID)
    ? [{ pubkey: mintData.mint as PublicKey, isSigner: false, isWritable: false }]
    : [];

  if ((bank.mint as PublicKey).equals(common.NATIVE_MINT)) {
    ixs.push(...utils.makeWrapSolIxs(authority, new BigNumber(amount)));
  }

  const repayIx: TransactionInstruction = await instructions.makeRepayIx(
    program,
    {
      marginfiAccount,
      signerTokenAccount: userAta,
      bank: bankAddress,
      tokenProgram: mintData.tokenProgram as PublicKey,
      authority,
      group,
    },
    { amount: common.uiToNative(amount, bank.mintDecimals) as any, repayAll },
    remainingAccounts,
  );
  ixs.push(repayIx);

  return { instructions: ixs, keys: [] };
}

export async function buildWithdrawInstructions(
  ctx: MarginfiActionContext,
  amount: string,
  withdrawAll: boolean,
): Promise<InstructionsWrapper> {
  const { instructions, utils, common } = await loadSdkBits();
  const { client, account, bankAddress } = ctx;
  const { bank, mintData, authority, marginfiAccount, group } = resolveAccountAndBank(client, account, bankAddress);
  const program = getProgramFromAccount(account, client);
  const bankMap = client.banks;
  const bankMetadataMap = getBankMetadataMap(client);

  const userAta = common.getAssociatedTokenAddressSync(
    bank.mint as PublicKey,
    authority,
    true,
    mintData.tokenProgram as PublicKey,
  );

  const ixs: TransactionInstruction[] = [];
  if (withdrawAll && bank.emissionsMint && !(bank.emissionsMint as PublicKey).equals(PublicKey.default) && mintData.emissionTokenProgram) {
    const emissionsIxs = await buildWithdrawEmissionsInstructions(ctx);
    ixs.push(...emissionsIxs.instructions);
  }

  ixs.push(
    common.createAssociatedTokenAccountIdempotentInstruction(
      authority,
      userAta,
      authority,
      bank.mint as PublicKey,
      mintData.tokenProgram as PublicKey,
    ),
  );

  const healthAccounts = withdrawAll
    ? computeHealthCheckAccounts(account, bankMap, [], [bankAddress])
    : computeHealthCheckAccounts(account, bankMap, [bankAddress], []);
  const remainingAccounts: AccountMeta[] = mintData.tokenProgram.equals(common.TOKEN_2022_PROGRAM_ID)
    ? [{ pubkey: mintData.mint as PublicKey, isSigner: false, isWritable: false }]
    : [];
  const healthMetas = await computeHealthAccountMetas(healthAccounts, bankMetadataMap);
  remainingAccounts.push(...healthMetas);

  const withdrawIx: TransactionInstruction = await instructions.makeWithdrawIx(
    program,
    {
      marginfiAccount,
      bank: bankAddress,
      destinationTokenAccount: userAta,
      tokenProgram: mintData.tokenProgram as PublicKey,
      authority,
      group,
    },
    { amount: common.uiToNative(amount, bank.mintDecimals) as any, withdrawAll },
    remainingAccounts,
  );
  ixs.push(withdrawIx);

  if ((bank.mint as PublicKey).equals(common.NATIVE_MINT)) {
    ixs.push(utils.makeUnwrapSolIx(authority));
  }

  return { instructions: ixs, keys: [] };
}

export async function buildBorrowInstructions(
  ctx: MarginfiActionContext,
  amount: string,
): Promise<InstructionsWrapper> {
  const { instructions, utils, common } = await loadSdkBits();
  const { client, account, bankAddress } = ctx;
  const { bank, mintData, authority, marginfiAccount, group } = resolveAccountAndBank(client, account, bankAddress);
  const program = getProgramFromAccount(account, client);
  const bankMap = client.banks;
  const bankMetadataMap = getBankMetadataMap(client);

  const userAta = common.getAssociatedTokenAddressSync(
    bank.mint as PublicKey,
    authority,
    true,
    mintData.tokenProgram as PublicKey,
  );

  const ixs: TransactionInstruction[] = [];
  ixs.push(
    common.createAssociatedTokenAccountIdempotentInstruction(
      authority,
      userAta,
      authority,
      bank.mint as PublicKey,
      mintData.tokenProgram as PublicKey,
    ),
  );

  const healthAccounts = computeHealthCheckAccounts(account, bankMap, [bankAddress], []);
  const remainingAccounts: AccountMeta[] = mintData.tokenProgram.equals(common.TOKEN_2022_PROGRAM_ID)
    ? [{ pubkey: mintData.mint as PublicKey, isSigner: false, isWritable: false }]
    : [];
  const healthMetas = await computeHealthAccountMetas(healthAccounts, bankMetadataMap);
  remainingAccounts.push(...healthMetas);

  const borrowIx: TransactionInstruction = await instructions.makeBorrowIx(
    program,
    {
      marginfiAccount,
      bank: bankAddress,
      destinationTokenAccount: userAta,
      tokenProgram: mintData.tokenProgram as PublicKey,
      authority,
      group,
    },
    { amount: common.uiToNative(amount, bank.mintDecimals) as any },
    remainingAccounts,
  );
  ixs.push(borrowIx);

  if ((bank.mint as PublicKey).equals(common.NATIVE_MINT)) {
    ixs.push(utils.makeUnwrapSolIx(authority));
  }

  return { instructions: ixs, keys: [] };
}

async function buildWithdrawEmissionsInstructions(
  ctx: MarginfiActionContext,
): Promise<InstructionsWrapper> {
  const { instructions, common } = await loadSdkBits();
  const { client, account, bankAddress } = ctx;
  const { bank, mintData, authority, marginfiAccount } = resolveAccountAndBank(client, account, bankAddress);
  const program = getProgramFromAccount(account, client);
  if (!mintData.emissionTokenProgram) {
    throw new Error(`MarginFi emissions token program missing for bank ${bankAddress.toBase58()}.`);
  }
  const userAta = common.getAssociatedTokenAddressSync(
    bank.emissionsMint as PublicKey,
    authority,
    true,
    mintData.emissionTokenProgram as PublicKey,
  );
  const ixs: TransactionInstruction[] = [
    common.createAssociatedTokenAccountIdempotentInstruction(
      authority,
      userAta,
      authority,
      bank.emissionsMint as PublicKey,
      mintData.emissionTokenProgram as PublicKey,
    ),
  ];
  const withdrawEmissionsIx: TransactionInstruction = await instructions.makelendingAccountWithdrawEmissionIx(
    program,
    {
      marginfiAccount,
      destinationAccount: userAta,
      bank: bankAddress,
      tokenProgram: mintData.emissionTokenProgram as PublicKey,
    },
  );
  ixs.push(withdrawEmissionsIx);
  return { instructions: ixs, keys: [] };
}
