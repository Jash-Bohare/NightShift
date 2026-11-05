// Public, unauthenticated routes: /health, /agents/:label, /a/:label/quote, /stats.
import { HEDERA_NETWORK } from "@nightshift/shared";
import { Router } from "express";
import { z } from "zod";
import { env } from "../config.js";
import { big, db } from "../db/client.js";
import { agentByLabel } from "../db/queries.js";
import { readAgentRecords } from "../ens/read.js";
import { ApiError, UpstreamError } from "../errors.js";
import { health } from "../health.js";
import { logError } from "../log.js";
import { priceFor } from "../pricing.js";
import { utcDayStart } from "../zg/budget-logic.js";

export const publicRouter = Router();

const Label = z.string().regex(/^[a-z0-9-]{3,32}$/);
const QuoteQuery = z.object({ units: z.coerce.number().positive().max(10_000).default(1) });

publicRouter.get("/health", async (_req, res) => {
  const h = await health();
  res.status(h.ok ? 200 : 503).json(h);
});

async function requireAgent(raw: unknown) {
  const label = Label.safeParse(raw);
  if (!label.success) throw new ApiError(422, "invalid_label", "bad label");
  const agent = await agentByLabel(label.data);
  if (!agent || agent.status === "pending" || agent.status === "failed")
    throw new ApiError(404, "not_found", `no agent ${label.data}`);
  return agent;
}

publicRouter.get("/a/:label/quote", async (req, res) => {
  const agent = await requireAgent(req.params.label);
  const q = QuoteQuery.safeParse(req.query);
  if (!q.success)
    throw new ApiError(422, "invalid_input", "units must be a positive number", q.error.issues);
  const units = Math.max(1, Math.ceil(q.data.units));
  res.json({
    amount: priceFor(big(agent.price_atomic), units).toString(),
    asset: env.HEDERA_USDC_TOKEN_ID,
    network: HEDERA_NETWORK,
    payTo: agent.hedera_account_id,
    unit: agent.price_unit,
    units,
    status: agent.status,
  });
});

publicRouter.get("/agents/:label", async (req, res) => {
  const agent = await requireAgent(req.params.label);
  let ens: Awaited<ReturnType<typeof readAgentRecords>> | null = null;
  let ensError: string | undefined;
  try {
    ens = await readAgentRecords(agent.ens_name);
  } catch (err) {
    ensError = err instanceof UpstreamError ? err.message : "ens read failed";
    logError("ens", `profile read for ${agent.label}`, err);
  }
  const today = await db
    .from("jobs")
    .select("status,price_atomic")
    .eq("agent_id", agent.id)
    .gte("created_at", utcDayStart(new Date()).toISOString());
  if (today.error) throw new UpstreamError("db", today.error.message);
  const settled = (today.data ?? []).filter((j) => j.status === "settled");
  res.json({
    label: agent.label,
    ensName: agent.ens_name,
    skill: agent.skill,
    model: agent.model,
    price: {
      amount: big(agent.price_atomic).toString(),
      asset: env.HEDERA_USDC_TOKEN_ID,
      unit: agent.price_unit,
    },
    payTo: agent.hedera_account_id,
    status: agent.status,
    resolver: agent.resolver_address,
    registerTx: agent.register_tx,
    expiry: agent.expiry,
    today: {
      jobsSettled: settled.length,
      earnedAtomic: settled
        .reduce((s, j) => s + big(j.price_atomic as number | string), 0n)
        .toString(),
    },
    ens,
    ...(ensError ? { ensError } : {}),
  });
});

publicRouter.get("/stats", async (_req, res) => {
  const since = utcDayStart(new Date()).toISOString();
  const [agents, jobs] = await Promise.all([
    db.from("agents").select("id", { count: "exact", head: true }).eq("status", "active"),
    db.from("jobs").select("status,price_atomic,zg_cost_usd_micro").gte("created_at", since),
  ]);
  if (agents.error) throw new UpstreamError("db", agents.error.message);
  if (jobs.error) throw new UpstreamError("db", jobs.error.message);
  const rows = jobs.data ?? [];
  const settled = rows.filter((j) => j.status === "settled");
  res.json({
    agents: agents.count ?? 0,
    jobsToday: settled.length,
    usdcToday: settled.reduce((s, j) => s + big(j.price_atomic as number | string), 0n).toString(),
    creditsUsedToday: rows
      .reduce((s, j) => s + big(j.zg_cost_usd_micro as number | string | null), 0n)
      .toString(),
  });
});
