// Liveness checks for /health. Each check is cheap, read-only and time-boxed.
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import { env } from "./config.js";
import { db } from "./db/client.js";

type Check = { ok: boolean; ms: number; detail?: string };

async function timed(fn: () => Promise<string | undefined>): Promise<Check> {
  const t0 = performance.now();
  try {
    const detail = await fn();
    return { ok: true, ms: Math.round(performance.now() - t0), ...(detail ? { detail } : {}) };
  } catch (err) {
    return {
      ok: false,
      ms: Math.round(performance.now() - t0),
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function getOk(url: string, headers: Record<string, string> = {}): Promise<Response> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

const sepoliaClient = createPublicClient({
  chain: sepolia,
  transport: http(env.SEPOLIA_RPC_URL, { timeout: 5_000 }),
});

export async function health() {
  const [zg, hedera, sepoliaCheck, supabase] = await Promise.all([
    timed(async () => {
      await getOk(`${env.ZG_ROUTER_URL}/models`, { Authorization: `Bearer ${env.ZG_TEAM_SK_KEY}` });
      return undefined;
    }),
    timed(async () => {
      await getOk(`${env.HEDERA_MIRROR_URL}/api/v1/topics/${env.HEDERA_HCS_TOPIC_ID}`);
      return undefined;
    }),
    timed(async () => `block ${await sepoliaClient.getBlockNumber()}`),
    timed(async () => {
      const r = await db.from("agents").select("id", { count: "exact", head: true });
      if (r.error) throw new Error(r.error.message);
      return `${r.count ?? 0} agents`;
    }),
  ]);
  const checks = { zg, hedera, sepolia: sepoliaCheck, supabase };
  return { ok: Object.values(checks).every((c) => c.ok), ...checks };
}
