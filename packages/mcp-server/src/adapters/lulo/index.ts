import type { AdapterRead, DAppAdapter } from '../types.js';

import { getLuloWalletBalances } from './balances.js';
import {
  LULO_ADAPTER_ID,
  LULO_DESCRIPTION,
  LULO_NAME,
  LULO_PROGRAM_IDS,
  LULO_SUPPORTED_CLUSTERS,
  LULO_WEBSITE,
} from './constants.js';
import { luloDepositAction, type LuloDepositInput } from './deposit.js';
import { getLuloPoolMeta, getLuloRates } from './rates.js';
import {
  luloCompleteWithdrawAction,
  luloWithdrawAction,
  type LuloCompleteWithdrawInput,
  type LuloWithdrawInput,
} from './withdraw.js';

const ratesRead: AdapterRead<Parameters<typeof getLuloRates>[0], unknown> = {
  id: 'rates',
  async read(input, ctx) {
    return getLuloRates(input, ctx);
  },
};

const poolMetaRead: AdapterRead<Parameters<typeof getLuloPoolMeta>[0], unknown> = {
  id: 'pool_meta',
  async read(input, ctx) {
    return getLuloPoolMeta(input, ctx);
  },
};

const walletBalancesRead: AdapterRead<Parameters<typeof getLuloWalletBalances>[0], unknown> = {
  id: 'wallet_balances',
  async read(input, ctx) {
    return getLuloWalletBalances(input, ctx);
  },
};

export const luloAdapter: DAppAdapter = {
  id: LULO_ADAPTER_ID,
  name: LULO_NAME,
  website: LULO_WEBSITE,
  description: LULO_DESCRIPTION,
  supportedClusters: LULO_SUPPORTED_CLUSTERS,
  programIds: LULO_PROGRAM_IDS,
  actions: {
    deposit: luloDepositAction,
    withdraw: luloWithdrawAction,
    complete_withdraw: luloCompleteWithdrawAction,
  },
  reads: {
    rates: ratesRead,
    pool_meta: poolMetaRead,
    wallet_balances: walletBalancesRead,
  },
};

export type { LuloCompleteWithdrawInput, LuloDepositInput, LuloWithdrawInput };
export {
  LULO_ADAPTER_ID,
  LULO_DESCRIPTION,
  LULO_NAME,
  LULO_SUPPORTED_CLUSTERS,
  LULO_WEBSITE,
};
