export const meta = {
  name: 'translate-i18n-chunks',
  description: 'Translate /app i18n catalog delta chunks into 10 languages (protected tokens + placeholders verbatim)',
  phases: [{ title: 'Translate', detail: 'one agent per chunk, batched to limit load' }],
}

const LANG_NAMES = {
  'zh-Hans': 'Simplified Chinese (简体中文)',
  'zh-Hant': 'Traditional Chinese (繁體中文)',
  es: 'Spanish (Español)',
  ja: 'Japanese (日本語)',
  de: 'German (Deutsch)',
  it: 'Italian (Italiano)',
  fr: 'French (Français)',
  pt: 'Portuguese (Português)',
  ko: 'Korean (한국어)',
  ru: 'Russian (Русский)',
}

const WORK = 'apps/browser-demo/scripts/_i18n_work'

const chunks = Array.isArray(args) ? args : []
if (!chunks.length) {
  log('No chunk names passed via args — nothing to translate.')
  return { translated: 0, note: 'pass args: ["es__000.json", ...]' }
}

const RULES = `
Keep these VERBATIM (do NOT translate, drop, reorder, or alter them) inside each translation:
- token tickers: SOL, USDC, USDT, BTC, ETH, JUP, BONK, POPCAT, WIF, JITO, mSOL, bSOL, USDS, USDP, PYUSD; and NFT, DeFi, DCA, bps, APR, USD.
- every number, currency amount ($15, 0.2, 1.5%) and percentage, exactly as written.
- URLs, file paths, and wallet/base58 addresses.
- placeholders such as {n}, {id}, {tx}, {label}, {date}, {count}, {slippage}, {amount} — keep the braces and the EXACT name; keep the SAME set of placeholders that appear in the English key.
- the decision keywords APPROVE and DENY (uppercase English) and the literal value "true".
- model ids (e.g. claude-sonnet-4-5) and brand/proper nouns: Solana, Agentic, MWA, Jupiter, Solscan, Helium Mobile, Helium, Coinbase, Magic Eden, Tensor, Sanctum, Phantom, Solflare, Ledger, Squads, Kamino, Marinade, Drift, Meteora, Orca, Raydium.
If a value is purely protected tokens/symbols with no natural-language words, return it unchanged.`

phase('Translate')

function outName(name) {
  return name.replace(/\.json$/, '.out.json')
}

const thunks = chunks.map((name) => () => {
  const lang = name.split('__')[0]
  const langName = LANG_NAMES[lang] || lang
  const out = outName(name)
  const prompt = `You are a professional UI localizer for a Solana wallet-approval product, translating into ${langName}.

1. Read ${WORK}/${name}. It is JSON shaped { "language": "${lang}", "entries": { "<EnglishKey>": "<EnglishSource>", ... } }.
2. If ${WORK}/${out} already exists and is valid JSON whose "entries" has the SAME keys as the input, reply exactly "cached" and do nothing else.
3. Otherwise translate every VALUE into ${langName} — fluent, natural, product-grade UI copy. Keep each KEY byte-for-byte identical.
${RULES}
4. WRITE ${WORK}/${out} as JSON: { "language": "${lang}", "entries": { "<EnglishKey>": "<translation>", ... } } with EXACTLY the same keys as the input (no additions, drops, reorders, or key edits). Valid JSON only.
5. Reply with just "done <N>" (N = entries written) or "cached". Do not edit any other file; do not touch the catalog or en.json.`
  return agent(prompt, { label: `tr:${name}`, phase: 'Translate' }).then((r) => ({ name, r: String(r).slice(0, 60) }))
})

const BATCH = 6
const results = []
for (let i = 0; i < thunks.length; i += BATCH) {
  const batch = thunks.slice(i, i + BATCH)
  const out = await parallel(batch)
  results.push(...out.filter(Boolean))
  log(`translated batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(thunks.length / BATCH)} (${results.length}/${thunks.length})`)
}

return {
  requested: chunks.length,
  completed: results.length,
  sample: results.slice(0, 12).map((x) => `${x.name}: ${x.r}`),
}
