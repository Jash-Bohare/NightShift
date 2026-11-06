// x402 resource server: Hedera exact scheme, dynamic price/payTo per agent, settle hooks.
// Flow is verify -> handler -> settle (Hedera "authorization" flow; see docs/07).
import {
  HTTPFacilitatorClient,
  type HTTPRequestContext,
  type HTTPTransportContext,
  type RoutesConfig,
} from "@x402/core/server";
import { x402ResourceServer } from "@x402/express";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { HEDERA_NETWORK } from "@nightshift/shared";
import { env } from "../config.js";
import { big, db } from "../db/client.js";
import { agentByLabel, jobById, updateJob } from "../db/queries.js";
import { ApiError } from "../errors.js";
import { hashscanTx } from "../hedera/client.js";
import { submitHcs } from "../hedera/hcs.js";
import { log, logError } from "../log.js";
import { parseDeclaredUnits, priceFor } from "../pricing.js";
import { claimVerifiedQuote, failQuoteJob, settleQuoteJob } from "../quote-redemptions.js";
import { verifySignedQuote } from "../quote-signing.js";
import { recordSettlementRecovery } from "../cron/settlements.js";

export const RUN_ROUTE = "POST /a/:label/run";

/**
 * A facilitator SettleError with no transaction is a definite refusal (nothing was submitted).
 * A SettleError that carries a transaction (e.g. settlement pending), a timeout, a network error
 * or an unparseable response may hide a submitted payment: it is "uncertain" and must be
 * reconciled against Hedera, never retried automatically.
 */
export function classifySettlementFailure(error: unknown): "definite" | "uncertain" {
  if (
    error instanceof Error &&
    error.name === "SettleError" &&
    !(error as { transaction?: unknown }).transaction
  )
    return "definite";
  return "uncertain";
}
export const JOB_HEADER = "X-Nightshift-Job";

function labelFromPath(path: string): string {
  const m = /^\/a\/([^/]+)\/run$/.exec(path);
  if (!m) throw new ApiError(404, "not_found", "unknown route");
  return decodeURIComponent(m[1]!);
}

async function agentFor(ctx: HTTPRequestContext) {
  const agent = await agentByLabel(labelFromPath(ctx.path));
  // runPrecheck already rejected unknown/unconfigured agents; this guards direct misuse.
  if (!agent?.hedera_account_id) throw new ApiError(404, "not_found", "unknown agent");
  return { ...agent, hedera_account_id: agent.hedera_account_id };
}

function jobIdFrom(transportContext: unknown): string | undefined {
  const headers = (transportContext as HTTPTransportContext | undefined)?.responseHeaders;
  return headers?.[JOB_HEADER.toLowerCase()];
}

export const resourceServer = new x402ResourceServer(
  new HTTPFacilitatorClient({ url: env.X402_FACILITATOR_URL }),
)
  // Testnet USDC 0.0.429274 (6 dp) is the scheme's default asset; no override needed (docs/07).
  .register(HEDERA_NETWORK, new ExactHederaScheme())
  .onAfterVerify(async (ctx) => {
    log("x402", "verified", {
      payer: ctx.result.payer,
      amount: ctx.requirements.amount,
      payTo: ctx.requirements.payTo,
    });
    const transport = ctx.transportContext as HTTPTransportContext | undefined;
    const token = transport?.request.adapter.getHeader("x-nightshift-quote");
    if (!token)
      return { abort: true, reason: "missing_signed_quote", message: "signed quote required" };
    try {
      const quote = verifySignedQuote(token, env.NIGHTSHIFT_QUOTE_VERIFY_PUBLIC_KEY);
      const requestPath = transport?.request.path ?? "";
      const matchedPath = /^\/a\/([^/]+)\/run$/.exec(requestPath);
      if (!matchedPath || decodeURIComponent(matchedPath[1]!) !== quote.label)
        return {
          abort: true,
          reason: "quote_worker_mismatch",
          message: "signed quote does not match the requested worker",
        };
      if (
        quote.network !== ctx.requirements.network ||
        quote.asset !== ctx.requirements.asset ||
        quote.amount !== ctx.requirements.amount ||
        quote.payTo !== ctx.requirements.payTo
      )
        return {
          abort: true,
          reason: "quote_payment_mismatch",
          message: "verified payment requirements do not match the signed quote",
        };
      const agent = await agentByLabel(quote.label, true);
      if (
        !agent ||
        agent.id !== quote.agentId ||
        agent.ens_name !== quote.ensName ||
        !(await claimVerifiedQuote(quote, token, agent.id))
      )
        return {
          abort: true,
          reason: "quote_nonce_replayed",
          message: "signed quote is invalid, changed, or already used",
        };
    } catch (error) {
      logError("x402", "signed quote claim failed", error);
      return {
        abort: true,
        reason: "quote_claim_failed",
        message: "signed quote could not be claimed",
      };
    }
  })
  .onAfterSettle(async (ctx) => {
    const jobId = jobIdFrom(ctx.transportContext);
    const tx = ctx.result.transaction;
    log("x402", "settled", { job: jobId, tx, url: hashscanTx(tx) });
    if (!jobId) return logError("x402", "settled payment without job id header");
    try {
      await updateJob(jobId, {
        status: "settled",
        hedera_tx_id: tx,
        buyer_account: ctx.result.payer ?? null,
      });
      await settleQuoteJob(jobId);
    } catch (err) {
      logError("db", `job ${jobId} settled on-chain but row update failed`, err);
      try {
        await recordSettlementRecovery({
          jobId,
          desiredStatus: "settled",
          transactionId: tx,
          payerAccount: ctx.result.payer ?? null,
          amountAtomic: ctx.requirements.amount,
          asset: ctx.requirements.asset,
        });
      } catch (recoveryError) {
        logError("db", `job ${jobId} settlement recovery could not be persisted`, recoveryError);
      }
    }
    // The HCS log must not delay or fail the buyer's response; record it in the background.
    void logJobToHcs(
      jobId,
      ctx.requirements.amount,
      ctx.requirements.asset,
      ctx.result.payer ?? "",
      tx,
    );
  })
  .onSettleFailure(async (ctx) => {
    const jobId = jobIdFrom(ctx.transportContext);
    const outcome = classifySettlementFailure(ctx.error);
    logError("x402", `settle ${outcome} for job ${jobId ?? "?"}`, ctx.error);
    if (jobId) {
      const desiredStatus = outcome === "definite" ? "settle_failed" : "needs_reconciliation";
      let recoveryNeeded = false;
      try {
        await updateJob(jobId, {
          status: desiredStatus,
          error:
            outcome === "definite"
              ? "payment settlement failed"
              : "settlement outcome unknown; reconcile against Hedera before any retry",
        });
      } catch (err) {
        recoveryNeeded = true;
        logError("db", `job ${jobId} settlement failure update`, err);
      }
      try {
        await failQuoteJob(jobId);
      } catch (err) {
        recoveryNeeded = true;
        logError("db", `quote redemption failure for job ${jobId}`, err);
      }
      if (recoveryNeeded) {
        try {
          await recordSettlementRecovery({ jobId, desiredStatus });
        } catch (err) {
          logError("db", `job ${jobId} failure recovery could not be persisted`, err);
        }
      }
    }
  })
  .onVerifiedPaymentCanceled(async (ctx) => {
    log("x402", "settlement cancelled", { reason: ctx.reason, status: ctx.responseStatus });
  });

async function logJobToHcs(
  jobId: string,
  amount: string,
  asset: string,
  payer: string,
  tx: string,
): Promise<void> {
  if (!env.HCS_SUBMIT_ENABLED) {
    log("hedera", "HCS submission disabled (HCS_SUBMIT_ENABLED=false); job not logged", {
      job: jobId,
    });
    return;
  }
  try {
    const job = await jobById(jobId);
    if (!job) throw new Error("job row missing");
    if (!job.output_sha256) throw new Error("job output digest missing");
    const agent = await ensNameOf(job.agent_id);
    const seq = await submitHcs({
      v: 1,
      type: "job",
      agent,
      job: jobId,
      units: Number(job.units),
      amount,
      asset,
      payer,
      tx,
      output_sha256: job.output_sha256,
      zg_request_id: job.zg_request_id,
      zg_provider: job.zg_provider,
      ts: new Date().toISOString(),
    });
    await updateJob(jobId, { hcs_sequence: seq.toString() });
  } catch (err) {
    logError("hedera", `HCS log for job ${jobId} failed`, err);
  }
}

async function ensNameOf(agentId: string): Promise<string> {
  const r = await db.from("agents").select("ens_name").eq("id", agentId).single();
  if (r.error) throw new Error(r.error.message);
  return (r.data as { ens_name: string }).ens_name;
}

export const routes: RoutesConfig = {
  [RUN_ROUTE]: {
    accepts: {
      scheme: "exact",
      network: HEDERA_NETWORK,
      payTo: async (ctx) => (await agentFor(ctx)).hedera_account_id,
      price: async (ctx) => {
        const agent = await agentFor(ctx);
        // runPrecheck guarantees a valid header before this runs.
        const units = parseDeclaredUnits(ctx.adapter.getHeader("x-nightshift-units")) ?? 1;
        return {
          asset: env.HEDERA_USDC_TOKEN_ID,
          amount: priceFor(big(agent.price_atomic), units).toString(),
        };
      },
      maxTimeoutSeconds: 180,
    },
    description: "Nightshift agent job",
    mimeType: "application/json",
  },
};
