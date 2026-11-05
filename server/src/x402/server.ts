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

export const RUN_ROUTE = "POST /a/:label/run";
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
    } catch (err) {
      return logError("db", `job ${jobId} settled on-chain but row update failed`, err);
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
    logError("x402", `settle failed for job ${jobId ?? "?"}`, ctx.error);
    if (jobId)
      await updateJob(jobId, {
        status: "settle_failed",
        error: ctx.error.message.slice(0, 500),
      }).catch(() => {});
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
  try {
    const job = await jobById(jobId);
    if (!job) throw new Error("job row missing");
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
