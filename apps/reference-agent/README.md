# Reference Agent

Browser demo that turns a prompt into a signing plan, then asks the user's installed wallet to sign the resulting devnet proof message.

```sh
pnpm demo:agent
```

Open `http://127.0.0.1:5174`. The Vite dev server exposes `/api/agent-plan`.

## Model mode

Set `OPENAI_API_KEY` to let the local dev server ask a model for the signing plan:

```sh
OPENAI_API_KEY=... pnpm demo:agent
```

`OPENAI_MODEL` is optional. When no key is present, or when the model call fails, the app falls back to a deterministic demo plan. That keeps the demo usable at a hackathon table without leaking keys or depending on network availability.

## Difference from `browser-demo`

`browser-demo` is the cleanest wallet proof. `reference-agent` is the narrative demo: prompt, plan, approval, signature, raw result.

