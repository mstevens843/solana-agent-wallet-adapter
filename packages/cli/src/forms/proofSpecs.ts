// Catalog of 20 proof types — 5 Common (multi-field forms) and 15 Advanced
// (single-input artifacts). Mirrors apps/browser-demo/src/main.ts RECEIPT_LABS
// and ADVANCED_EVIDENCE_LABS so the CLI's /proof flow matches the web's
// "Save Proof" page 1-to-1.

export interface ProofField {
  id: string;
  label: string;
  type: 'text' | 'textarea' | 'select';
  required: boolean;
  placeholder?: string;
  options?: string[];
}

export interface ProofSpec {
  id: string;
  title: string;
  kind: string;
  category: 'common' | 'advanced';
  description: string;
  summary: string;
  whatThisProves: string;
  recommendedUse: string;
  defaultInput?: string;
  fields?: ProofField[];
}

// ─── Common Proofs (5) — saved as Receipt Labs in the web ──────────────────

const COMMON_PROOFS: ProofSpec[] = [
  {
    id: 'intent-receipt',
    title: 'Proof of Intent',
    kind: 'intent_receipt',
    category: 'common',
    description: 'Sign the requested action and the constraints that must stay true before any wallet approval.',
    summary: 'A wallet-signed proof of what you intended to review or do.',
    whatThisProves: 'The action, limits, and review context existed before any transaction approval.',
    recommendedUse: 'Use it before approval when you want a record of the exact request and constraints.',
    fields: [
      { id: 'request',     label: 'Requested action',     type: 'textarea', required: true,  placeholder: 'Swap 0.01 SOL to USDC to rebalance after a price move.' },
      { id: 'constraints', label: 'Required constraints', type: 'textarea', required: true,  placeholder: 'Route must stay SOL -> USDC. Max slippage 0.5%. No private-key handoff. No authority grants. User wallet must approve.' },
      { id: 'context',     label: 'Context / source',     type: 'text',     required: false, placeholder: 'Personal trading and portfolio rebalancing workflow.' },
    ],
  },
  {
    id: 'policy-receipt',
    title: 'Proof of Policy (Approval Decision)',
    kind: 'policy_receipt',
    category: 'common',
    description: 'Sign that a wallet rule or personal policy was checked for this request.',
    summary: 'A wallet-signed proof that a policy check happened.',
    whatThisProves: 'The user had a stated rule and checked the request against it before taking action.',
    recommendedUse: 'Use it for spend caps, slippage rules, recipient checks, custody rules, or allowed actions.',
    fields: [
      { id: 'policy',  label: 'Policy checked',         type: 'textarea', required: true, placeholder: 'Never sign unlimited approvals. Swaps must stay below 100 bps slippage. No private key sharing.' },
      { id: 'request', label: 'Request being checked',  type: 'textarea', required: true, placeholder: 'Describe the agent request, transaction preview, or approval proposal.' },
      { id: 'result',  label: 'Policy result',          type: 'select',   required: true, options: ['Recorded', 'Pass', 'Warning', 'Blocked'] },
    ],
  },
  {
    id: 'risk-receipt',
    title: 'Proof of Review (Risk)',
    kind: 'risk_review_receipt',
    category: 'common',
    description: 'Sign the risks reviewed before a wallet decision.',
    summary: 'A wallet-signed proof that specific risks were reviewed.',
    whatThisProves: 'Specific risks were reviewed before a later approval, rejection, or support/audit discussion.',
    recommendedUse: 'Use it before swaps, transfers, new protocols, links, or any route that needs review.',
    fields: [
      { id: 'request', label: 'Request reviewed', type: 'textarea', required: true, placeholder: 'New DeFi swap review. AI prepares the request; I review route, amount, protocol, and slippage before my wallet approves.' },
      { id: 'risks',   label: 'Risks checked',    type: 'textarea', required: true, placeholder: 'Route, amount, protocol, slippage, transaction authority, fees, and unknown programs.' },
      { id: 'verdict', label: 'Risk verdict',     type: 'select',   required: true, options: ['Recorded', 'Warning', 'Blocked'] },
    ],
  },
  {
    id: 'rejection-receipt',
    title: 'Proof of Rejection',
    kind: 'rejection_receipt',
    category: 'common',
    description: 'Sign why a request was refused without exposing private wallet data.',
    summary: 'A wallet-signed proof that you rejected a request.',
    whatThisProves: 'The user intentionally rejected a request for a stated reason at a specific time.',
    recommendedUse: 'Use it to document unsafe agent requests, policy violations, support disputes, or blocked approvals.',
    fields: [
      { id: 'request', label: 'Rejected request',     type: 'textarea', required: true,  placeholder: 'Describe what the agent, site, or transaction asked for.' },
      { id: 'reason',  label: 'Reason for rejection', type: 'textarea', required: true,  placeholder: 'Unlimited approval, unknown custody, wrong recipient, route mismatch, private key request, etc.' },
      { id: 'policy',  label: 'Policy triggered',     type: 'text',     required: false, placeholder: 'Optional rule or policy this violated.' },
    ],
  },
  {
    id: 'tool-trace-receipt',
    title: 'Proof of Tool Trace',
    kind: 'tool_trace_receipt',
    category: 'common',
    description: 'Sign which tools, data, or checks an agent used before asking for wallet approval.',
    summary: 'A wallet-signed record of the tool/data trail behind a request.',
    whatThisProves: 'The listed tools, data, and result summary were part of the review context.',
    recommendedUse: 'Use it when an agent gathered quotes, simulations, balances, policy checks, or portfolio data.',
    fields: [
      { id: 'task',   label: 'Agent task',        type: 'textarea', required: true,  placeholder: 'What the agent was asked to prepare or review.' },
      { id: 'tools',  label: 'Tools / data used', type: 'textarea', required: true,  placeholder: 'Quote API, simulation, balance read, policy diff, portfolio read, transaction decoder, etc.' },
      { id: 'result', label: 'Result summary',    type: 'textarea', required: false, placeholder: 'Optional short conclusion from the tools.' },
    ],
  },
];

// ─── Advanced Proofs (15) — saved as Advanced Evidence Labs in the web ─────

const ADVANCED_PROOFS: ProofSpec[] = [
  { id: 'flight',        title: 'Flight Recorder',         kind: 'agent_flight_recorder',    category: 'advanced', description: "Bind the agent's stated intent, plan, tool trace, and risk interpretation to the wallet signature.", summary: 'Experimental record that binds agent intent, plan, tool trace, and risk interpretation.', whatThisProves: 'The stated intent and risk interpretation were signed at a specific review moment.', recommendedUse: 'Use only when testing advanced evidence concepts or demos.', defaultInput: 'Swap 0.05 SOL to USDC only if simulation shows no new authority grants and the route stays within 50 bps slippage.' },
  { id: 'auction',       title: 'Intent Auctions',         kind: 'signed_intent_auction',    category: 'advanced', description: 'Sign demand once, then let competing agents attach auditable offers without gaining custody.',         summary: 'Experimental record for comparing offers against a signed demand.',                       whatThisProves: 'The demand and caps existed before attached offers were reviewed.',                  recommendedUse: 'Use only when testing agent-market or quote-auction concepts.',                    defaultInput: 'Ask three quote agents for the best SOL to USDC route and select only offers matching my caps.' },
  { id: 'cosigner',      title: 'Risk Co-Signers',         kind: 'risk_cosigner_market',     category: 'advanced', description: 'Collect multiple agent reviews before the wallet opens for the final settlement signature.',         summary: 'Experimental record for multiple agent risk reviews.',                                     whatThisProves: 'A risk-review request was signed before final wallet approval.',                    recommendedUse: 'Use only when testing multi-agent risk review concepts.',                          defaultInput: 'Review this swap request for unknown programs, authority deltas, route drift, and hidden approvals.' },
  { id: 'rejection',     title: 'Rejection Intelligence',  kind: 'rejection_fingerprint',    category: 'advanced', description: 'Turn a rejection into a reusable local safety fingerprint.',                                          summary: 'Experimental local safety fingerprint for refused requests.',                              whatThisProves: 'A refusal pattern was signed as local evidence.',                                   recommendedUse: 'Prefer Rejection Receipt for normal public use.',                                  defaultInput: 'Reject any request that mentions unlimited approvals, private keys, or unknown custody delegation.' },
  { id: 'semantic',      title: 'Semantic Firewall',       kind: 'semantic_firewall',        category: 'advanced', description: 'Compare what the agent says with what the eventual transaction does.',                                summary: 'Experimental comparison between agent explanation and transaction semantics.',             whatThisProves: 'A semantic policy was signed before comparing against a later transaction.',       recommendedUse: 'Use only when testing transaction-explanation matching.',                          defaultInput: 'Allow SOL to USDC swap semantics only when touched programs and authority changes match the explanation.' },
  { id: 'nonaction',     title: 'Proof of Non-Action',     kind: 'signed_non_action',        category: 'advanced', description: 'Prove the agent checked conditions and intentionally avoided a wallet action.',                       summary: 'Experimental record that a checked condition did not trigger action.',                     whatThisProves: 'The agent/user intentionally avoided a wallet action under stated conditions.',    recommendedUse: 'Use only when testing non-action or restraint proofs.',                            defaultInput: 'Do nothing unless SOL drops below the signed threshold and liquidity remains above the floor.' },
  { id: 'reputation',    title: 'Agent Reputation',        kind: 'agent_reputation',         category: 'advanced', description: 'Make behavior portable across apps through wallet-signed outcome records.',                           summary: 'Experimental reputation record for agent behavior across apps.',                           whatThisProves: 'A reputation score or outcome summary was signed by the wallet.',                   recommendedUse: 'Use only when testing agent reputation concepts.',                                 defaultInput: 'Score the agent based on signed successes, rejections, warnings, and restraint proofs.' },
  { id: 'blinks',        title: 'Agent-Reviewed Links',    kind: 'agent_reviewed_blink',     category: 'advanced', description: 'Carry agent interpretation beside a Solana Action before wallet settlement.',                         summary: 'Experimental signed interpretation for Solana Actions or links.',                          whatThisProves: 'The wallet signed an interpretation of a link or action before settlement.',       recommendedUse: 'Prefer Risk Review Receipt for normal link review.',                               defaultInput: 'Review this Blink claim, summarize cost and authority deltas, and attach the signed interpretation.' },
  { id: 'capsule',       title: 'Intent Time Capsules',    kind: 'intent_time_capsule',      category: 'advanced', description: 'Sign future permission without allowing arbitrary future execution.',                                  summary: 'Experimental time-boxed intent envelope.',                                                 whatThisProves: 'The user signed a future intent envelope with stated conditions.',                  recommendedUse: 'Use only when testing delayed intent concepts.',                                   defaultInput: 'Seal an intent that can open later only if price, route, deadline, and slippage all match.' },
  { id: 'delegation',    title: 'Sub-Agent Delegation',    kind: 'sub_agent_delegation',     category: 'advanced', description: 'Let agents hire specialists while every responsibility slice remains signed and auditable.',          summary: 'Experimental record for delegated agent responsibility slices.',                           whatThisProves: 'A delegation scope was signed before specialists acted.',                          recommendedUse: 'Use only when testing sub-agent coordination.',                                    defaultInput: 'Delegate quote, risk, tax tag, and final explanation slices to specialist agents.' },
  { id: 'outcome',       title: 'Outcome Signatures',      kind: 'outcome_signature',        category: 'advanced', description: 'Give agents path freedom while the wallet signs the acceptable result envelope.',                     summary: 'Experimental result-envelope signature.',                                                  whatThisProves: 'The acceptable outcome was signed before route selection or execution.',           recommendedUse: 'Use only when testing outcome-constrained agents.',                                defaultInput: 'Authorize only the acceptable end state: minimum USDC output, no authority grants, and capped fees.' },
  { id: 'insurance',     title: 'Request Insurance',       kind: 'request_insurance',        category: 'advanced', description: 'Show deterministic risk-transfer terms beside the signing request.',                                  summary: 'Experimental risk-transfer terms attached to an approval request.',                        whatThisProves: 'Insurance or coverage terms were signed as context.',                              recommendedUse: 'Use only when testing insurance-style request metadata.',                          defaultInput: 'Quote coverage for route mismatch, simulation divergence, and known exploit classes.' },
  { id: 'constitution',  title: 'Personal Constitution',   kind: 'personal_constitution',    category: 'advanced', description: 'Diff each request against a portable wallet-signed personal policy.',                                 summary: 'Experimental portable wallet policy.',                                                     whatThisProves: 'A personal wallet policy existed before request review.',                          recommendedUse: 'Prefer Policy Receipt for normal public use.',                                     defaultInput: 'My wallet never signs unlimited approvals, mainnet-first tests, or swaps above 100 bps slippage.' },
  { id: 'receipts',      title: 'Tool Receipts',           kind: 'tool_receipts',            category: 'advanced', description: 'Prove which tools and data the agent actually used before requesting approval.',                      summary: 'Experimental tool-hash receipt.',                                                          whatThisProves: 'Tool hashes and data references were signed as review context.',                    recommendedUse: 'Prefer Tool Trace Receipt for normal public use.',                                 defaultInput: 'Attach hashes for portfolio read, quote, simulation, policy diff, and final explanation tools.' },
  { id: 'apprentice',    title: 'Apprenticeship Mode',     kind: 'apprenticeship_mode',      category: 'advanced', description: 'Require signed predictions and scorecards before an agent graduates to production signing.',          summary: 'Experimental agent training scorecard.',                                                   whatThisProves: 'Training scenarios or scorecards were signed before production use.',              recommendedUse: 'Use only when testing agent evaluation workflows.',                                defaultInput: 'Run five training scenarios and score the agent before granting live signing authority.' },
];

export const PROOF_SPECS: ProofSpec[] = [...COMMON_PROOFS, ...ADVANCED_PROOFS];

export function listProofSpecs(category?: 'common' | 'advanced'): ProofSpec[] {
  if (!category) return PROOF_SPECS;
  return PROOF_SPECS.filter((s) => s.category === category);
}

export function resolveProofSpec(idOrIndex: string): ProofSpec | undefined {
  const value = idOrIndex.trim().toLowerCase();
  const n = Number(value);
  if (Number.isInteger(n) && n >= 1 && n <= PROOF_SPECS.length) {
    return PROOF_SPECS[n - 1];
  }
  return PROOF_SPECS.find((s) => s.id === value || s.kind === value);
}
