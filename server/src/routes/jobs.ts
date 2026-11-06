import { Router } from "express";
import { HEDERA_NETWORK } from "@nightshift/shared";
import { z } from "zod";
import { env } from "../config.js";
import { db } from "../db/client.js";
import { ApiError, UpstreamError } from "../errors.js";
import { verifyJobStatusToken } from "../quote-signing.js";

const Uuid = z.string().uuid();
const SafeJob = z.object({
  id: z.string().uuid(),
  status: z.enum([
    "running",
    "done",
    "settled",
    "failed_upstream",
    "failed_internal",
    "settle_failed",
    "refused_budget",
    "needs_reconciliation",
  ]),
  units: z.union([z.string().regex(/^\d+(?:\.\d+)?$/), z.number().finite().nonnegative()]),
  price_atomic: z.union([z.string().regex(/^\d+$/), z.number().int().safe().nonnegative()]),
  hedera_tx_id: z.string().nullable(),
  hcs_sequence: z
    .union([z.string().regex(/^\d+$/), z.number().int().safe().nonnegative()])
    .nullable(),
  output_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  created_at: z.string().datetime({ offset: true }),
  agents: z.object({ label: z.string(), ens_name: z.string() }),
});

export type SafeJobStatus = Omit<z.infer<typeof SafeJob>, "agents"> & {
  agent: { label: string; ensName: string };
  asset: string;
  network: string;
};

export function parseStatusCapability(rawId: unknown, authorization: string | undefined): string {
  const parsedId = Uuid.safeParse(rawId);
  if (!parsedId.success) throw new ApiError(422, "invalid_input", "job id must be a UUID");
  const match = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(authorization ?? "");
  if (!match) throw new ApiError(401, "unauthorized", "job status capability is required");
  try {
    verifyJobStatusToken(match[1]!, env.NIGHTSHIFT_QUOTE_VERIFY_PUBLIC_KEY, parsedId.data);
  } catch {
    throw new ApiError(401, "unauthorized", "job status capability is invalid or expired");
  }
  return parsedId.data;
}

export function safeJobStatus(requestedId: string, row: unknown): SafeJobStatus | null {
  if (row === null) return null;
  const parsed = SafeJob.safeParse(row);
  if (!parsed.success || parsed.data.id !== requestedId)
    throw new UpstreamError("db", "job status record is malformed or mismatched");
  const { agents, ...safeFields } = parsed.data;
  return {
    ...safeFields,
    agent: {
      label: agents.label,
      ensName: agents.ens_name,
    },
    asset: env.HEDERA_USDC_TOKEN_ID,
    network: HEDERA_NETWORK,
  };
}

export const jobsRouter = Router();

jobsRouter.get("/jobs/:id/status", async (req, res) => {
  const id = parseStatusCapability(req.params.id, req.header("authorization"));
  const result = await db
    .from("jobs")
    .select(
      "id,status,units,price_atomic,hedera_tx_id,hcs_sequence,output_sha256,created_at,agents!inner(label,ens_name)",
    )
    .eq("id", id)
    .maybeSingle();
  if (result.error) throw new UpstreamError("db", `job status lookup: ${result.error.message}`);
  const status = safeJobStatus(id, result.data);
  if (!status) throw new ApiError(404, "not_found", "job not found");
  res.setHeader("Cache-Control", "no-store");
  res.json(status);
});
