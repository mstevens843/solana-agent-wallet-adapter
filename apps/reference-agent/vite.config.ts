import { defineConfig, type Plugin } from 'vite';

export default defineConfig({
  plugins: [agentPlanApi()],
});

function agentPlanApi(): Plugin {
  return {
    name: 'reference-agent-plan-api',
    configureServer(server) {
      server.middlewares.use('/api/agent-plan', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'method_not_allowed' }));
          return;
        }

        const body = await readBody(req);
        const prompt = String(body.prompt ?? '');
        const wallet = String(body.wallet ?? 'connected wallet');
        const cluster = String(body.cluster ?? 'mainnet-beta');
        const key = process.env.OPENAI_API_KEY;

        if (!key) {
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              mode: 'fallback',
              plan: fallbackPlan(prompt, wallet, cluster),
            }),
          );
          return;
        }

        try {
          const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              authorization: `Bearer ${key}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
              messages: [
                {
                  role: 'system',
                  content:
                    'Return compact JSON only. Shape: {"headline":string,"steps":string[],"risk":"low"|"medium"|"high","summary":string}. Plan a Solana wallet action for a live demo. Never ask for private keys.',
                },
                {
                  role: 'user',
                  content: `Wallet: ${wallet}\nCluster: ${cluster}\nRequest: ${prompt}`,
                },
              ],
              temperature: 0.2,
            }),
          });
          if (!response.ok) {
            throw new Error(`OpenAI HTTP ${response.status}`);
          }
          const json = (await response.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          const content = json.choices?.[0]?.message?.content ?? '';
          const parsed = JSON.parse(content) as AgentPlan;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ mode: 'llm', plan: normalizePlan(parsed, prompt, wallet, cluster) }));
        } catch (err) {
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              mode: 'fallback',
              warning: err instanceof Error ? err.message : 'LLM planning failed.',
              plan: fallbackPlan(prompt, wallet, cluster),
            }),
          );
        }
      });
    },
  };
}

interface AgentPlan {
  headline: string;
  steps: string[];
  risk: 'low' | 'medium' | 'high';
  summary: string;
}

function normalizePlan(plan: AgentPlan, prompt: string, wallet: string, cluster: string): AgentPlan {
  if (!plan.headline || !Array.isArray(plan.steps) || !plan.summary) {
    return fallbackPlan(prompt, wallet, cluster);
  }
  return {
    headline: plan.headline,
    steps: plan.steps.slice(0, 5),
    risk: plan.risk === 'high' || plan.risk === 'medium' ? plan.risk : 'low',
    summary: plan.summary,
  };
}

function fallbackPlan(prompt: string, wallet: string, cluster: string): AgentPlan {
  return {
    headline: 'Prove user-controlled wallet approval',
    steps: [
      `Use ${wallet} on ${cluster}.`,
      'Generate an identity message tied to the current demo request.',
      'Ask the wallet to sign the message in a real approval popup.',
      'Return the signature and keep the private key inside the wallet.',
    ],
    risk: 'low',
    summary: `Sign an identity proof for: ${prompt || 'live demo'}`,
  };
}

async function readBody(req: NodeJS.ReadableStream): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}
