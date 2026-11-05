// P0.2 spike: 0G Compute Router on mainnet with team credits.
// Lists models, makes one chat call and one Tamil Whisper transcription, and reads
// the credit balance before and after to show that `sk-` calls consume credits.
// Run: pnpm -C scripts exec tsx spikes/zg.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { need } from "../env.js";

const ROUTER = need("ZG_ROUTER_URL");
const SK = need("ZG_TEAM_SK_KEY");
const MK = need("ZG_TEAM_MK_KEY");
const WHISPER = need("ZG_WHISPER_MODEL");
const CHAT = need("ZG_CHAT_MODEL");
const SAMPLE = fileURLToPath(new URL("../../buyer/samples/tamil-90s.mp3", import.meta.url));

type Balance = { address: string; currency: string; credit_balance: string; total_balance: string };
type Trace = {
  request_id: string;
  provider: string;
  billing: { currency: string; total_cost: string; total_cost_usd_micro?: string };
};

async function zg<T>(path: string, key: string, init: RequestInit = {}, ms = 30_000): Promise<T> {
  const res = await fetch(`${ROUTER}${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(ms),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`[0g] ${path} -> HTTP ${res.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body) as T;
}

const balance = () => zg<Balance>("/account/balance", MK);

function show(label: string, b: Balance): void {
  console.log(
    `[0g] ${label}: credit_balance=${b.credit_balance} total=${b.total_balance} (${b.currency}, micro-units)`,
  );
}

async function main(): Promise<void> {
  const before = await balance();
  console.log(`[0g] account ${before.address}`);
  show("balance before", before);

  const { data: models } = await zg<{ data: { id: string }[] }>("/models", SK);
  const ids = models.map((m) => m.id);
  console.log(
    `[0g] ${ids.length} models; whisper=${ids.includes(WHISPER)} chat=${ids.includes(CHAT)}`,
  );
  if (!ids.includes(WHISPER) || !ids.includes(CHAT))
    throw new Error("[0g] configured model id not listed");

  const chat = await zg<{ choices: { message: { content: string } }[]; x_0g_trace?: Trace }>(
    "/chat/completions",
    SK,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: CHAT,
        max_tokens: 20,
        messages: [{ role: "user", content: "Reply with one short Tamil greeting." }],
      }),
    },
  );
  console.log(`[0g] chat: ${chat.choices[0]?.message.content}`);
  console.log(`[0g] chat x_0g_trace: ${JSON.stringify(chat.x_0g_trace ?? null)}`);

  const form = new FormData();
  form.append("file", new Blob([readFileSync(SAMPLE)], { type: "audio/mpeg" }), "tamil-90s.mp3");
  form.append("model", WHISPER);
  form.append("language", "ta");
  form.append("response_format", "json");
  const tr = await zg<{ text: string; x_0g_trace?: Trace } & Record<string, unknown>>(
    "/audio/transcriptions",
    SK,
    { method: "POST", body: form },
    180_000,
  );
  console.log(`[0g] transcript (${tr.text.length} chars): ${tr.text.slice(0, 400)}`);
  console.log(`[0g] whisper response keys: ${Object.keys(tr).join(", ")}`);
  console.log(`[0g] whisper x_0g_trace: ${JSON.stringify(tr.x_0g_trace ?? null)}`);

  // Billing can settle a moment after the response.
  await new Promise((r) => setTimeout(r, 5_000));
  const after = await balance();
  show("balance after", after);
  console.log(
    `[0g] spent: ${BigInt(before.credit_balance) - BigInt(after.credit_balance)} micro-${after.currency}`,
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
