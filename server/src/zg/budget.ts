// Budget guard: wires the pure decision (budget-logic.ts) to Supabase spend, 0G pricing and balance.
import { decrypt } from "../crypto.js";
import { env } from "../config.js";
import { big, db, must } from "../db/client.js";
import type { AgentRow } from "../db/types.js";
import { UpstreamError } from "../errors.js";
import { log, logError } from "../log.js";
import { estimateCostUsdMicro, usdDecimalToPico } from "../pricing.js";
import { decide, Reservations, utcDayStart, type BudgetDecision } from "./budget-logic.js";
import { balance, listModels } from "./router.js";

export const reservations = new Reservations();

/** Per-unit price of a 0G model in pico-USD, from /v1/models pricing_usd.prompt (cached 1 h). */
export async function modelUnitPricePico(model: string): Promise<bigint> {
  const m = (await listModels()).find((x) => x.id === model);
  const usd = m?.pricing_usd?.prompt;
  if (!usd) throw new Error(`[0g] no pricing_usd for model ${model}`);
  return usdDecimalToPico(usd);
}

/** 0G spend recorded for an agent since 00:00 UTC of `now`. */
export async function spentTodayUsdMicro(agentId: string, now: Date): Promise<bigint> {
  const rows = must(
    "jobs spent today",
    await db
      .from("jobs")
      .select("zg_cost_usd_micro")
      .eq("agent_id", agentId)
      .gte("created_at", utcDayStart(now).toISOString())
      .not("zg_cost_usd_micro", "is", null),
  );
  return rows.reduce((sum, r) => sum + big(r.zg_cost_usd_micro as string | number | null), 0n);
}

const balanceCache = new Map<string, { at: number; usdMicro: bigint }>();

async function creditBalance(agentId: string): Promise<bigint | undefined> {
  const hit = balanceCache.get(agentId);
  if (hit && performance.now() - hit.at < 60_000) return hit.usdMicro;
  const r = await db
    .from("agent_secrets")
    .select("zg_mgmt_key_enc")
    .eq("agent_id", agentId)
    .maybeSingle();
  if (r.error) throw new UpstreamError("db", `agent mgmt key: ${r.error.message}`);
  const enc = (r.data as { zg_mgmt_key_enc: string | null } | null)?.zg_mgmt_key_enc;
  if (!enc) return undefined;
  try {
    const b = await balance(decrypt(enc, env.SECRETS_MASTER_KEY));
    const usdMicro = BigInt(b.total_balance);
    balanceCache.set(agentId, { at: performance.now(), usdMicro });
    return usdMicro;
  } catch (err) {
    // The balance read is a courtesy check; the Router itself refuses calls without credit.
    logError("budget", `balance read failed for agent ${agentId}, skipping credit check`, err);
    return undefined;
  }
}

export async function canRun(
  agent: AgentRow,
  meterUnits: bigint,
  now = new Date(),
): Promise<BudgetDecision> {
  const [pico, spent, bal] = await Promise.all([
    modelUnitPricePico(agent.model),
    spentTodayUsdMicro(agent.id, now),
    creditBalance(agent.id),
  ]);
  const d = decide({
    now,
    capUsdMicro: big(agent.daily_cap_usd_micro),
    spentUsdMicro: spent,
    reservedUsdMicro: reservations.total(agent.id),
    estimateUsdMicro: estimateCostUsdMicro(pico, meterUnits),
    ...(bal !== undefined ? { balanceUsdMicro: bal } : {}),
  });
  log("budget", d.ok ? "ok" : `refused ${d.reason}`, {
    agent: agent.label,
    spent: spent.toString(),
    cap: big(agent.daily_cap_usd_micro).toString(),
    estimate: d.estimateUsdMicro.toString(),
  });
  return d;
}
