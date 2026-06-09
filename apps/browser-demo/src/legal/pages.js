// Plain ES module — importable by Vite (browser bundle) AND Node (post-build
// prerender script in apps/browser-demo/scripts/prerender-legal.mjs). Kept
// TS-free so the Node script can `import` it without a TS runner.

export function privacyPage() {
  return `
    <section class="docs-section legal-page" aria-labelledby="privacy-title">
      <div class="section-heading">
        <p class="eyebrow mini">Legal</p>
        <h2 id="privacy-title">Privacy Policy</h2>
        <p class="legal-meta">Last updated: 2026-05-07</p>
      </div>
      <article class="legal-prose">
        <p>SolPulse LLC ("SolPulse," "we," "our," or "us") values your privacy and is committed to protecting your information. This Privacy Policy describes how we collect, use, store, and disclose information when you access or use the Agentic websites, command-line interface, desktop app, browser app, mobile clients, runtime bridge, APIs, or related services (collectively, the "Platform" or "Agentic"). Agentic is a non-custodial wallet authority adapter — we do not take possession of your assets or private keys. You remain in full control of your wallets and signatures at all times, but certain data you provide or that we collect may still constitute personal data under applicable privacy laws.</p>
        <p>By accessing or using Agentic, you acknowledge that you have read, understood, and agree to this Privacy Policy. If you disagree with any portion of this Policy, please discontinue use of the Platform.</p>

        <h3>Quick Summary</h3>
        <ul>
          <li><strong>No private keys:</strong> Agentic does not ask for, collect, store, transmit, recover, or custody seed phrases, private keys, or wallet recovery credentials.</li>
          <li><strong>No hosted account required:</strong> the current public app does not require an Agentic account.</li>
          <li><strong>Local-first runtime:</strong> CLI, desktop, bridge settings, approval queues, bridge tokens, Android MWA authorization cache, and app logs are designed to stay on your device unless you choose to send information to us for support or connect them to third-party services.</li>
          <li><strong>Android permissions:</strong> the Android app currently requests Internet access and foreground data-sync service permissions for wallet approval and bridge polling. It does not request camera, microphone, contacts, SMS, phone, precise location, health, calendar, or file-system permissions.</li>
          <li><strong>No ad sale:</strong> we do not sell personal information and do not share it for cross-context behavioral advertising.</li>
          <li><strong>Public blockchain:</strong> wallet addresses, transaction IDs, signatures, balances, token activity, timing, and other on-chain data may be public, permanent, and outside our control.</li>
        </ul>

        <h3>1. Information We Collect</h3>
        <p><strong>A. Information You Provide</strong></p>
        <ul>
          <li>Contact details such as your email address (when you contact support)</li>
          <li>Wallet information such as your Solana public key when you connect a wallet to a demo or web flow (which may be considered personal data when linked to other identifiers)</li>
          <li>Any content you submit via forms, customer support, feedback surveys, community channels, or app-store review communications</li>
          <li>AI planner prompts, templates, parameters, policy notes, and model settings you enter when you use the optional planner features</li>
          <li>AI provider keys you choose to enter. Browser session keys stay in the current browser runtime, bridge keys are intended to stay in local bridge process memory unless you configure otherwise, and Hosted BYOK keys are relayed through the same-origin Agentic server only for the current draft request and are not stored by Agentic.</li>
        </ul>
        <p>We do not require know-your-customer (KYC) verification because the Platform is non-custodial and does not match, settle, or take the other side of any trade. However, regulations may change; we reserve the right to request additional information to comply with applicable laws or to prevent fraud, money laundering, or other illicit activity.</p>
        <p><strong>B. Information We Collect Automatically</strong></p>
        <ul>
          <li>Technical data such as your IP address, browser type, device operating system, and user-agent information</li>
          <li>Usage data such as access timestamps, referral URLs, pages visited, and actions taken on the public website</li>
          <li>Wallet-connection events on the website (for example, when you connect, approve, or disconnect a wallet for a demo)</li>
          <li>Approximate geolocation information inferred from your IP address, to comply with sanctions and jurisdictional restrictions</li>
          <li>Android app technical data needed for Mobile Wallet Adapter operation, such as wallet package or URI availability checks, public wallet address, account label if supplied by the wallet, cluster, wallet capabilities, shortened signatures or transaction IDs in local logs, foreground service status, and bridge polling status</li>
          <li>App diagnostics, errors, and security telemetry such as request IDs, timestamps, status codes, rejected wallet operations, and redacted log metadata</li>
        </ul>
        <p>The Agentic CLI, desktop runtime, Android MWA surface, and bridge run <strong>locally on your device</strong> and are not telemetered to SolPulse by default. Approval rails, prepared-action queues, Android authorization cache, signing flows, bridge tokens, and local logs execute or persist on your machine; we do not receive telemetry on transaction content unless you contact us with a support request that you elect to attach.</p>
        <p><strong>C. Public Blockchain Data</strong></p>
        <p>Transactions you broadcast to the Solana blockchain are publicly accessible and cannot be erased. We do not control or store on-chain data, but we may analyse publicly available blockchain information to detect suspicious activity, debug issues, or improve documentation.</p>

        <h3>2. How We Use Your Information</h3>
        <ul>
          <li>To provide, operate, maintain, and improve the Platform and its tooling</li>
          <li>To respond to support requests and feedback</li>
          <li>To analyse usage patterns and improve performance and reliability of the public website</li>
          <li>To enforce our Terms of Service, detect and prevent fraud, abuse, or other misuse</li>
          <li>To communicate with you about updates, new features, or regulatory notices (with your consent where required)</li>
          <li>To comply with applicable laws, regulations, and legal processes</li>
        </ul>
        <p>We do not sell your personal data. We may share it with service providers who help us operate the Platform under strict confidentiality obligations, and with regulators or law enforcement if required by law.</p>

        <h3>3. Cookies, Local Storage & Analytics</h3>
        <p>The Agentic website uses browser-based storage methods such as IndexedDB and localStorage to maintain app state, selected wallet name, selected cluster, bridge URL, bridge token, lab artifacts, UI preferences, and similar local workspace data. When a local bridge is connected, signed lab artifacts may also be mirrored to a local bridge archive file. The Android app may store Mobile Wallet Adapter authorization records in app-private storage so you can reconnect a previously approved wallet. You may clear browser storage, app storage, or local runtime files, but doing so may remove preferences, authorization cache, receipts, or local artifacts.</p>
        <p>We use Google Analytics 4 on the public marketing site and hosted app when a measurement ID is configured. Google Analytics may collect or process page views, route changes, download clicks, navigation clicks, wallet-connect events, planner button clicks, device/browser information, approximate location, and related identifiers according to Google&apos;s terms and settings. We do not send wallet addresses, signatures, transaction IDs, AI prompts, AI keys, bridge tokens, or raw user-entered planner values to Google Analytics, and we do not use Google Analytics to sell personal information or for cross-context behavioral advertising.</p>

        <h3>4. Data Storage & Security</h3>
        <p>We implement reasonable technical and organizational measures designed to protect your personal information. Examples include encryption in transit via SSL/TLS, secure infrastructure, and access controls. Despite these measures, no method of transmission or storage is completely secure; you use the Platform at your own risk.</p>
        <p>We retain your information only as long as necessary to provide the Platform, comply with our legal obligations, resolve disputes, and enforce our agreements. Where feasible, we minimize data and may anonymize or aggregate information to further protect your privacy. You remain responsible for securing your device, browser profile, wallet app, seed phrase, bridge token, AI provider key, and any third-party agent software you connect.</p>

        <h3>5. Children's Privacy</h3>
        <p>Agentic does not knowingly collect or store data from anyone under the age of 18. If you are a parent or guardian and believe your child has submitted information to us, contact us at support@solpulse.trade and we'll promptly delete it.</p>

        <h3>6. Information Sharing</h3>
        <p>We may share your data with service providers who support our infrastructure, analytics, or communications; legal authorities, if required by law or in connection with a legal investigation; and third-party tools, only when necessary and never for marketing resale purposes.</p>

        <h3>7. International Data Transfers</h3>
        <p>SolPulse LLC operates globally. Your information may be processed in countries outside of your jurisdiction of residence, which may have different data protection laws. Where required by law, we use appropriate safeguards, such as standard contractual clauses, to protect cross-border data transfers. By using the Platform, you consent to this processing and transfer of your information.</p>

        <h3>8. Your Rights</h3>
        <p>Depending on your jurisdiction, you may have the right to request access to your personal information, request deletion of your personal data, or opt out of email communications. Signed-in Agentic Cloud users can also delete wallet-scoped Cloud Workspace Data from the Connect Cloud Storage tab after signing a wallet ownership confirmation. See the <a href="/delete-account">Delete Account</a> page for step-by-step instructions and the exact scope of what is deleted versus retained. To exercise broader rights, email us at support@solpulse.trade. We will remove your personal data within 30 days of a verified request, except where retention is required by law (e.g., compliance logs).</p>

        <h3>9. Updates to This Policy</h3>
        <p>We may update this Privacy Policy from time to time. The most current version will always be available at https://agentic-signer.com/privacy. Your continued use of Agentic after changes are posted signifies your acceptance of those changes.</p>

        <h3>10. Contact Us</h3>
        <p>If you have any questions or requests regarding this Privacy Policy, you can reach us at:</p>
        <ul>
          <li>📧 Email: support@solpulse.trade</li>
          <li>📍 Location: SolPulse LLC, 1621 Central Ave, Cheyenne, WY 82001</li>
        </ul>

        <h3>11. Do Not Sell or Share Personal Information</h3>
        <p>We do not sell your personal information and we do not share it for cross-context behavioral advertising. We disclose personal information only to service providers and processors under written agreements to operate the Platform, or where required by law.</p>

        <h3>12. Legal Bases for Processing (where applicable)</h3>
        <ul>
          <li><strong>Contract:</strong> to provide and support the Platform you request.</li>
          <li><strong>Legitimate Interests:</strong> to secure, improve, and support the Platform; prevent fraud and abuse; understand usage.</li>
          <li><strong>Consent:</strong> for optional diagnostics, marketing communications, or non-essential cookies.</li>
          <li><strong>Legal Obligation:</strong> to satisfy regulatory, tax, accounting, and law-enforcement requirements.</li>
        </ul>

        <h3>13. Data Retention & Deletion</h3>
        <ul>
          <li><strong>Public-website usage logs:</strong> approximately 30–90 days, extendable for security or abuse investigations.</li>
          <li><strong>Support tickets &amp; attachments:</strong> active ticket duration plus up to 24 months.</li>
          <li><strong>Google Analytics 4 data, when enabled:</strong> retained according to the configured Google Analytics property retention settings and applicable Google controls.</li>
          <li><strong>Local-device data (CLI, runtime, desktop bridge, Android MWA app, local logs, authorization cache, bridge tokens, session AI keys, and receipts):</strong> stays on your device under your control; we do not retain it unless you send it to us.</li>
          <li><strong>Public blockchain data:</strong> may be permanent and cannot be deleted or modified by SolPulse.</li>
          <li><strong>Legal, safety, and compliance records:</strong> retained as long as necessary to satisfy legal obligations, sanctions controls, fraud prevention, security, dispute resolution, or legal defense.</li>
        </ul>

        <h3>14. Third-Party Services & Processors</h3>
        <p>We rely on third-party providers to operate the public-facing parts of the Platform. These providers act as processors or service providers under contracts that restrict their use of personal information to the services we request.</p>
        <ul>
          <li><strong>Wallet Standard wallets</strong> (Phantom, Solflare, Backpack, Glow, etc.) — chosen by you. When you connect a wallet, that wallet provider's privacy policy applies to wallet-side data, including key custody and recovery.</li>
          <li><strong>Mobile Wallet Adapter wallets and Android platform services</strong> — chosen by you or provided by the Android/browser environment to route approvals, foreground data-sync behavior, and wallet handoffs.</li>
          <li><strong>Solana RPC providers</strong> (e.g., Helius, public mainnet RPC, or configured RPC endpoints) — for on-chain reads, simulations, balance checks, and transaction submission initiated by you, your wallet, or your agent.</li>
          <li><strong>Hosting (Render), Google Play, Chrome/Custom Tabs/TWA, and app-store services</strong> — to distribute or serve the public website and Android app surfaces.</li>
          <li><strong>Optional AI clients and providers</strong> (Anthropic Claude, OpenAI/Codex, Vercel AI SDK, third-party MCP servers, or OpenAI-compatible providers you configure) — your chosen agent client, browser session key, local bridge, or hosted BYOK request calls them under its own terms and privacy policy. Hosted BYOK relays your API key to the selected provider for that request and does not store it.</li>
          <li><strong>Google Analytics 4</strong> — aggregated usage measurement for product and reliability analysis when configured, subject to Google Analytics configuration and applicable consent requirements.</li>
        </ul>

        <h3>15. Additional Rights by Jurisdiction</h3>
        <p>Depending on where you live (e.g., EEA/UK, California), you may have additional rights, such as portability, restriction, objection to certain processing, and the right to appeal automated decisions. To exercise any rights beyond those listed above, contact us using the details in the "Contact Us" section.</p>

        <h3>16. AML / CTF & Sanctions Processing</h3>
        <p>Although Agentic is a non-custodial software interface and is not itself a regulated financial intermediary, we may collect and process limited identifiers, contact information, wallet addresses, approximate location signals, device or session identifiers, and screening results from compliance service providers to comply with anti-money-laundering (AML), counter-terrorist-financing (CTF), and sanctions requirements. Where required, we may request additional verification or documentation. Processing is based on our legal obligations and our legitimate interests in maintaining Platform integrity and compliance. We may disclose relevant information to competent authorities or service providers when legally required or to prevent fraud or abuse.</p>

        <h3>17. Geographic Restrictions</h3>
        <p>We may use IP address, coarse location, and related technical signals to determine feature availability and to restrict access from prohibited or high-risk jurisdictions for compliance and safety purposes. These signals are approximate and do not constitute precise geolocation. We may retain logs necessary to demonstrate compliance with sanctions and other legal requirements.</p>

        <h3>18. Third-Party Data, Content & Links</h3>
        <p>The Platform may display market data, token metadata, pricing, RPC results, or other content provided by third parties and may include links to external websites. We do not control third-party content and are not responsible for its accuracy or availability. Your interactions with third-party services are governed by their own terms and policies. Where technically necessary, we may transmit limited identifiers to such services to enable functionality.</p>

        <h3>19. Security Telemetry & Malicious Code</h3>
        <p>While we employ reasonable safeguards, we cannot guarantee that files or data available through the Platform are free from viruses, malware, or other harmful components, or that services will be immune to denial-of-service or similar attacks. To protect the Platform, we may collect security telemetry such as error codes, request metadata, and limited device signals for detection, prevention, and response. You remain responsible for appropriate device and account security measures.</p>

        <h3>20. Tutorials, Documentation & Help Resources</h3>
        <p>Tutorials, videos, FAQs, and helpdesk responses describe Platform functionality only and are not personalized advice, suitability assessments, or recommendations. We may process the content of your help requests and attachments to resolve issues and improve quality. Aggregated, de-identified analytics may be used to improve support resources.</p>

        <h3>21. Google Play Data Safety & Financial Features</h3>
        <p>If Agentic is distributed through Google Play, the Google Play Data Safety form and any Financial features declaration must be kept consistent with this Privacy Policy and the actual Android app behavior. Because Agentic involves cryptocurrency wallet actions, SolPulse may disclose financial-feature information to Google Play and may update app availability, disclosures, or functionality to satisfy store policy or applicable law.</p>
      </article>
    </section>
  `;
}

export function deleteAccountPage() {
  return `
    <section class="docs-section legal-page" aria-labelledby="delete-account-title">
      <div class="section-heading">
        <p class="eyebrow mini">Legal</p>
        <h2 id="delete-account-title">Delete your Agentic account and data</h2>
        <p class="legal-meta">Last updated: 2026-05-20</p>
      </div>
      <article class="legal-prose">
        <p>This page explains how to delete your Agentic account and the data SolPulse holds about you. Agentic is operated by SolPulse LLC. If you have any difficulty completing the steps below, email <a href="mailto:support@solpulse.trade">support@solpulse.trade</a> and we will process your request manually.</p>

        <h3>What counts as your "account"</h3>
        <p>Agentic does not use usernames, passwords, OAuth providers, email accounts, or phone numbers. Your Solana wallet public key is the account identifier. Cloud sync is optional: signed-out users have no server-side state to delete.</p>
        <p>If you have never connected a wallet to Agentic Cloud (the "Connect Cloud Storage" tab in Preferences), there is nothing for you to delete here. On-device data such as drafts, approvals, and receipts saved on the "Saved on device" path can be cleared by clearing your browser site data or uninstalling the app.</p>

        <h3>How to delete your cloud data</h3>
        <ol>
          <li>Open <a href="/app">agentic-signer.com/app</a>.</li>
          <li>Connect the wallet whose data you want to delete.</li>
          <li>Open <strong>Preferences → Connect Cloud Storage</strong>.</li>
          <li>Scroll to <strong>Danger Zone</strong> at the bottom of the panel.</li>
          <li>Tap <strong>Delete all app data</strong>.</li>
          <li>Sign the deletion-confirmation message in your wallet when prompted.</li>
          <li>All cloud data scoped to that wallet is removed immediately. After the cloud delete succeeds, the current app clears its local browser or webview storage and reloads into a fresh state.</li>
        </ol>
        <p>On the desktop, Android, and iOS apps, the same flow is available inside the bundled app under <strong>Preferences → Connect Cloud Storage → Danger Zone</strong>.</p>

        <h3>What gets deleted</h3>
        <ul>
          <li>Cloud drafts and plans</li>
          <li>Pending and completed approval requests</li>
          <li>Recurring payment schedules and their occurrence history</li>
          <li>Evidence receipts and audit events</li>
          <li>Encrypted connector API keys (Magic Eden, Tensor, Sanctum, and any other BYO keys you stored)</li>
          <li>Wallet preferences and saved settings</li>
          <li>Active Agentic Cloud session and signed-in state</li>
          <li>Current app localStorage, sessionStorage, IndexedDB, CacheStorage, session AI keys, Device Agent config, and native cached wallet authorizations where available</li>
        </ul>

        <h3>What is kept and why</h3>
        <ul>
          <li><strong>On-chain Solana transaction history.</strong> Transactions you broadcast live on the public Solana blockchain. They are permanent and outside SolPulse's control. Nobody can delete them, including us.</li>
          <li><strong>Google Analytics events.</strong> Anonymous client_id and aggregated usage events stored by Google. To delete these directly, visit <a href="https://tools.google.com/dlpage/gaoptout" target="_blank" rel="noreferrer">tools.google.com/dlpage/gaoptout</a>. You can also email <a href="mailto:support@solpulse.trade">support@solpulse.trade</a> and we will submit a User Deletion API request to Google on your behalf.</li>
          <li><strong>Compliance and security logs.</strong> A limited window of server logs (truncated user-agent, request path, version, IP) may be retained for fraud prevention and abuse mitigation. These logs are not associated with your wallet identity after deletion and are retained for no longer than 90 days.</li>
          <li><strong>Support correspondence.</strong> If you have emailed support, those threads are kept under our standard support retention (active ticket plus up to 24 months). You can request deletion of support correspondence in the same email.</li>
        </ul>

        <h3>Alternative — email request</h3>
        <p>If you cannot access the in-app deletion flow (lost wallet access, device unavailable, etc.), email <a href="mailto:support@solpulse.trade">support@solpulse.trade</a> with the wallet address you want to delete. We verify wallet ownership through a signed message exchange before processing the request. Verified requests are completed within 30 days.</p>

        <h3>Retention</h3>
        <p>Retention period for cloud data after a successful in-app deletion or a verified email request: <strong>immediate</strong>. The cascade delete runs atomically against all wallet-scoped tables (drafts, approvals, recurring schedules, receipts, audit events, connector secrets, wallet preferences). Items in the "kept" list above are retained only for the stated purposes and durations.</p>

        <h3>Contact</h3>
        <p>SolPulse LLC, 1621 Central Ave, Cheyenne, WY 82001 · <a href="mailto:support@solpulse.trade">support@solpulse.trade</a></p>
      </article>
    </section>
  `;
}

export function termsPage() {
  return `
    <section class="docs-section legal-page" aria-labelledby="terms-title">
      <div class="section-heading">
        <p class="eyebrow mini">Legal</p>
        <h2 id="terms-title">Terms of Service</h2>
        <p class="legal-meta">Last updated: 2026-06-09</p>
      </div>
      <article class="legal-prose">
        <p>These Terms of Service ("Terms") constitute a legally binding agreement between you ("you" or "User") and SolPulse LLC ("SolPulse," "we," "our," or "us"). These Terms govern your use of the Agentic websites, command-line interface, desktop app, browser app, mobile clients, runtime bridge, APIs, and other services provided by SolPulse (collectively, the "Platform" or "Agentic"). By accessing or using the Platform, you acknowledge that you have read, understood, and agree to be bound by these Terms. If you do not agree, you must not use the Platform.</p>

        <h3>1. Eligibility</h3>
        <p>You may use the Platform only if you are at least 18 years of age and have the legal capacity to enter into a binding contract. You are solely responsible for ensuring that your use of the Platform complies with all laws and regulations applicable to you. Access to the Platform may not be legal for certain persons or in certain countries. If use of the Platform is prohibited by law in your jurisdiction, you must not use it.</p>

        <h3>2. Use of the Platform</h3>
        <p>The Platform is provided for your personal and lawful use only. You agree that you will not:</p>
        <ul>
          <li>Use the Platform for any unlawful or fraudulent purpose, including activities that violate anti-money laundering or sanctions laws</li>
          <li>Interfere with or disrupt the integrity or performance of the Platform, or attempt to circumvent any measures we use to prevent or restrict access</li>
          <li>Transmit viruses, worms, or other malicious code</li>
          <li>Use robots, scrapers, or other automated means not provided by us to access the public website in a manner that sends more requests to our servers than a human can reasonably produce in the same period</li>
          <li>Use another User's account or session credentials without permission, or share your own</li>
        </ul>
        <p><strong>2a. License Grant.</strong> Subject to your continued compliance with these Terms, SolPulse grants you a limited, revocable, non-exclusive, non-transferable, non-sublicensable license to access and use the Platform for your personal, non-commercial activity. No other rights are granted. Any rights not expressly granted are reserved. You may not rent, lease, resell, sublicense, or commercially exploit the Platform, or any part of it, without our prior written consent.</p>

        <h3>3. Web3 Access & Wallets</h3>
        <p>Agentic is a <strong>non-custodial wallet authority adapter</strong>: we do not hold or control your cryptocurrency, your private keys, or your seed phrase. You connect your own Wallet Standard, Mobile Wallet Adapter, or other supported wallet (such as Phantom, Solflare, Backpack, or Glow), and you remain responsible for:</p>
        <ul>
          <li>Generating, maintaining, and safeguarding your own private keys, seed phrases, and wallet credentials</li>
          <li>Reviewing every prepared transaction surfaced by the Platform — including transfers, approvals, swaps, and any agent-initiated action — before signing it</li>
          <li>Configuring and revoking any caps, allowlists, recurring payments, or pre-approved categories you enable</li>
        </ul>
        <p>Because the Platform is non-custodial, <strong>losing access to your private keys will permanently prevent you from accessing your assets</strong>. We have no ability to reset, retrieve, or restore lost keys or funds.</p>
        <p>If you use a third-party embedded wallet, hardware wallet, or wallet-as-a-service product, key recovery and custody are subject to that provider's terms and infrastructure. We do not control third-party wallet providers and are not liable for their unavailability, security breaches, or loss of access.</p>

        <p><strong>3a. Agent / MCP Risk.</strong> Agentic exists to let AI agents — including but not limited to large language models, MCP servers, third-party agent frameworks, scheduled bots, and any automation you connect to the Platform — propose wallet actions for your review. <strong>The agent's request is a proposal; your click is the authority.</strong> You acknowledge and accept that:</p>
        <ul>
          <li>AI agents and LLMs can hallucinate, be prompt-injected, behave unexpectedly, or be authored by malicious third parties</li>
          <li>A buggy or hostile agent could attempt to author transactions that drain, lock, or otherwise harm your wallet if signed</li>
          <li>Agentic's role is to surface the proposed action so you can review it; the Platform does not auto-approve and does not vet the agent's intent</li>
          <li>AI providers (Anthropic, OpenAI, third-party MCP authors, Vercel AI, etc.) are not SolPulse's agents, employees, or representatives; their behavior is not under our control</li>
          <li>Optional AI planner features only prepare plans or explanations; they do not make a transaction safe, signed, submitted, profitable, reversible, or suitable for you</li>
          <li>You remain solely responsible for what you sign, including approvals issued by automation or pre-authorized categories you enabled</li>
        </ul>

        <p><strong>3b. What Agentic Does Not Do.</strong> Agentic does <strong>not</strong>:</p>
        <ul>
          <li>Custody, hold, or escrow your digital assets</li>
          <li>Generate, store, or recover seed phrases or private keys</li>
          <li>Auto-approve transactions on your behalf</li>
          <li>Call AI providers without your chosen AI path. Hosted BYOK relays only the draft request you submit; browser session, local bridge, and external agent clients call providers under their own configuration and provider policies</li>
          <li>Match, settle, or take the other side of any trade</li>
          <li>Operate an order book, an exchange, or a liquidity pool</li>
        </ul>

        <p><strong>3c. Bring-Your-Own AI Keys.</strong> If you paste or configure an AI provider key, base URL, model name, prompt, template, or plan parameter in Agentic, you are instructing the selected AI path to contact that provider. Hosted BYOK sends the key and draft request through the same-origin Agentic server for that request only; browser session and local bridge paths use your browser or local runtime. You are responsible for the provider you choose, its terms, its privacy practices, its billing, and the content you send to it. SolPulse does not guarantee that provider responses are accurate, secure, compliant, or fit for any purpose. Never enter a wallet seed phrase, private key, recovery phrase, or unrestricted credential into any AI prompt, MCP server, bridge, or support request.</p>

        <h3>4. Platform Fees</h3>
        <p><strong>4a. Swap Platform Fee.</strong> When you execute a token <strong>swap</strong> through the Platform, SolPulse charges a platform fee of up to one-half of one percent (0.50%) of the input amount of that swap (the "Swap Platform Fee"). The fee rate currently in effect may be lower than the stated maximum and may be modified by SolPulse at its sole discretion at any time without prior notice. The Swap Platform Fee is collected automatically as part of the same on-chain swap transaction routed through our third-party swap provider (currently Jupiter); the routing provider determines which token the fee is taken in and may retain a portion of it. The Swap Platform Fee applies to swaps only — it does <strong>not</strong> apply to transfers, sends, or any other signed action. By executing a swap through the Platform you acknowledge and agree to pay the Swap Platform Fee at the rate in effect at the time of the swap. The Swap Platform Fee is non-refundable, including for failed, reverted, partially filled, or economically unfavorable swaps, except where a refund is required by applicable law.</p>
        <p><strong>4b. Fee Composition.</strong> In addition to the Swap Platform Fee, each swap or transaction may incur the following charges, which are set by third parties and not by SolPulse:</p>
        <ul>
          <li>Solana network fees (base transaction fee, priority fee, and any compute-budget cost paid to validators)</li>
          <li>Protocol or liquidity-pool fees charged by the underlying decentralized exchange or aggregator (typically 0.15% – 5%)</li>
          <li>Optional MEV-protection tips (for example, Jito bundle tips) if you elect to use them</li>
          <li>Price impact and slippage resulting from your trade size and pool depth</li>
        </ul>
        <p>These third-party fees are determined by the protocol, network state, and your own slippage and priority settings. SolPulse does not control or receive any portion of protocol fees, network fees, or MEV tips.</p>
        <p><strong>4c. Software Provider; No Custody, No Counterparty.</strong> SolPulse is a software provider only. Charging the Swap Platform Fee does not make SolPulse a custodian, broker, exchange, or counterparty. Swaps execute on third-party venues — including Jupiter Aggregator and the automated market makers it routes through (such as Raydium, Orca, and Meteora) — which SolPulse does not own, operate, or control. Agentic remains a non-custodial wallet authority adapter: you sign every swap with your own wallet, and the fee is included in that same transaction.</p>
        <p><strong>4d. Fee Estimates.</strong> Any pre-swap fee, price, slippage, route, or output estimate displayed by the Platform is provided for informational convenience only and may differ from the actual on-chain result due to network conditions, slippage, routing changes, MEV activity, or third-party protocol behavior. SolPulse does not guarantee the accuracy of any displayed estimate.</p>
        <p><strong>4e. Referral Discounts.</strong> SolPulse may, at its sole discretion, offer referred users a reduced Swap Platform Fee rate and may pay referrers a percentage of Swap Platform Fees paid by users they refer. Eligibility, rates, and payment cadence for any such referral or rewards program are described separately on the Platform and may be changed, paused, or discontinued at any time without prior notice.</p>
        <p><strong>4f. Other Fees.</strong> The Platform is otherwise currently provided without subscription fees. SolPulse may, in the future, offer paid features, subscriptions, or premium tiers. If we do, the pricing, billing terms, and payment schedule will be presented at signup, and your use of those paid features will be subject to these Terms together with any additional, feature-specific terms posted at the time of purchase. Network fees, RPC fees, protocol fees, and any other third-party fees you incur when broadcasting transactions through the Platform are set by third parties and not by SolPulse.</p>

        <h3>5. Risk Disclosure</h3>
        <p><strong>Crypto and agent-action risk.</strong> The cryptocurrency market is extremely volatile, and the use of AI agents to interact with on-chain protocols is novel and carries unique risk. By using the Platform, you acknowledge and agree that:</p>
        <ul>
          <li>You are solely responsible for your transactions and decisions and assume all risk associated with them</li>
          <li>You may lose some or all of your capital; there is no guarantee of profit or asset preservation</li>
          <li>An AI agent or MCP server can prepare transactions you did not intend; reviewing each approval is your responsibility</li>
          <li>Past performance of any strategy, agent, market, or protocol does not guarantee future results</li>
          <li>Market manipulation, pump-and-dump schemes, prompt injection, hostile MCP servers, and other fraudulent or adversarial activities may affect your outcomes; you should conduct your own due diligence and remain vigilant</li>
        </ul>
        <p>SolPulse provides software and a consent rail. We are <strong>not</strong> a broker-dealer, investment adviser, or financial advisor. Nothing on the Platform constitutes financial advice. Please consult a qualified professional before making financial decisions.</p>
        <p><strong>Voluntary assumption of risk.</strong> By using the Platform, you voluntarily assume all risks associated with cryptocurrency activity and agent-mediated transactions, including the risk of total and permanent loss of all funds in your wallet. You acknowledge that digital assets are not legal tender, are not backed by any government, and are not insured by any federal or state agency (including the FDIC or SIPC). You agree not to hold SolPulse liable for any losses, missed actions, failed transactions, or adverse outcomes resulting from your use of the Platform or from agents you connect to it.</p>

        <h3>6. Compliance & Regulatory Status</h3>
        <p>Agentic is a non-custodial software interface that brokers wallet authority between you and the agents you choose to connect. We do not operate an exchange, an order book, a matching engine, or a liquidity pool. We do not take the other side of any trade. We do not hold, custody, or control your funds or private keys at any time. All transactions are signed by you in your own wallet and broadcast to public networks (such as Solana) through third-party RPC providers and on-chain protocols.</p>
        <p>SolPulse intends Agentic to operate as non-custodial software and not as a money transmitter, broker, dealer, exchange, investment adviser, bank, fiduciary, payment processor, or other regulated financial intermediary. Laws and regulations regarding digital assets, wallets, AI agents, and automated approvals are evolving and may be interpreted differently by different authorities. You are responsible for determining whether use of the Platform is permitted under the laws of your jurisdiction and for complying with any applicable licensing, registration, tax, accounting, or reporting obligations. We reserve the right to implement KYC/AML procedures, sanctions screening, geoblocking, app-store declarations, feature restrictions, or other compliance measures as necessary to meet legal requirements or risk controls.</p>

        <h3>7. No Warranty</h3>
        <p>The Platform and all related services are provided on an "as is" and "as available" basis without warranty of any kind. To the fullest extent permitted by law, SolPulse disclaims all warranties, express or implied, including but not limited to warranties of merchantability, fitness for a particular purpose, accuracy, non-infringement, and uninterrupted or error-free operation. We do not guarantee the availability, timeliness, completeness, or reliability of any information, agent integration, or feature offered through the Platform. You use the Platform at your own risk.</p>

        <h3>8. Limitation of Liability</h3>
        <p>To the maximum extent permitted by law, SolPulse and its directors, employees, agents, and affiliates will not be liable to you for any indirect, incidental, special, punitive, or consequential damages arising out of or in connection with your use of the Platform, even if we have been advised of the possibility of such damages. This limitation applies to, but is not limited to: any loss of profits, revenue, or data; loss of digital assets or cryptocurrency; trading or position losses; missed or failed transactions; liquidation events; losses from rug pulls, scams, exploits, prompt injection, hostile agents, or malicious MCP servers; losses caused by third-party protocol failures; losses due to network congestion, RPC outages, or MEV; losses from automation or agent malfunction; business interruption; or any other economic disadvantage. In no event shall our aggregate liability exceed the greater of (a) the amount you paid to us in the twelve months preceding the claim, or (b) one hundred US dollars (USD $100). Some jurisdictions do not allow limitations on implied warranties or liability; in such jurisdictions, our liability shall be limited to the greatest extent permitted by law.</p>
        <p><strong>Claims Only Against the Company.</strong> You agree that any claim you may have in connection with the Platform may be brought only against SolPulse LLC and not against its owners, officers, directors, employees, contractors, affiliates, service providers, or licensors in their personal or individual capacity. This limitation applies to the fullest extent permitted by law.</p>

        <h3>9. Intellectual Property</h3>
        <p>All intellectual property rights in the Platform, including but not limited to branding, UI, documentation, hosted service configuration, app-store listings, images, names, logos, and non-open-source assets, remain the property of SolPulse or its licensors. Open-source code published by SolPulse is governed by the open-source license included with that code, currently Apache-2.0 for this repository. These Terms do not reduce rights granted to you under that open-source license, but they do not grant rights to use SolPulse names, logos, trade dress, hosted services, app listings, or other brand assets except as expressly permitted in writing.</p>
        <p>All trademarks, service marks, trade names, logos, and brand identifiers appearing on the Platform that are not owned by SolPulse are the property of their respective owners. Reference to any third-party mark, protocol, token, or service is for identification only and does not imply endorsement, partnership, or affiliation.</p>
        <p><strong>9a. Copyright & DMCA.</strong> SolPulse respects the intellectual property rights of others and expects users of the Platform to do the same. If you believe material accessible on or from the Platform infringes your copyright, you may request its removal by sending a written notice of infringement to our designated agent that includes: (a) a physical or electronic signature of the copyright owner or a person authorized to act on their behalf; (b) identification of the copyrighted work claimed to be infringed; (c) identification of the allegedly infringing material and information reasonably sufficient to locate it on the Platform; (d) your contact information (name, address, telephone number, and email); (e) a statement that you have a good-faith belief that the use is not authorized by the copyright owner, its agent, or the law; and (f) a statement, made under penalty of perjury, that the information in your notice is accurate and that you are the copyright owner or authorized to act on the owner's behalf. Send notices to our DMCA agent at support@solpulse.trade with the subject line "DMCA Notice." We may, in appropriate circumstances and at our discretion, terminate the accounts of users who are repeat infringers. Knowingly submitting a false or misleading notice of infringement may subject you to liability under applicable law.</p>

        <h3>10. Termination & Suspension</h3>
        <p>We may suspend, restrict, or terminate your access to the Platform at any time, with or without notice, if we believe you have violated these Terms, engaged in fraudulent or illegal activity, or if your use of the Platform poses a security or regulatory risk. You agree that we will not be liable to you or any third party for any termination of your access. Upon termination, your right to use the Platform ceases immediately. Any provisions of these Terms that by their nature should survive termination (including ownership rights, warranty disclaimers, limitation of liability, indemnification, and dispute resolution) shall remain in effect.</p>

        <h3>11. Indemnification</h3>
        <p>You agree to indemnify, defend, and hold harmless SolPulse and its directors, officers, employees, and agents from and against any claims, liabilities, damages, losses, and expenses (including reasonable attorney's fees) arising out of or related to (a) your use or misuse of the Platform, (b) your violation of these Terms, (c) your violation of any rights of another person or entity, or (d) your violation of any applicable law or regulation. We reserve the right to assume exclusive control of any matter otherwise subject to indemnification by you, in which case you agree to cooperate with our defence.</p>

        <h3>12. Governing Law & Dispute Resolution</h3>
        <p>These Terms, and any dispute arising out of or in connection with the Platform or these Terms, shall be governed by and construed in accordance with the laws of the State of Wyoming, without regard to conflict of law principles. You agree that any dispute, claim, or controversy arising out of or relating to these Terms or the breach, termination, enforcement, interpretation, or validity thereof (collectively, "Disputes") shall be resolved by binding arbitration administered by the American Arbitration Association (AAA) under its Consumer Arbitration Rules, conducted remotely or in the State of Wyoming. Either party may bring claims in small claims court if the claim qualifies. The arbitration shall be conducted on an individual basis and not on a class or representative basis. <strong>YOU AGREE THAT ANY CLAIMS WILL BE RESOLVED ON AN INDIVIDUAL BASIS AND NOT AS PART OF ANY CLASS, CONSOLIDATED, OR REPRESENTATIVE ACTION.</strong> You understand that by agreeing to arbitrate disputes, you are waiving your right to a jury trial and to participate in a class action. If this arbitration clause is found to be unenforceable, then all Disputes shall be subject to the exclusive jurisdiction of the federal and state courts located in the State of Wyoming, and you consent to the personal jurisdiction of such courts.</p>
        <p><strong>Thirty-Day Opt-Out.</strong> You have the right to opt out of the arbitration and class-action waiver provisions set forth above by sending written notice to support@solpulse.trade with the subject line "Arbitration Opt-Out" within thirty (30) days of the date you first accept these Terms. Your notice must include your full legal name, the email address associated with your account or contact, and a clear statement that you wish to opt out of arbitration. Opting out does not affect any other provision of these Terms, including the governing-law and venue selections.</p>
        <p><strong>Prevailing Party Fees.</strong> In any arbitration or legal proceeding arising out of or relating to these Terms, the prevailing party shall be entitled to recover its reasonable attorneys' fees, expert fees, arbitration filing fees, and costs, to the extent permitted by applicable law and the rules of the forum.</p>

        <h3>13. Changes to Terms</h3>
        <p>We may update these Terms from time to time. The latest version will always be posted at https://agentic-signer.com/terms. Continued use after changes constitutes acceptance.</p>

        <h3>14. Contact</h3>
        <ul>
          <li>📧 Email: support@solpulse.trade</li>
          <li>📍 Location: SolPulse LLC, 1621 Central Ave, Cheyenne, WY 82001</li>
        </ul>
        <p><strong>14a. Privacy.</strong> Your use of the Platform is also governed by our <a href="/privacy">Privacy Policy</a>, which is incorporated into these Terms by reference. The Privacy Policy describes what data we collect, how we use it, with whom we share it, and your rights regarding your personal information. By using the Platform you consent to the collection, use, and sharing of your data as described in the Privacy Policy. If you do not agree with the Privacy Policy, you must not use the Platform.</p>
        <p><strong>14b. Electronic Communications & Signatures.</strong> By using the Platform, you consent to receive communications from SolPulse electronically, including by email, in-app notice, or other channel where you have provided contact information, and you agree that all agreements, notices, disclosures, and other communications we provide to you electronically satisfy any legal requirement that such communications be in writing. You further agree that your electronic acceptance of these Terms — for example, by clicking "I accept," connecting a wallet, or continuing to use the Platform after notice of updates — constitutes a legally binding signature under the U.S. Electronic Signatures in Global and National Commerce Act (15 U.S.C. § 7001 et seq.) and any applicable state Uniform Electronic Transactions Act. You may withdraw this consent only by discontinuing use of the Platform.</p>

        <h3>15. Action Approval & Execution</h3>
        <p>Actions surfaced by the Platform are prepared off-chain by the agent or other software you connect, displayed for your review, signed by your wallet, and broadcast to the relevant blockchain network through third-party RPC providers and on-chain protocols. Any pre-action estimate displayed by the Platform — including price, slippage, fees, route, or expected outcome — is for informational convenience only and may differ from the actual on-chain result due to network conditions, slippage, routing changes, MEV activity, or third-party protocol behavior. Approvals can expire, fail to land, partial-fill, or be re-ordered, front-run, censored, or delayed by the network or validators. Adjusting compute unit prices or priority tips may improve inclusion probabilities but does not guarantee execution or price. SolPulse does not guarantee that any signed transaction will land or settle, and is not responsible for the outcomes of transactions you authorize.</p>

        <h3>16. Third-Party Services & Data Sources</h3>
        <p>The Platform may rely on third-party services and data sources such as wallet providers, RPC nodes, AI clients, MCP servers, DEX aggregators/routers, market data providers, block explorers, messaging services, and email providers. We do not control and are not responsible for their availability, accuracy, performance, security, or legality. Outages, inaccuracies, or changes in those services may affect your experience and outcomes. Your use of third-party services may be governed by their own terms and privacy policies.</p>

        <h3>17. Automation, Caps & Pre-Authorized Categories</h3>
        <p>If you enable automated approvals, spend caps, recurring payments, allowlisted recipients, bridge polling, Android foreground wallet-approval flows, or any "always allow" / pre-authorized category in the Platform, you authorize the Platform to prepare, queue, poll for, or submit transactions via your connected wallet in accordance with your parameters. You are responsible for maintaining adequate balances, monitoring the automation, and disabling or revoking it when desired. We may implement idempotency or duplicate-protection mechanisms, but they cannot prevent all race conditions, retries, stale authorizations, wallet bugs, bridge failures, or double-submissions across networks, devices, agents, or wallets.</p>

        <h3>18. Safety Checks & Heuristics</h3>
        <p>Any safety, simulation, cap, allowlist, balance, slippage, or risk check surfaced by the Platform is heuristic and informational only. Such checks do not constitute a guarantee that an action is safe, that a token is legitimate, that liquidity is sufficient, or that an agent is non-malicious. You should conduct your own due diligence before approving any action and understand that heuristic checks can be incomplete, stale, or bypassed. We are not liable for losses arising from rug pulls, honeypots, scam tokens, exploits, prompt-injected agents, or any fraudulent activity that you authorize through the Platform, even if our safety checks failed to detect it.</p>
        <p><strong>18a. Smart Contract & On-Chain Risk.</strong> The Platform interacts with third-party blockchain networks, decentralized protocols, smart contracts, and routers (including but not limited to Jupiter Aggregator, Raydium, Orca, Meteora, and other on-chain venues that an agent may select). We do not develop, audit, or control these smart contracts. Smart contracts may contain bugs, vulnerabilities, or exploits that could result in partial or total loss of funds. You acknowledge that interacting with on-chain protocols carries inherent risk, and SolPulse is not liable for any losses caused by smart contract failures, exploits, hacks, or vulnerabilities in third-party protocols, regardless of whether the transaction was initiated manually or via agent automation.</p>
        <p><strong>Public & Permanent.</strong> Every transaction you submit through the Platform is broadcast to the relevant blockchain network and recorded on a public, immutable ledger. You acknowledge that your wallet address, counterparty addresses, transaction amounts, slippage tolerances, and timing metadata may be observed, indexed, copied, or exploited by any third party with access to the network, including searcher bots, MEV actors, block explorers, and analytics platforms. SolPulse cannot and does not guarantee the privacy, reversibility, or anonymity of any on-chain activity.</p>

        <h3>19. Taxes & Recordkeeping</h3>
        <p>You are solely responsible for all taxes, reporting, and recordkeeping related to your use of the Platform, including gains, losses, fees, and other taxable events. We do not provide tax advice. You should consult a qualified tax professional regarding your obligations.</p>

        <h3>20. Service Availability, Maintenance & Incidents</h3>
        <p>We may perform maintenance, upgrades, or changes that temporarily affect availability. We may also activate read-only or maintenance modes to preserve system integrity or comply with legal requirements. Status information may be communicated through in-app notices or external status pages. We are not liable for losses arising from downtime, maintenance windows, or incidents. Except as expressly agreed in writing, SolPulse has no obligation to provide support, bug fixes, updates, or customer service in connection with the Platform, and any assistance we do provide is on a best-effort, as-available basis.</p>

        <h3>21. Beta / Experimental Features</h3>
        <p>Certain features may be labeled beta or experimental. Such features may be incomplete, change without notice, or be withdrawn. They may have reduced reliability or performance. Your use of beta features is at your own risk and subject to these Terms.</p>

        <h3>22. Account Deletion, Data Export & Retention</h3>
        <p>Where provided, you may request deletion of any data we hold about you and export of certain data. Deletion requests may be subject to verification and limitations where retention is required by law, security, or dispute resolution. Additional details about retention periods and processing are described in our Privacy Policy.</p>

        <h3>23. Changes to the Platform</h3>
        <p>We may add, modify, or discontinue features, components, or access methods of the Platform at any time. Where changes materially affect any paid access, we will provide reasonable notice consistent with Section 4. We are not responsible for third-party withdrawals of service or feature changes outside our control.</p>

        <h3>24. Third-Party Links</h3>
        <p>The Platform may contain links to third-party websites or resources. We provide these links as a convenience and are not responsible for the content, products, or services on or available from those websites or resources. Accessing any third-party site is at your own risk and may be subject to separate terms and privacy policies established by those third parties.</p>

        <h3>25. Export Controls & Sanctions</h3>
        <p>You agree to comply with all applicable export control and economic sanctions laws and regulations, including those administered by the U.S. Department of the Treasury's Office of Foreign Assets Control (OFAC) and the U.S. Department of Commerce. You represent that you are not located in, under the control of, or a national or resident of any country or region subject to comprehensive sanctions, and that you are not identified on any government restricted party list. You will not use the Platform to transact with or benefit any such person, entity, country, or region.</p>

        <h3>26. Geographic Restrictions & Prohibited Jurisdictions</h3>
        <p>We may restrict access to the Platform where we believe it is necessary to comply with laws, regulations, or risk controls. We may employ geoblocking or other measures to prevent access from prohibited jurisdictions. You are responsible for ensuring that your use of the Platform is lawful in your location and for ceasing use if it becomes unlawful.</p>

        <h3>27. Force Majeure</h3>
        <p>We will not be liable for any delay or failure to perform resulting from causes beyond our reasonable control, including acts of God, natural disasters, war, terrorism, civil unrest, labor disputes, government actions, power or internet failures, failures of third-party service providers, or network/validator disruptions.</p>

        <h3>28. Assignment; No Agency</h3>
        <p>You may not assign or transfer any rights or obligations under these Terms without our prior written consent. We may assign these Terms without restriction. Nothing in these Terms shall be construed to create a partnership, joint venture, fiduciary, or agency relationship between you and SolPulse; neither party has authority to bind the other.</p>

        <h3>29. Severability; Entire Agreement; Waiver; Interpretation</h3>
        <p>If any provision of these Terms is held to be invalid or unenforceable, that provision will be enforced to the maximum extent permissible and the remaining provisions will remain in full force and effect. These Terms constitute the entire agreement between you and SolPulse regarding the Platform and supersede any prior or contemporaneous agreements on the same subject. No waiver of any provision shall be effective unless in writing and signed by the waiving party, and no waiver shall be deemed a waiver of any other provision or of the same provision on another occasion. Headings are for convenience only and do not affect interpretation.</p>
        <p><strong>No Third-Party Beneficiaries.</strong> These Terms are solely for the benefit of you and SolPulse. Nothing in these Terms, express or implied, is intended to or shall confer upon any other person or entity any legal or equitable right, benefit, or remedy of any nature.</p>

        <h3>30. Sanctions Screening</h3>
        <p>Access to or use of the Platform may be restricted or prohibited in certain jurisdictions. You represent and warrant that you are not located in, organized under the laws of, or ordinarily resident in any jurisdiction subject to comprehensive sanctions, and that you are not listed on any government sanctions or restricted party list. You agree that you will not use the Platform to benefit any sanctioned person or jurisdiction or for any unlawful purpose. We may implement geoblocking, sanctions screening, and other compliance measures and may suspend or terminate access where we believe it is necessary to comply with law.</p>

        <h3>31. No Offer; No Suitability Determination</h3>
        <p>All content and functionality on the Platform are provided for informational and operational purposes only and do not constitute an offer, solicitation, recommendation, or endorsement of any digital asset, strategy, agent, or course of action. We do not assess the suitability of any action, asset, or strategy for you, and we do not provide investment, legal, tax, or accounting advice. You are solely responsible for your decisions and should obtain independent professional advice tailored to your circumstances.</p>

        <h3>32. User-Directed Agents; No Discretion</h3>
        <p>Any AI agents, LLMs, MCP servers, automation, schedulers, or "bots" connected to the Platform operate strictly according to the parameters you configure and authorize. The Platform does not exercise discretionary authority over your account, funds, or strategy. SolPulse does not owe you a fiduciary duty. We do not act as your agent, advisor, or fiduciary. All automation is user-directed and parameter-driven. You may stop or revoke any agent at any time, subject to on-chain conditions and network availability. Enabling automation or pre-authorized categories authorizes the Platform to prepare or submit transactions via your connected wallet pursuant to your parameters; you remain responsible for monitoring positions, risk, and outcomes.</p>

        <h3>33. Protocol Changes, Forks, and Unsupported Assets</h3>
        <p>Blockchain networks and protocols may change, fork, experience re-organizations, fee spikes, congestion, or failures. We do not control any blockchain and make no guarantees regarding network security, functionality, or availability. We may determine, in our sole discretion, how to respond to protocol changes (including whether to support particular forks, airdrops, or tokens) and have no obligation to support any asset or distribution. Because Agentic is non-custodial, we do not relay, distribute, or hold airdrops, forked assets, or protocol distributions on your behalf. You acknowledge you are not entitled to any forked assets, airdrops, or protocol distributions via the Platform unless we explicitly state otherwise.</p>

        <h3>34. Third-Party Content, Data, and Links</h3>
        <p>The Platform may display or rely on third-party information and services, including pricing, market data, routing, wallets, RPC, analytics, messaging, and external websites. We do not guarantee the accuracy, completeness, timeliness, reliability, or availability of any third-party content or services. Links to third-party sites are provided for convenience only, and your use of them is at your own risk and subject to their terms and policies.</p>

        <h3>35. Security, Malicious Code, and Network Attacks</h3>
        <p>You are solely responsible for securing your devices and accounts. We do not warrant that the Platform or any files or data available through it are free of viruses, worms, trojans, logic bombs, or other harmful components, or that services will be immune to denial-of-service or similar attacks. We are not liable for losses arising from such events. Use reputable security software and follow best practices when interacting with digital assets, wallets, and downloads.</p>

        <h3>36. Availability; Internet, Devices & Support</h3>
        <p>The Platform operates over the internet and mobile networks and may be affected by factors outside our control, including connectivity, device or operating system versions, and app store policies. We do not guarantee continuous, uninterrupted access, and we have no obligation to provide device-level or operating system support. We may update, modify, or suspend functionality from time to time to maintain security and performance. Tutorials, videos, FAQs, and helpdesk materials describe Platform functionality only and do not contain personalized advice or recommendations.</p>

        <h3>37. Release of Claims</h3>
        <p>To the fullest extent permitted by law, you hereby release and forever discharge SolPulse and its owners, directors, officers, employees, agents, successors, and assigns from any and all claims, demands, damages, losses, costs, and expenses (including attorneys' fees) of every kind and nature, known or unknown, arising out of or in any way connected with: (a) your transaction activity or financial decisions; (b) the performance or non-performance of any agent, strategy, or automation; (c) any interaction with third-party protocols, smart contracts, or decentralized exchanges; (d) the loss, theft, or unauthorized access to your wallet, private keys, or digital assets; (e) any token you interacted with that turned out to be fraudulent, a rug pull, or otherwise worthless; or (f) any other use of the Platform. If applicable law does not allow the release of unknown claims, you waive the protections of any statute or doctrine that limits the scope of a release to known claims.</p>

        <h3>38. Acknowledgment</h3>
        <p>By using the Platform, you acknowledge that you have read, understood, and agree to all of these Terms. You confirm that you are not relying on any representation or warranty not expressly set out in these Terms. You understand that cryptocurrency activity is speculative, that you may lose all funds, and that Agentic is a software tool — not a financial institution, broker, exchange, or advisor.</p>
      </article>
    </section>
  `;
}
