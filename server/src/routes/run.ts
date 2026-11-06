// /a/:label/run — runPrecheck (before x402) and runHandler (after x402 verify, before settle).
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { createHash } from "node:crypto";
import multer from "multer";
import { big } from "../db/client.js";
import {
  agentByLabel,
  agentZgKey,
  insertJob,
  transitionAgentStatus,
  updateJob,
} from "../db/queries.js";
import type { AgentRow } from "../db/types.js";
import { ApiError, UpstreamError } from "../errors.js";
import { BillingUnavailableError } from "../zg/router.js";
import { log, logError } from "../log.js";
import { parseDeclaredUnits, priceFor } from "../pricing.js";
import { getSkill, type Skill, type SkillInput } from "../skills/index.js";
import { MAX_AUDIO_BYTES } from "../skills/audio.js";
import { JOB_HEADER } from "../x402/server.js";
import {
  canRun,
  releaseBudget,
  reserveBudget,
  reservations,
  retainUncertainBudget,
} from "../zg/budget.js";
import { verifySignedQuote, type QuoteClaims } from "../quote-signing.js";
import { attachQuoteJob, failQuoteJob, failQuoteNonce } from "../quote-redemptions.js";
import { env } from "../config.js";
import { createJobStatusToken } from "../quote-signing.js";
import { HEDERA_NETWORK, userRegistryAbi } from "@nightshift/shared";
import { labelhash } from "viem";
import { deployment } from "../config.js";
import { sepoliaClient } from "../ens/registrar.js";
import { assertWorkerRunnable } from "../worker-lifecycle.js";
import { UploadLimiter } from "../upload-limits.js";

/** Stashed by runPrecheck for runHandler. */
export interface RunContext {
  agent: AgentRow;
  skill: Skill;
  input: SkillInput;
  units: number;
  priceAtomic: bigint;
  quote: QuoteClaims;
  budgetLease?: { releaseOnClose: boolean };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      nightshift?: RunContext;
    }
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_BYTES, files: 1 },
}).single("file");
const uploadLimiter = new UploadLimiter({
  maxRequestsPerWindow: env.UPLOAD_MAX_PER_MINUTE,
  maxConcurrentPerClient: env.UPLOAD_MAX_CONCURRENT_PER_CLIENT,
  maxConcurrentTotal: env.UPLOAD_MAX_CONCURRENT_TOTAL,
});

function parseMultipart(req: Request, res: Response): Promise<void> {
  const release = uploadLimiter.acquire(req.ip || req.socket.remoteAddress || "unknown");
  if (!release)
    return Promise.reject(
      new ApiError(429, "rate_limited", "upload capacity reached; retry after the current window"),
    );
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (action: () => void) => {
      if (finished) return;
      finished = true;
      req.off("aborted", onAbort);
      release();
      action();
    };
    const onAbort = () =>
      finish(() => reject(new ApiError(422, "invalid_input", "upload was interrupted")));
    req.once("aborted", onAbort);
    try {
      upload(req, res, (err: unknown) => {
        if (!err) {
          finish(resolve);
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        finish(() => reject(new ApiError(422, "invalid_input", `upload rejected: ${msg}`)));
      });
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

const RUNNABLE = new Set(["active", "paused_budget"]);

/**
 * A request carrying an x402 payment header is a payment attempt. The header is not yet
 * verified here, so precheck only performs side effects that are truthful regardless of who
 * sent it (recording a real budget refusal, reserving budget that is released on close).
 * Unpaid challenge requests never mutate worker or job state.
 */
function isPaymentAttempt(req: Request): boolean {
  return Boolean(req.header("payment-signature") || req.header("x-payment"));
}

/**
 * Binds a signed quote to the worker's current pricing and identity. Worker lifecycle status is
 * deliberately not part of the equality check: `active` and `paused_budget` are both runnable
 * and the budget gate decides execution, so a quote stays usable for its paid retry even when
 * the budget flag changes in between. Non-runnable workers are rejected before this runs.
 */
export function quoteMatchesWorker(
  quote: QuoteClaims,
  agent: AgentRow,
  declaredUnits: number,
  usdcTokenId: string,
): boolean {
  return (
    quote.agentId === agent.id &&
    quote.label === agent.label &&
    quote.ensName === agent.ens_name &&
    quote.units === declaredUnits &&
    quote.amount === priceFor(big(agent.price_atomic), declaredUnits).toString() &&
    quote.asset === usdcTokenId &&
    quote.network === HEDERA_NETWORK &&
    quote.payTo === agent.hedera_account_id &&
    quote.unit === agent.price_unit &&
    RUNNABLE.has(quote.status)
  );
}
const registry = {
  address: deployment.userRegistry as `0x${string}`,
  abi: userRegistryAbi,
} as const;

async function precheck(req: Request, res: Response): Promise<RunContext> {
  const label = String(req.params.label);
  const agent = await agentByLabel(label, true);
  if (!agent || !agent.hedera_account_id) throw new ApiError(404, "not_found", `no agent ${label}`);
  if (!RUNNABLE.has(agent.status))
    throw new ApiError(409, "agent_paused", `agent is ${agent.status}`);
  await assertWorkerRunnable(agent, {
    status: (name) =>
      sepoliaClient.readContract({
        ...registry,
        functionName: "getStatus",
        args: [BigInt(labelhash(name))],
      }),
    expiry: (name) =>
      sepoliaClient.readContract({
        ...registry,
        functionName: "getExpiry",
        args: [BigInt(labelhash(name))],
      }),
  });
  const skill = getSkill(agent.skill);
  if (!skill) throw new ApiError(500, "internal", `agent has unknown skill ${agent.skill}`);

  const declared = parseDeclaredUnits(req.header("x-nightshift-units"));
  if (declared === null)
    throw new ApiError(
      422,
      "invalid_input",
      "header X-Nightshift-Units is required (a positive number)",
    );
  const quoteToken = req.header("x-nightshift-quote");
  if (!quoteToken) throw new ApiError(422, "invalid_input", "signed quote is required");
  let quote: QuoteClaims;
  try {
    quote = verifySignedQuote(quoteToken, env.NIGHTSHIFT_QUOTE_VERIFY_PUBLIC_KEY);
  } catch {
    throw new ApiError(402, "invalid_input", "signed quote is invalid or expired");
  }
  if (!quoteMatchesWorker(quote, agent, declared, env.HEDERA_USDC_TOKEN_ID))
    throw new ApiError(
      409,
      "invalid_input",
      "signed quote no longer matches worker pricing or identity",
    );

  await parseMultipart(req, res);
  const file = req.file;
  if (!file) throw new ApiError(422, "invalid_input", "multipart field `file` is required");
  const input: SkillInput = {
    kind: "audio",
    buf: file.buffer,
    mime: file.mimetype,
    filename: file.originalname || "audio",
  };

  let measured;
  try {
    measured = await skill.measure(input);
  } catch (err) {
    throw new ApiError(
      422,
      "invalid_input",
      err instanceof Error ? err.message : "unreadable input",
    );
  }
  if (measured.units > declared)
    throw new ApiError(
      422,
      "units_mismatch",
      `input is ${measured.units} ${skill.unit}(s), declared ${declared}`,
      {
        actual: measured.units,
        declared,
      },
    );

  const priceAtomic = priceFor(big(agent.price_atomic), declared);
  const paymentAttempt = isPaymentAttempt(req);
  const budget = await canRun(agent, measured.meterUnits);
  if (!budget.ok) {
    if (paymentAttempt) {
      // Record the refusal and flag the worker only on payment attempts; an anonymous unpaid
      // challenge is answered without writing anything.
      await insertJob({
        agent_id: agent.id,
        status: "refused_budget",
        units: declared,
        price_atomic: "0",
        error: budget.reason,
      });
      if (budget.reason === "over_budget")
        await transitionAgentStatus(agent, "active", "paused_budget");
    }
    if (budget.reason === "over_budget")
      throw new ApiError(503, "over_budget", "agent's daily 0G budget is used up", {
        resetsAt: budget.resetsAt.toISOString(),
      });
    throw new ApiError(503, "no_credits", "agent's 0G account has no credits left");
  }

  // Only a paid attempt reserves budget, released when the response closes. The worker is not
  // un-paused here: that transition happens after the payment is verified (runHandler).
  let budgetLease: RunContext["budgetLease"];
  if (paymentAttempt) {
    const reservationId = await reserveBudget(agent.id, budget.estimateUsdMicro);
    if (!reservationId)
      throw new ApiError(
        503,
        "over_budget",
        "worker budget is reserved by another execution; no payment was accepted",
      );
    const releaseLocal = reservations.hold(agent.id, budget.estimateUsdMicro);
    budgetLease = { releaseOnClose: true };
    res.on("close", () => {
      releaseLocal();
      const finish = budgetLease?.releaseOnClose
        ? releaseBudget(reservationId)
        : retainUncertainBudget(reservationId);
      void finish.catch((err: unknown) =>
        logError("db", `budget reservation ${reservationId} finalization failed`, err),
      );
    });
  }
  return { agent, skill, input, units: declared, priceAtomic, quote, budgetLease };
}

/** Runs before the x402 middleware: rejects requests nobody should pay for. */
export const runPrecheck: RequestHandler = async (req, res, next: NextFunction) => {
  try {
    req.nightshift = await precheck(req, res);
    next();
  } catch (err) {
    next(err);
  }
};

/** Runs after x402 verify. A status >= 400 cancels settlement, so the buyer is not charged. */
export const runHandler: RequestHandler = async (req, res) => {
  const ctx = req.nightshift;
  if (!ctx) throw new ApiError(500, "internal", "precheck context missing");
  const { agent, skill, input, units, priceAtomic, quote } = ctx;
  if (ctx.budgetLease) ctx.budgetLease.releaseOnClose = false;

  let jobId: string | undefined;
  try {
    jobId = await insertJob({
      agent_id: agent.id,
      status: "running",
      units,
      price_atomic: priceAtomic.toString(),
    });
    await attachQuoteJob(quote.nonce, jobId);
  } catch (err) {
    logError("db", "signed quote job initialization failed", err);
    if (jobId)
      await updateJob(jobId, {
        status: "failed_internal",
        error: "signed quote job initialization failed",
      }).catch((updateError: unknown) =>
        logError("db", `job ${jobId} initialization failure update`, updateError),
      );
    await failQuoteNonce(quote.nonce).catch((failureError: unknown) =>
      logError("db", `quote nonce ${quote.nonce} failure update`, failureError),
    );
    if (ctx.budgetLease) ctx.budgetLease.releaseOnClose = true;
    res.status(500).json({ error: "internal", message: "job initialization failed" });
    return;
  }
  if (!jobId) throw new ApiError(500, "internal", "job initialization did not return an id");
  res.setHeader(JOB_HEADER, jobId);
  // Payment is verified, the nonce is claimed and a budget reservation is held: a worker that
  // was flagged paused_budget is explicitly (and atomically) returned to active.
  if (agent.status === "paused_budget")
    await transitionAgentStatus(agent, "paused_budget", "active").catch((err: unknown) =>
      logError("db", `worker ${agent.label} un-pause after verified payment failed`, err),
    );
  const t0 = performance.now();
  let executionStarted = false;
  try {
    const key = await agentZgKey(agent.id);
    executionStarted = true;
    const out = await skill.execute({ key, model: agent.model, input });
    const outputSha256 = createHash("sha256").update(out.output, "utf8").digest("hex");
    const latency = Math.round(performance.now() - t0);
    await updateJob(jobId, {
      status: "done",
      zg_request_id: out.requestId,
      zg_provider: out.provider,
      zg_cost_usd_micro: out.costUsdMicro.toString(),
      latency_ms: latency,
      output_sha256: outputSha256,
    });
    if (ctx.budgetLease) ctx.budgetLease.releaseOnClose = true;
    log("server", "job done", { job: jobId, agent: agent.label, ms: latency });
    res.json({
      job_id: jobId,
      output: out.output,
      output_sha256: outputSha256,
      status_token: createJobStatusToken(jobId, env.NIGHTSHIFT_QUOTE_SIGNING_PRIVATE_KEY),
      zg: { request_id: out.requestId, provider: out.provider },
    });
  } catch (err) {
    if (err instanceof BillingUnavailableError) {
      // 0G executed but its cost cannot be established. The output is withheld, settlement is
      // cancelled (buyer not charged), the reservation is retained and the job is parked for
      // reconciliation with the 0G request id preserved.
      logError("0g", `job ${jobId} billing unavailable`, err);
      await updateJob(jobId, {
        status: "needs_reconciliation",
        zg_request_id: err.requestId,
        zg_provider: err.provider,
        error: "zg_billing_unavailable",
        latency_ms: Math.round(performance.now() - t0),
      }).catch((e: unknown) => logError("db", `job ${jobId} reconciliation update`, e));
      await failQuoteJob(jobId).catch((e: unknown) =>
        logError("db", `signed quote failure update for job ${jobId}`, e),
      );
      res.status(502).json({
        error: "zg_unavailable",
        message: "0G billing could not be established; you were not charged",
        job_id: jobId,
      });
      return;
    }
    const upstream = err instanceof UpstreamError && err.upstream === "0g";
    logError(upstream ? "0g" : "server", `job ${jobId} failed`, err);
    await updateJob(jobId, {
      status: upstream ? "failed_upstream" : "failed_internal",
      error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
      latency_ms: Math.round(performance.now() - t0),
    }).catch((e: unknown) => logError("db", `job ${jobId} failure update`, e));
    await failQuoteJob(jobId).catch((e: unknown) =>
      logError("db", `signed quote failure update for job ${jobId}`, e),
    );
    if (!executionStarted && ctx.budgetLease) ctx.budgetLease.releaseOnClose = true;
    if (upstream)
      res.status(502).json({
        error: "zg_unavailable",
        message: "0G inference failed; you were not charged",
        job_id: jobId,
      });
    else
      res
        .status(500)
        .json({ error: "internal", message: "job failed; you were not charged", job_id: jobId });
  }
};
