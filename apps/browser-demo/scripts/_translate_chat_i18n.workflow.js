export const meta = {
  name: 'translate-chat-i18n-2',
  description: 'Translate the connector-status + recurring i18n delta chunks into 10 languages',
  phases: [{ title: 'Translate', detail: 'one agent per language chunk' }],
}

const LANG_NAMES = {
  'zh-Hans': 'Simplified Chinese (简体中文)', 'zh-Hant': 'Traditional Chinese (繁體中文)',
  es: 'Spanish (Español)', ja: 'Japanese (日本語)', de: 'German (Deutsch)', it: 'Italian (Italiano)',
  fr: 'French (Français)', pt: 'Portuguese (Português)', ko: 'Korean (한국어)', ru: 'Russian (Русский)',
}
const WORK = 'apps/browser-demo/scripts/_i18n_work'
const chunks = [
  'zh-Hans__000.json', 'zh-Hant__000.json', 'es__000.json', 'ja__000.json', 'de__000.json',
  'it__000.json', 'fr__000.json', 'pt__000.json', 'ko__000.json', 'ru__000.json',
]
const RULES = `
Keep VERBATIM (do NOT translate/drop/reorder): token tickers SOL/USDC/etc. and NFT, DeFi, DCA, bps, APR, USD, QR, Blink; every number/amount/percentage; URLs/paths/addresses; placeholders {connector}, {clusters} (keep braces + exact name, same set as the English key); product nouns Solana, Agentic, Jupiter, Solscan, Protocol Connectors, Active Repeats, Needs Approval. "Blink" is a product term — keep it as "Blink". If a value is purely protected tokens with no natural-language words, return it unchanged.`

phase('Translate')
const thunks = chunks.map((name) => () => {
  const lang = name.split('__')[0]
  const out = name.replace(/\.json$/, '.out.json')
  const prompt = `You are a professional UI localizer for a Solana wallet product, translating into ${LANG_NAMES[lang] || lang}.
1. Read ${WORK}/${name} — JSON { "language": "${lang}", "entries": { "<EnglishKey>": "<EnglishSource>", ... } }.
2. If ${WORK}/${out} already exists with the SAME keys, reply "cached" and stop.
3. Otherwise translate every VALUE into ${LANG_NAMES[lang] || lang} — fluent, product-grade. Keep each KEY byte-for-byte identical.
${RULES}
4. WRITE ${WORK}/${out} as JSON { "language": "${lang}", "entries": {...} } with EXACTLY the same keys. Valid JSON only.
5. Reply "done <N>" or "cached". Touch no other file.`
  return agent(prompt, { label: `tr:${name}`, phase: 'Translate' }).then((r) => ({ name, r: String(r).slice(0, 40) }))
})
const results = (await parallel(thunks)).filter(Boolean)
return { completed: results.length, sample: results.map((x) => `${x.name}: ${x.r}`) }
