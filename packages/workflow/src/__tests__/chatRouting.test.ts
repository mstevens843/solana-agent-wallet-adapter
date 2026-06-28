import { describe, expect, it } from 'vitest';

import {
  chatFactHasCategory,
  chatMentionsOwnWalletText,
  chatTextNeedsWebResearch,
  classifyChatFactText,
} from '../chatAgent/routing.js';

describe('chat fact routing classifier', () => {
  it('classifies token holder and market questions into API categories', () => {
    const holders = classifyChatFactText('Who are the top holders and whale wallets for BONK?');
    expect(chatFactHasCategory(holders, 'token_holders')).toBe(true);
    expect(holders.webSearchPreferred).toBe(false);

    const market = classifyChatFactText('What is POPCAT liquidity, market cap, volume, and holder concentration?');
    expect(chatFactHasCategory(market, 'token_market')).toBe(true);
    expect(market.webSearchPreferred).toBe(false);
  });

  it('routes crypto sector narrative questions to CoinGecko categories', () => {
    const result = classifyChatFactText('How are AI tokens and memecoins doing as a sector?');
    expect(chatFactHasCategory(result, 'coin_categories')).toBe(true);
  });

  it('prefers web for off-chain current facts but not own-wallet questions', () => {
    const offchain = classifyChatFactText('Look up the latest Helium monthly plan price.');
    expect(chatFactHasCategory(offchain, 'web_current_fact')).toBe(true);
    expect(offchain.webSearchPreferred).toBe(true);

    const wallet = classifyChatFactText('What is my current wallet balance?');
    expect(chatMentionsOwnWalletText('What is my current wallet balance?')).toBe(true);
    expect(wallet.ownWallet).toBe(true);
    expect(wallet.webSearchPreferred).toBe(false);
  });

  it('keeps API-answerable crypto price questions off straight-to-web routing', () => {
    expect(chatTextNeedsWebResearch('latest price of SOL')).toBe(true);
    const result = classifyChatFactText('latest price of SOL');
    expect(chatFactHasCategory(result, 'token_price')).toBe(true);
    expect(result.webSearchPreferred).toBe(false);
  });
});
