import { db } from "../db/client.js";
import { UpstreamError } from "../errors.js";
import { failQuoteJob, settleQuoteJob } from "../quote-redemptions.js";
import { updateJob } from "../db/queries.js";
import { log, logError } from "../log.js";

export interface SettlementRecovery {
  id: string;
  job_id: string;
  desired_status: "settled" | "settle_failed" | "needs_reconciliation";
  transaction_id: string | null;
  payer_account: string | null;
  amount_atomic: string | number | null;
  asset: string | null;
  attempts: number;
}

export interface SettlementRecoveryStore {
  due(now: string): Promise<SettlementRecovery[]>;
  apply(row: SettlementRecovery): Promise<void>;
  resolved(row: SettlementRecovery): Promise<void>;
  retry(row: SettlementRecovery, nextAttemptAt: string): Promise<void>;
}

const databaseStore: SettlementRecoveryStore = {
  async due(now) {
    const result = await db
      .from("settlement_recoveries")
      .select("id,job_id,desired_status,transaction_id,payer_account,amount_atomic,asset,attempts")
      .eq("status", "pending")
      .lte("next_attempt_at", now)
      .order("next_attempt_at", { ascending: true })
      .limit(50);
    if (result.error)
      throw new UpstreamError("db", `list settlement recoveries: ${result.error.message}`);
    return (result.data ?? []) as SettlementRecovery[];
  },
  async apply(row) {
    if (row.desired_status === "settled") {
      if (!row.transaction_id || row.amount_atomic === null || !row.asset)
        throw new UpstreamError("db", `settlement recovery ${row.id} is missing receipt fields`);
      await updateJob(row.job_id, {
        status: "settled",
        hedera_tx_id: row.transaction_id,
        buyer_account: row.payer_account,
      });
      await settleQuoteJob(row.job_id);
      return;
    }
    await updateJob(row.job_id, {
      status: row.desired_status,
      error:
        row.desired_status === "settle_failed"
          ? "payment settlement failed"
          : "settlement outcome unknown; reconcile against Hedera before any retry",
    });
    await failQuoteJob(row.job_id);
  },
  async resolved(row) {
    const result = await db
      .from("settlement_recoveries")
      .update({
        status: "resolved",
        attempts: row.attempts + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .select("id")
      .maybeSingle();
    if (result.error)
      throw new UpstreamError(
        "db",
        `resolve settlement recovery ${row.id}: ${result.error.message}`,
      );
    if (!result.data) throw new UpstreamError("db", `settlement recovery ${row.id} disappeared`);
  },
  async retry(row, nextAttemptAt) {
    const result = await db
      .from("settlement_recoveries")
      .update({
        attempts: row.attempts + 1,
        next_attempt_at: nextAttemptAt,
        last_error_code: "reconciliation_failed",
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (result.error)
      throw new UpstreamError(
        "db",
        `update settlement recovery ${row.id}: ${result.error.message}`,
      );
  },
};

export async function recordSettlementRecovery(input: {
  jobId: string;
  desiredStatus: SettlementRecovery["desired_status"];
  transactionId?: string;
  payerAccount?: string | null;
  amountAtomic?: string;
  asset?: string;
}): Promise<void> {
  const result = await db.from("settlement_recoveries").upsert(
    {
      job_id: input.jobId,
      desired_status: input.desiredStatus,
      transaction_id: input.transactionId ?? null,
      payer_account: input.payerAccount ?? null,
      amount_atomic: input.amountAtomic ?? null,
      asset: input.asset ?? null,
      status: "pending",
      next_attempt_at: new Date().toISOString(),
      last_error_code: "callback_update_failed",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "job_id" },
  );
  if (result.error)
    throw new UpstreamError(
      "db",
      `record settlement recovery for job ${input.jobId}: ${result.error.message}`,
    );
}

export async function runSettlementRecoveries(
  options: { store?: SettlementRecoveryStore; now?: Date } = {},
): Promise<{ resolved: number; retried: number }> {
  const store = options.store ?? databaseStore;
  const now = options.now ?? new Date();
  const rows = await store.due(now.toISOString());
  const counts = { resolved: 0, retried: 0 };
  for (const row of rows) {
    try {
      await store.apply(row);
      await store.resolved(row);
      counts.resolved++;
    } catch (error) {
      const delayMinutes = Math.min(60, 2 ** Math.min(row.attempts, 6));
      const next = new Date(now.getTime() + delayMinutes * 60_000).toISOString();
      await store.retry(row, next);
      counts.retried++;
      logError("db", `settlement recovery for job ${row.job_id} deferred`, error);
    }
  }
  if (rows.length) log("cron", "settlement recovery batch finished", counts);
  return counts;
}
