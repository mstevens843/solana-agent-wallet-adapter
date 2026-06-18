import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const mainSource = readFileSync(new URL('../main.ts', import.meta.url), 'utf8');
const zhHansCatalog = JSON.parse(
  readFileSync(new URL('../demo-i18n/catalog/zh-Hans.json', import.meta.url), 'utf8'),
) as { entries: Record<string, string> };
const zhHans = zhHansCatalog.entries;

describe('Home page localization coverage', () => {
  it('catalogs the Android Home terminal/proof strings in Simplified Chinese', () => {
    expect(zhHans['Agentic terminal preview']).toBe('Agentic 终端预览');
    expect(zhHans['Agent requests']).toBe('智能体请求');
    expect(zhHans['Wallet approves']).toBe('钱包批准');
    expect(zhHans['Adapter records']).toBe('适配器记录');
    expect(zhHans['prepare swap SOL to USDC']).toBe('准备 SOL 到 USDC 兑换');
    expect(zhHans['no private key handed to agent']).toBe('不向智能体交出私钥');
  });

  it('localizes Home wallet-list placeholders without translating protected wallet names', () => {
    expect(
      zhHans['Phantom, Solflare, Backpack, Seed Vault, Wallet Standard, MWA, and iOS wallet links'],
    ).toBe('Phantom、Solflare、Backpack、Seed Vault、Wallet Standard、MWA 和 iOS 钱包链接');
    expect(zhHans['Provider icons appear after discovery.']).toBe('钱包提供方图标会在发现完成后显示。');
    expect(zhHans['Detected provider']).toBe('已检测到提供方');
    expect(zhHans['Discovered wallets use their provider-supplied icons.']).toBe(
      '已发现的钱包使用其提供方提供的图标。',
    );
  });

  it('does not leave raw Home terminal preview prose in the renderer', () => {
    expect(mainSource).not.toContain('<p><span>agent</span> prepare swap SOL to USDC</p>');
    expect(mainSource).not.toContain('<p><span>wallet</span> user approval required</p>');
    expect(mainSource).not.toContain('<p class="ok"><span>result</span> no private key handed to agent</p>');
    expect(mainSource).toContain("t('prepare swap SOL to USDC')");
    expect(mainSource).toContain("t('no private key handed to agent')");
  });
});
