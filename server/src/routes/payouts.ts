import { Router } from "express";
import { z } from "zod";
import { db } from "../db/client.js";
import { ApiError, UpstreamError } from "../errors.js";

export const payoutsRouter = Router();

const Label = z.string().regex(/^[a-z0-9-]{3,32}$/);
const Pagination = z.object({
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const statuses = new Set(["pending", "submitted", "confirmed", "failed", "uncertain"]);

function atomicString(value: string | number): string {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0))
    throw new UpstreamError("db", "payout atomic amount is not safely representable");
  if (typeof value === "string" && !/^\d+$/.test(value))
    throw new UpstreamError("db", "payout atomic amount is malformed");
  return String(value);
}

payoutsRouter.get("/agents/:label/payouts", async (req, res) => {
  const label = Label.safeParse(req.params.label);
  if (!label.success) throw new ApiError(422, "invalid_label", "bad label");
  const pagination = Pagination.safeParse(req.query);
  if (!pagination.success)
    throw new ApiError(422, "invalid_input", "invalid pagination", pagination.error.issues);

  const agentResult = await db.from("agents").select("id").eq("label", label.data).maybeSingle();
  if (agentResult.error)
    throw new UpstreamError("db", `payout agent lookup: ${agentResult.error.message}`);
  if (!agentResult.data) throw new ApiError(404, "not_found", `no agent ${label.data}`);

  const { page, limit } = pagination.data;
  const from = (page - 1) * limit;
  const result = await db
    .from("payouts")
    .select("id,payout_date,gross_atomic,owner_atomic,fee_atomic,status,hedera_tx_id,created_at")
    .eq("agent_id", (agentResult.data as { id: string }).id)
    .order("payout_date", { ascending: false })
    .order("id", { ascending: false })
    .range(from, from + limit);
  if (result.error) throw new UpstreamError("db", `payout history: ${result.error.message}`);

  const rows = (result.data ?? []) as {
    id: string;
    payout_date: string;
    gross_atomic: string | number;
    owner_atomic: string | number;
    fee_atomic: string | number;
    status: string;
    hedera_tx_id: string | null;
    created_at: string;
  }[];
  const hasMore = rows.length > limit;
  res.json({
    items: rows.slice(0, limit).map((row) => {
      if (!statuses.has(row.status))
        throw new UpstreamError("db", "payout contains an unknown status");
      return {
        id: row.id,
        payoutDate: row.payout_date,
        grossAtomic: atomicString(row.gross_atomic),
        ownerAtomic: atomicString(row.owner_atomic),
        feeAtomic: atomicString(row.fee_atomic),
        status: row.status,
        transactionId: row.hedera_tx_id,
        createdAt: row.created_at,
      };
    }),
    ...(hasMore ? { nextPage: page + 1 } : {}),
  });
});
