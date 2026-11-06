// Public, unauthenticated routes: /health, /agents/:label, /a/:label/quote, /stats.
import { HEDERA_NETWORK } from "@nightshift/shared";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { env } from "../config.js";
import { big, db } from "../db/client.js";
import { agentByLabel } from "../db/queries.js";
import { readAgentRecords } from "../ens/read.js";
import { ApiError, UpstreamError } from "../errors.js";
import { health } from "../health.js";
import { logError } from "../log.js";
import { priceFor } from "../pricing.js";
import { createSignedQuote } from "../quote-signing.js";
import { utcDayStart } from "../zg/budget-logic.js";

export const publicRouter = Router();

const Label = z.string().regex(/^[a-z0-9-]{3,32}$/);
const QuoteQuery = z.object({ units: z.coerce.number().positive().max(10_000).default(1) });
const JobLimit = z.object({ limit: z.coerce.number().int().min(1).max(1000).default(100) });

interface PublicJobRow {
  id: string;
  status: string;
  price_atomic: string | number;
  zg_cost_usd_micro: string | number | null;
  hedera_tx_id: string | null;
  zg_request_id: string | null;
  hcs_sequence: string | number | null;
  latency_ms: number | null;
  created_at: string;
  agents: { label: string; ens_name: string } | { label: string; ens_name: string }[] | null;
}

function exactInteger(value: string | number | null): string | null {
  if (value === null) return null;
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0))
    throw new UpstreamError("db", "job atomic amount is not safely representable");
  if (typeof value === "string" && !/^\d+$/.test(value))
    throw new UpstreamError("db", "job atomic amount is malformed");
  return String(value);
}

function safePublicJob(row: PublicJobRow) {
  const agent = Array.isArray(row.agents) ? row.agents[0] : row.agents;
  return {
    id: row.id,
    status: row.status,
    price_atomic: exactInteger(row.price_atomic),
    zg_cost_usd_micro: exactInteger(row.zg_cost_usd_micro),
    hedera_tx_id: row.hedera_tx_id,
    zg_request_id: row.zg_request_id,
    hcs_sequence: exactInteger(row.hcs_sequence),
    latency_ms: row.latency_ms,
    created_at: row.created_at,
    agents: agent ? { label: agent.label, ens_name: agent.ens_name } : null,
  };
}

publicRouter.get("/live", (_req, res) => {
  res.json({ ok: true });
});

const readinessHandler = async (_req: Request, res: Response) => {
  const h = await health();
  res.status(h.ok ? 200 : 503).json(h);
};

publicRouter.get("/health", readinessHandler);
publicRouter.get("/ready", readinessHandler);

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
  if (!agent.hedera_account_id)
    throw new ApiError(409, "agent_paused", "agent is not configured for Hedera payments");
  if (agent.status !== "active" && agent.status !== "paused_budget")
    throw new ApiError(409, "agent_paused", `agent is ${agent.status}`);
  const issuedAt = Math.floor(Date.now() / 1000);
  const { claims, token } = createSignedQuote(
    {
      agentId: agent.id,
      label: agent.label,
      ensName: agent.ens_name,
      units,
      amount: priceFor(big(agent.price_atomic), units).toString(),
      asset: env.HEDERA_USDC_TOKEN_ID,
      network: HEDERA_NETWORK,
      payTo: agent.hedera_account_id,
      unit: agent.price_unit,
      status: agent.status,
    },
    env.NIGHTSHIFT_QUOTE_SIGNING_PRIVATE_KEY,
    issuedAt,
  );
  res.setHeader("Cache-Control", "no-store");
  res.json({
    amount: claims.amount,
    asset: claims.asset,
    network: claims.network,
    payTo: claims.payTo,
    unit: claims.unit,
    units: claims.units,
    status: claims.status,
    issuedAt: new Date(claims.iat * 1000).toISOString(),
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    nonce: claims.nonce,
    signedQuote: token,
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
  const [agents, jobs, payouts] = await Promise.all([
    db.from("agents").select("status"),
    db.from("jobs").select("status,price_atomic,zg_cost_usd_micro").gte("created_at", since),
    db.from("payouts").select("status"),
  ]);
  if (agents.error) throw new UpstreamError("db", agents.error.message);
  if (jobs.error) throw new UpstreamError("db", jobs.error.message);
  if (payouts.error) throw new UpstreamError("db", payouts.error.message);
  const rows = jobs.data ?? [];
  const workerRows = agents.data ?? [];
  const payoutRows = payouts.data ?? [];
  const settled = rows.filter((j) => j.status === "settled");
  const billingIncomplete = rows.some(
    (job) => job.status !== "refused_budget" && job.zg_cost_usd_micro === null,
  );
  res.json({
    agents: workerRows.filter((agent) => agent.status === "active").length,
    workers: {
      active: workerRows.filter((agent) => agent.status === "active").length,
      paused: workerRows.filter((agent) =>
        ["paused_owner", "paused_budget"].includes(String(agent.status)),
      ).length,
      unavailable: workerRows.filter((agent) =>
        ["expired", "revoked", "failed", "pending"].includes(String(agent.status)),
      ).length,
    },
    jobsToday: settled.length,
    failedJobsToday: rows.filter((job) =>
      ["failed_upstream", "failed_internal"].includes(job.status),
    ).length,
    settlementFailuresToday: rows.filter((job) => job.status === "settle_failed").length,
    reconciliationRequiredToday: rows.filter((job) => job.status === "needs_reconciliation").length,
    payouts: {
      pending: payoutRows.filter((payout) => payout.status === "pending").length,
      failed: payoutRows.filter((payout) => payout.status === "failed").length,
      uncertain: payoutRows.filter((payout) => payout.status === "uncertain").length,
    },
    usdcToday: settled.reduce((s, j) => s + big(j.price_atomic as number | string), 0n).toString(),
    creditsUsedToday: billingIncomplete
      ? null
      : rows
          .reduce((s, j) => s + big(j.zg_cost_usd_micro as number | string | null), 0n)
          .toString(),
  });
});

publicRouter.get("/jobs/latest", async (_req, res) => {
  const result = await db
    .from("jobs")
    .select(
      "id,status,price_atomic,zg_cost_usd_micro,hedera_tx_id,zg_request_id,hcs_sequence,latency_ms,created_at,agents!inner(label,ens_name)",
    )
    .eq("status", "settled")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (result.error) throw new UpstreamError("db", `latest public job: ${result.error.message}`);
  res.json(result.data ? safePublicJob(result.data as PublicJobRow) : null);
});

publicRouter.get("/jobs/activity", async (req, res) => {
  const query = JobLimit.safeParse(req.query);
  if (!query.success)
    throw new ApiError(422, "invalid_input", "invalid activity limit", query.error.issues);
  const result = await db
    .from("jobs")
    .select("status,created_at,agents!inner(label)")
    .gte("created_at", utcDayStart(new Date()).toISOString())
    .order("created_at", { ascending: false })
    .limit(query.data.limit);
  if (result.error) throw new UpstreamError("db", `public job activity: ${result.error.message}`);
  res.json({
    jobs: (
      (result.data ?? []) as {
        status: string;
        created_at: string;
        agents: { label: string } | { label: string }[] | null;
      }[]
    ).map((row) => {
      const agent = Array.isArray(row.agents) ? row.agents[0] : row.agents;
      return { status: row.status, created_at: row.created_at, agents: agent ?? null };
    }),
  });
});

publicRouter.get("/agents/:label/jobs", async (req, res) => {
  const agent = await requireAgent(req.params.label);
  const query = JobLimit.safeParse(req.query);
  if (!query.success)
    throw new ApiError(422, "invalid_input", "invalid job history limit", query.error.issues);
  const result = await db
    .from("jobs")
    .select(
      "id,status,price_atomic,zg_cost_usd_micro,hedera_tx_id,zg_request_id,hcs_sequence,latency_ms,created_at,agents!inner(label,ens_name)",
    )
    .eq("agent_id", agent.id)
    .order("created_at", { ascending: false })
    .limit(query.data.limit);
  if (result.error)
    throw new UpstreamError("db", `public agent job history: ${result.error.message}`);
  res.json(((result.data ?? []) as PublicJobRow[]).map(safePublicJob));
});
