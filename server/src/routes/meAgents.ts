// Owner mutations (docs/04 § API, Owner): pause/resume and daily cap per agent, payout account,
// payout history. Every route derives the owner from the verified Privy token; agent ids from
// the URL are only ever matched together with that owner id.
import express, { Router } from "express";
import { z } from "zod";
import { db } from "../db/client.js";
import { ownedAgent, ownerForUser } from "../db/owners.js";
import { forgetAgent, transitionAgentStatus } from "../db/queries.js";
import type { AgentStatus } from "../db/types.js";
import { authenticatePrivyUser } from "../buyer-console-auth.js";
import { ApiError, UpstreamError } from "../errors.js";
import { checkPayoutAccount } from "../hedera/mirror.js";
import { log, logError } from "../log.js";
import { env } from "../config.js";
import { draftRecordEdits, parsePriceRecord } from "../ens/records.js";
import { readAgentRecords } from "../ens/read.js";
import { syncAgentToDirectory } from "../ens/indexer.js";
import { MAX_DAILY_CAP_USD_MICRO, MAX_PRICE_ATOMIC } from "../limits.js";
import type { AgentRow } from "../db/types.js";
import { packetToBytes, normalize } from "viem/ens";
import { toHex } from "viem";

export const meAgentsRouter = Router();
const json = express.json({ limit: "16kb" });

export { MAX_DAILY_CAP_USD_MICRO } from "../limits.js";

export type OwnerStatusTarget = "active" | "paused_owner";

/**
 * Which stored status an owner may move from. `paused_budget` is the budget guard's state; the
 * owner may pause it but never force it to `active` (the guard resumes it when work fits).
 * Lifecycle states (pending, failed, expired, revoked) are never owner-editable.
 */
export function ownerTransition(
  current: AgentStatus,
  target: OwnerStatusTarget,
): "noop" | "allowed" | "forbidden" {
  if (current === target) return "noop";
  if (target === "paused_owner")
    return current === "active" || current === "paused_budget" ? "allowed" : "forbidden";
  return current === "paused_owner" ? "allowed" : "forbidden";
}

const AgentId = z.string().uuid();
const PatchAgentBody = z
  .object({
    status: z.enum(["active", "paused_owner"]).optional(),
    dailyCapUsdMicro: z
      .string()
      .regex(/^[1-9]\d{0,15}$/, "a positive integer in micro-USD")
      .optional(),
  })
  .strict()
  .refine((body) => body.status !== undefined || body.dailyCapUsdMicro !== undefined, {
    message: "nothing to change",
  });

async function requireOwner(authorization: string | undefined) {
  const privyUserId = await authenticatePrivyUser(authorization);
  const owner = await ownerForUser(privyUserId);
  return { privyUserId, owner };
}

meAgentsRouter.patch("/me/agents/:id", json, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const { owner } = await requireOwner(req.header("authorization"));
  const id = AgentId.safeParse(req.params.id);
  const body = PatchAgentBody.safeParse(req.body);
  if (!id.success) throw new ApiError(404, "not_found", "no such agent");
  if (!body.success)
    throw new ApiError(422, "invalid_input", "invalid agent update", body.error.issues);
  if (!owner) throw new ApiError(404, "not_found", "no such agent");
  const agent = await ownedAgent(owner.id, id.data);
  if (!agent) throw new ApiError(404, "not_found", "no such agent");

  if (body.data.dailyCapUsdMicro !== undefined) {
    const cap = BigInt(body.data.dailyCapUsdMicro);
    if (cap > MAX_DAILY_CAP_USD_MICRO)
      throw new ApiError(422, "invalid_input", "daily cap is above the $1,000 limit");
  }
  if (body.data.status !== undefined) {
    const decision = ownerTransition(agent.status, body.data.status);
    if (decision === "forbidden")
      throw new ApiError(
        409,
        "invalid_state",
        `a ${agent.status} agent cannot be set to ${body.data.status}`,
      );
  }

  if (body.data.dailyCapUsdMicro !== undefined) {
    const r = await db
      .from("agents")
      .update({ daily_cap_usd_micro: body.data.dailyCapUsdMicro })
      .eq("id", agent.id)
      .eq("owner_id", owner.id)
      .select("id")
      .maybeSingle();
    if (r.error) throw new UpstreamError("db", `update cap ${agent.id}: ${r.error.message}`);
    if (!r.data) throw new ApiError(404, "not_found", "no such agent");
    forgetAgent(agent.label);
    log("db", "owner changed daily cap", { agent: agent.label, cap: body.data.dailyCapUsdMicro });
  }
  if (
    body.data.status !== undefined &&
    ownerTransition(agent.status, body.data.status) !== "noop"
  ) {
    // Compare-and-set against the status we validated, so a concurrent budget flip or revoke wins.
    const changed = await transitionAgentStatus(agent, agent.status, body.data.status);
    if (!changed)
      throw new ApiError(
        409,
        "invalid_state",
        "agent status changed concurrently; reload and retry",
      );
    log("db", "owner changed agent status", {
      agent: agent.label,
      from: agent.status,
      to: body.data.status,
    });
  }

  const fresh = await ownedAgent(owner.id, agent.id);
  if (!fresh) throw new ApiError(404, "not_found", "no such agent");
  res.json({
    id: fresh.id,
    label: fresh.label,
    status: fresh.status,
    dailyCapUsdMicro: String(fresh.daily_cap_usd_micro),
  });
});

const PatchOwnerBody = z
  .object({
    hederaPayoutAccount: z
      .string()
      .regex(/^0\.0\.\d{1,12}$/, "a Hedera account id like 0.0.12345")
      .nullable(),
  })
  .strict();

meAgentsRouter.patch("/me", json, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const { privyUserId, owner } = await requireOwner(req.header("authorization"));
  const body = PatchOwnerBody.safeParse(req.body);
  if (!body.success)
    throw new ApiError(422, "invalid_input", "invalid owner update", body.error.issues);
  if (!owner)
    throw new ApiError(404, "not_found", "launch a worker before setting a payout account");
  const account = body.data.hederaPayoutAccount;
  if (account !== null) {
    const check = await checkPayoutAccount(account);
    if (!check.ok)
      throw new ApiError(
        422,
        "invalid_input",
        check.reason === "not_associated"
          ? `${account} is not associated with USDC; associate it before using it for payouts`
          : `${account} is ${check.reason === "deleted" ? "deleted" : "not a Hedera testnet account"}`,
      );
  }
  const r = await db
    .from("owners")
    .update({ hedera_payout_account: account })
    .eq("privy_user_id", privyUserId)
    .select("id")
    .maybeSingle();
  if (r.error) throw new UpstreamError("db", `update payout account: ${r.error.message}`);
  if (!r.data) throw new ApiError(404, "not_found", "owner not found");
  res.json({ hederaPayoutAccount: account });
});

const PayoutQuery = z.object({
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
const Atomic = z.union([z.string().regex(/^\d+$/), z.number().int().safe().nonnegative()]);
const OwnerPayoutRow = z.object({
  id: z.string().uuid(),
  payout_date: z.string(),
  gross_atomic: Atomic,
  owner_atomic: Atomic,
  fee_atomic: Atomic,
  status: z.enum(["pending", "submitted", "confirmed", "failed", "uncertain"]),
  hedera_tx_id: z.string().nullable(),
  destination_account: z.string().nullable(),
  created_at: z.string(),
  agents: z.union([
    z.object({ label: z.string(), owner_id: z.string().uuid() }),
    z.array(z.object({ label: z.string(), owner_id: z.string().uuid() })).length(1),
  ]),
});

meAgentsRouter.get("/me/payouts", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const { owner } = await requireOwner(req.header("authorization"));
  const query = PayoutQuery.safeParse(req.query);
  if (!query.success) throw new ApiError(422, "invalid_input", "invalid payout query");
  const { page, limit } = query.data;
  if (!owner) {
    res.json({ items: [], page, limit });
    return;
  }
  const from = (page - 1) * limit;
  const result = await db
    .from("payouts")
    .select(
      "id,payout_date,gross_atomic,owner_atomic,fee_atomic,status,hedera_tx_id,destination_account,created_at,agents!inner(label,owner_id)",
    )
    .eq("agents.owner_id", owner.id)
    .order("payout_date", { ascending: false })
    .order("id", { ascending: false })
    .range(from, from + limit);
  if (result.error) throw new UpstreamError("db", `owner payouts: ${result.error.message}`);
  const items = (result.data ?? []).map((raw: unknown) => {
    const row = OwnerPayoutRow.safeParse(raw);
    if (!row.success) throw new UpstreamError("db", "owner payout record is malformed");
    const agent = Array.isArray(row.data.agents) ? row.data.agents[0]! : row.data.agents;
    if (agent.owner_id !== owner.id) throw new UpstreamError("db", "owner scope violated");
    return {
      id: row.data.id,
      label: agent.label,
      payoutDate: row.data.payout_date,
      grossAtomic: String(row.data.gross_atomic),
      ownerAtomic: String(row.data.owner_atomic),
      feeAtomic: String(row.data.fee_atomic),
      status: row.data.status,
      transactionId: row.data.hedera_tx_id,
      destinationAccount: row.data.destination_account,
      createdAt: row.data.created_at,
    };
  });
  res.json({
    items: items.slice(0, limit),
    page,
    limit,
    ...(items.length > limit ? { nextPage: page + 1 } : {}),
  });
});

// ---- Owner record edits (docs/06 "Edit records" drawer) -----------------------------------
// The server never writes these records: it returns the exact values to write, the owner signs
// one resolver multicall with their own wallet, then /sync re-reads ENS and follows it.

const DraftBody = z
  .object({
    priceAtomic: z
      .string()
      .regex(/^[1-9]\d{0,15}$/)
      .optional(),
    description: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .refine((b) => b.priceAtomic !== undefined || b.description !== undefined, {
    message: "nothing to change",
  });

function recordInput(agent: AgentRow) {
  if (!agent.hedera_account_id)
    throw new ApiError(409, "invalid_state", "agent has no payout account yet");
  return {
    label: agent.label,
    ensName: agent.ens_name,
    skill: agent.skill,
    model: agent.model,
    priceAtomic: BigInt(agent.price_atomic),
    priceUnit: agent.price_unit,
    payTo: agent.hedera_account_id,
    usdcTokenId: env.HEDERA_USDC_TOKEN_ID,
    serverUrl: env.PUBLIC_SERVER_URL,
    webUrl: env.PUBLIC_WEB_URL,
  };
}

async function editableAgent(authorization: string | undefined, rawId: unknown) {
  const { owner } = await requireOwner(authorization);
  const id = AgentId.safeParse(rawId);
  if (!id.success || !owner) throw new ApiError(404, "not_found", "no such agent");
  const agent = await ownedAgent(owner.id, id.data);
  if (!agent) throw new ApiError(404, "not_found", "no such agent");
  if (!agent.resolver_address)
    throw new ApiError(409, "invalid_state", "agent is not registered on ENS yet");
  return { owner, agent };
}

meAgentsRouter.post("/me/agents/:id/records/draft", json, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const { owner, agent } = await editableAgent(req.header("authorization"), req.params.id);
  const body = DraftBody.safeParse(req.body);
  if (!body.success)
    throw new ApiError(422, "invalid_input", "invalid record edit", body.error.issues);
  const priceAtomic =
    body.data.priceAtomic === undefined ? undefined : BigInt(body.data.priceAtomic);
  if (priceAtomic !== undefined && priceAtomic > MAX_PRICE_ATOMIC)
    throw new ApiError(422, "invalid_input", "price is above 10 USDC per unit");
  const records = draftRecordEdits(recordInput(agent), {
    ...(priceAtomic !== undefined ? { priceAtomic } : {}),
    ...(body.data.description !== undefined ? { description: body.data.description } : {}),
  });
  res.json({
    ensName: agent.ens_name,
    dnsName: toHex(packetToBytes(normalize(agent.ens_name))),
    resolver: agent.resolver_address,
    // The registrar granted record roles to the ENS owner chosen at launch.
    signer: owner.evm_address,
    records,
  });
});

meAgentsRouter.post("/me/agents/:id/records/sync", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const { agent } = await editableAgent(req.header("authorization"), req.params.id);
  const recs = await readAgentRecords(agent.ens_name, true);
  if (!recs.resolver || recs.resolver.toLowerCase() !== agent.resolver_address!.toLowerCase())
    throw new UpstreamError(
      "ens",
      `${agent.ens_name} no longer resolves through its registered resolver`,
    );
  const price = parsePriceRecord(recs.texts["nightshift.price"], {
    asset: env.HEDERA_USDC_TOKEN_ID,
    unit: agent.price_unit,
  });
  if (!price.ok)
    throw new ApiError(409, "invalid_state", `ENS price record rejected: ${price.reason}`);
  if (price.amount > MAX_PRICE_ATOMIC)
    throw new ApiError(409, "invalid_state", "ENS price is above 10 USDC per unit");
  if (price.amount.toString() !== String(agent.price_atomic)) {
    const r = await db
      .from("agents")
      .update({ price_atomic: price.amount.toString() })
      .eq("id", agent.id)
      .eq("owner_id", agent.owner_id)
      .select("id")
      .maybeSingle();
    if (r.error) throw new UpstreamError("db", `sync price ${agent.id}: ${r.error.message}`);
    forgetAgent(agent.label);
    log("db", "price synced from ENS", { agent: agent.label, price: price.amount.toString() });
  }
  let directorySynced = true;
  try {
    await syncAgentToDirectory(agent.label);
  } catch (error) {
    directorySynced = false;
    logError("ens", `directory sync for ${agent.label} failed`, error);
  }
  res.json({
    priceAtomic: price.amount.toString(),
    description: recs.texts["description"] ?? null,
    directorySynced,
  });
});
