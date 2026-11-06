import { Router } from "express";
import { z } from "zod";
import { db } from "../db/client.js";
import { authenticatePrivyUser } from "../buyer-console-auth.js";
import { ApiError, UpstreamError } from "../errors.js";

export const meRouter = Router();

const OwnerRow = z.object({
  id: z.string().uuid(),
  evm_address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  created_at: z.string().datetime({ offset: true }),
});

const AgentRow = z.object({
  id: z.string().uuid(),
  label: z.string().regex(/^[a-z0-9-]{3,32}$/),
  ens_name: z.string(),
  skill: z.string(),
  model: z.string(),
  price_atomic: z.union([z.string().regex(/^\d+$/), z.number().int().safe().nonnegative()]),
  price_unit: z.string(),
  daily_cap_usd_micro: z.union([z.string().regex(/^\d+$/), z.number().int().safe().nonnegative()]),
  status: z.enum([
    "pending",
    "active",
    "paused_owner",
    "paused_budget",
    "expired",
    "revoked",
    "failed",
  ]),
  expiry: z.string().datetime({ offset: true }).nullable(),
  created_at: z.string().datetime({ offset: true }),
});

function atomicString(value: string | number): string {
  if (typeof value === "number" && !Number.isSafeInteger(value))
    throw new UpstreamError("db", "owner dashboard atomic amount is not safely representable");
  return String(value);
}

meRouter.get("/me", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const privyUserId = await authenticatePrivyUser(req.header("authorization"));
  const ownerResult = await db
    .from("owners")
    .select("id,evm_address,created_at")
    .eq("privy_user_id", privyUserId)
    .maybeSingle();
  if (ownerResult.error)
    throw new UpstreamError("db", `owner dashboard lookup: ${ownerResult.error.message}`);
  if (!ownerResult.data) {
    res.setHeader("Cache-Control", "no-store");
    res.json({ owner: null, agents: [] });
    return;
  }

  const owner = OwnerRow.safeParse(ownerResult.data);
  if (!owner.success) throw new UpstreamError("db", "owner dashboard record is malformed");
  const agentsResult = await db
    .from("agents")
    .select(
      "id,label,ens_name,skill,model,price_atomic,price_unit,daily_cap_usd_micro,status,expiry,created_at",
    )
    .eq("owner_id", owner.data.id)
    .order("created_at", { ascending: false });
  if (agentsResult.error)
    throw new UpstreamError("db", `owner agent roster: ${agentsResult.error.message}`);

  const agents = (agentsResult.data ?? []).map((row: unknown) => {
    const parsed = AgentRow.safeParse(row);
    if (!parsed.success) throw new UpstreamError("db", "owner agent record is malformed");
    return {
      id: parsed.data.id,
      label: parsed.data.label,
      ensName: parsed.data.ens_name,
      skill: parsed.data.skill,
      model: parsed.data.model,
      priceAtomic: atomicString(parsed.data.price_atomic),
      priceUnit: parsed.data.price_unit,
      dailyCapUsdMicro: atomicString(parsed.data.daily_cap_usd_micro),
      status: parsed.data.status,
      expiry: parsed.data.expiry,
      createdAt: parsed.data.created_at,
    };
  });

  res.setHeader("Cache-Control", "no-store");
  res.json({
    owner: { evmAddress: owner.data.evm_address, createdAt: owner.data.created_at },
    agents,
  });
});

const OwnerJobsQuery = z.object({
  label: z
    .string()
    .regex(/^[a-z0-9-]{3,32}$/)
    .optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const OwnerJobRow = z.object({
  id: z.string().uuid(),
  status: z.string(),
  units: z.union([z.string().regex(/^\d+(?:\.\d+)?$/), z.number().finite().nonnegative()]),
  price_atomic: z.union([z.string().regex(/^\d+$/), z.number().int().safe().nonnegative()]),
  zg_cost_usd_micro: z
    .union([z.string().regex(/^\d+$/), z.number().int().safe().nonnegative()])
    .nullable(),
  hedera_tx_id: z.string().nullable(),
  hcs_sequence: z
    .union([z.string().regex(/^\d+$/), z.number().int().safe().nonnegative()])
    .nullable(),
  output_sha256: z.string().nullable(),
  latency_ms: z.number().int().nullable(),
  created_at: z.string().datetime({ offset: true }),
  agents: z.union([
    z.object({ label: z.string(), owner_id: z.string().uuid() }),
    z.array(z.object({ label: z.string(), owner_id: z.string().uuid() })).length(1),
  ]),
});

/**
 * Owner job history. The owner is derived only from the verified Privy token; the join filter
 * `agents.owner_id = owner.id` enforces ownership in the query itself. Outputs, buyer accounts
 * and internal error text are never returned.
 */
meRouter.get("/me/jobs", async (req, res) => {
  const privyUserId = await authenticatePrivyUser(req.header("authorization"));
  const query = OwnerJobsQuery.safeParse(req.query);
  if (!query.success) throw new ApiError(422, "invalid_input", "invalid job history query");
  res.setHeader("Cache-Control", "no-store");
  const ownerResult = await db
    .from("owners")
    .select("id")
    .eq("privy_user_id", privyUserId)
    .maybeSingle();
  if (ownerResult.error)
    throw new UpstreamError("db", `owner job history lookup: ${ownerResult.error.message}`);
  if (!ownerResult.data) {
    res.json({ items: [], page: query.data.page, limit: query.data.limit });
    return;
  }
  const ownerId = (ownerResult.data as { id: string }).id;
  const { page, limit, label } = query.data;
  const from = (page - 1) * limit;
  let builder = db
    .from("jobs")
    .select(
      "id,status,units,price_atomic,zg_cost_usd_micro,hedera_tx_id,hcs_sequence,output_sha256,latency_ms,created_at,agents!inner(label,owner_id)",
    )
    .eq("agents.owner_id", ownerId);
  if (label) builder = builder.eq("agents.label", label);
  const result = await builder
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, from + limit);
  if (result.error) throw new UpstreamError("db", `owner job history: ${result.error.message}`);
  const rows = (result.data ?? []).map((raw: unknown) => {
    const parsed = OwnerJobRow.safeParse(raw);
    if (!parsed.success) throw new UpstreamError("db", "owner job record is malformed");
    const agent = Array.isArray(parsed.data.agents) ? parsed.data.agents[0]! : parsed.data.agents;
    // Defence in depth: never return a row the query should not have matched.
    if (agent.owner_id !== ownerId) throw new UpstreamError("db", "owner scope violated");
    return {
      id: parsed.data.id,
      label: agent.label,
      status: parsed.data.status,
      units: String(parsed.data.units),
      priceAtomic: String(parsed.data.price_atomic),
      zgCostUsdMicro:
        parsed.data.zg_cost_usd_micro === null ? null : String(parsed.data.zg_cost_usd_micro),
      hederaTxId: parsed.data.hedera_tx_id,
      hcsSequence: parsed.data.hcs_sequence === null ? null : String(parsed.data.hcs_sequence),
      outputSha256: parsed.data.output_sha256,
      latencyMs: parsed.data.latency_ms,
      createdAt: parsed.data.created_at,
    };
  });
  res.json({
    items: rows.slice(0, limit),
    page,
    limit,
    ...(rows.length > limit ? { nextPage: page + 1 } : {}),
  });
});
