import { AccountId, Client, PrivateKey, TokenId, TransferTransaction } from "@hiero-ledger/sdk";
import { decrypt } from "../crypto.js";
import { db } from "../db/client.js";
import { env } from "../config.js";
import { UpstreamError } from "../errors.js";
import { log, logError } from "../log.js";
import { submitHcs } from "../hedera/hcs.js";

export const PAYOUT_MINIMUM_ATOMIC = 10_000n;
/** Nightshift's take: 10% of each payout to TREASURY_ACCOUNT_ID, 90% to the owner (docs/01). */
export const PAYOUT_FEE_BPS = 1_000;

export interface PayoutRecord {
  id: string;
  agent_id: string;
  payout_date: string;
  gross_atomic: string | number;
  owner_atomic: string | number;
  fee_atomic: string | number;
  status: "pending" | "submitted" | "confirmed" | "failed" | "uncertain";
  hedera_tx_id: string | null;
  destination_account: string | null;
  updated_at?: string | null;
}

export interface PayoutTransfer {
  transactionId: string;
}

export class PayoutTransferError extends Error {
  constructor(
    message: string,
    readonly uncertain: boolean,
  ) {
    super(message);
    this.name = "PayoutTransferError";
  }
}

export interface PayoutStore {
  claimEligible(date: string): Promise<PayoutRecord[]>;
  listRetryable(): Promise<PayoutRecord[]>;
  listSubmitted(olderThan: string): Promise<PayoutRecord[]>;
  claimSubmission(id: string): Promise<boolean>;
  mark(
    id: string,
    status: PayoutRecord["status"],
    fields?: { hedera_tx_id?: string; error_code?: string },
  ): Promise<void>;
  sourceFor(id: string): Promise<{
    accountId: string;
    privateKey: string;
    destinationAccount: string;
    grossAtomic: bigint;
    ownerAtomic: bigint;
    feeAtomic: bigint;
  }>;
}

export type PayoutSender = (args: {
  sourceAccount: string;
  sourcePrivateKey: string;
  destinationAccount: string;
  grossAtomic: bigint;
  ownerAtomic: bigint;
  feeAtomic: bigint;
}) => Promise<PayoutTransfer>;

export function calculatePayout(
  gross: bigint,
  feeBps = PAYOUT_FEE_BPS,
): {
  ownerAtomic: bigint;
  feeAtomic: bigint;
} {
  if (gross <= 0n) throw new Error("payout gross must be positive");
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000)
    throw new Error("payout fee basis points are invalid");
  const feeAtomic = (gross * BigInt(feeBps) + 5_000n) / 10_000n;
  return { ownerAtomic: gross - feeAtomic, feeAtomic };
}

async function updatePayout(id: string, patch: Record<string, unknown>): Promise<void> {
  const result = await db.from("payouts").update(patch).eq("id", id).select("id").maybeSingle();
  if (result.error) throw new UpstreamError("db", `update payout ${id}: ${result.error.message}`);
  if (!result.data) throw new UpstreamError("db", `payout ${id} disappeared during state update`);
}

function dbPayout(row: Record<string, unknown>): PayoutRecord {
  return {
    id: String(row.id),
    agent_id: String(row.agent_id),
    payout_date: String(row.payout_date),
    gross_atomic: row.gross_atomic as string | number,
    owner_atomic: row.owner_atomic as string | number,
    fee_atomic: row.fee_atomic as string | number,
    status: row.status as PayoutRecord["status"],
    hedera_tx_id: typeof row.hedera_tx_id === "string" ? row.hedera_tx_id : null,
    destination_account:
      typeof row.destination_account === "string" ? row.destination_account : null,
    updated_at: typeof row.updated_at === "string" ? row.updated_at : null,
  };
}

function atomic(value: string | number): bigint {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0))
    throw new UpstreamError("db", "payout atomic amount is not safely representable");
  if (typeof value === "string" && !/^\d+$/.test(value))
    throw new UpstreamError("db", "payout atomic amount is malformed");
  return BigInt(value);
}

const databaseStore: PayoutStore = {
  async claimEligible(date) {
    const result = await db.rpc("claim_daily_payouts", {
      p_payout_date: date,
      p_minimum_atomic: PAYOUT_MINIMUM_ATOMIC.toString(),
      p_fee_bps: PAYOUT_FEE_BPS,
      p_asset: env.HEDERA_USDC_TOKEN_ID,
    });
    if (result.error)
      throw new UpstreamError("db", `claim payout batches: ${result.error.message}`);
    return ((result.data ?? []) as Record<string, unknown>[]).map(dbPayout);
  },
  async listRetryable() {
    const result = await db
      .from("payouts")
      .select(
        "id,agent_id,payout_date,gross_atomic,owner_atomic,fee_atomic,status,hedera_tx_id,destination_account,updated_at",
      )
      .in("status", ["pending", "failed"]);
    if (result.error)
      throw new UpstreamError("db", `list retryable payouts: ${result.error.message}`);
    return ((result.data ?? []) as Record<string, unknown>[]).map(dbPayout);
  },
  async listSubmitted(olderThan) {
    const result = await db
      .from("payouts")
      .select(
        "id,agent_id,payout_date,gross_atomic,owner_atomic,fee_atomic,status,hedera_tx_id,destination_account,updated_at",
      )
      .eq("status", "submitted")
      .lt("updated_at", olderThan);
    if (result.error)
      throw new UpstreamError("db", `list submitted payouts: ${result.error.message}`);
    return ((result.data ?? []) as Record<string, unknown>[]).map(dbPayout);
  },
  async claimSubmission(id) {
    const result = await db
      .from("payouts")
      .update({ status: "submitted", error_code: null, updated_at: new Date().toISOString() })
      .eq("id", id)
      .in("status", ["pending", "failed"])
      .select("id")
      .maybeSingle();
    if (result.error) throw new UpstreamError("db", `claim payout ${id}: ${result.error.message}`);
    return Boolean(result.data);
  },
  async mark(id, status, fields = {}) {
    await updatePayout(id, { ...fields, status, updated_at: new Date().toISOString() });
  },
  async sourceFor(id) {
    const result = await db
      .from("payouts")
      .select(
        "id,gross_atomic,owner_atomic,fee_atomic,destination_account,agents!inner(hedera_account_id,agent_secrets!inner(hedera_private_key_enc))",
      )
      .eq("id", id)
      .single();
    if (result.error) throw new UpstreamError("db", `payout source ${id}: ${result.error.message}`);
    const row = result.data as {
      gross_atomic: string | number;
      owner_atomic: string | number;
      fee_atomic: string | number;
      destination_account: string | null;
      agents:
        | {
            hedera_account_id: string | null;
            agent_secrets:
              { hedera_private_key_enc: string } | { hedera_private_key_enc: string }[];
          }
        | {
            hedera_account_id: string | null;
            agent_secrets:
              { hedera_private_key_enc: string } | { hedera_private_key_enc: string }[];
          }[];
    };
    const agent = Array.isArray(row.agents) ? row.agents[0] : row.agents;
    const secrets = agent
      ? Array.isArray(agent.agent_secrets)
        ? agent.agent_secrets[0]
        : agent.agent_secrets
      : undefined;
    if (!agent?.hedera_account_id || !row.destination_account || !secrets?.hedera_private_key_enc)
      throw new UpstreamError("db", `payout ${id} is missing a source, destination, or key`);
    const privateKey = decrypt(secrets.hedera_private_key_enc, env.SECRETS_MASTER_KEY);
    return {
      accountId: agent.hedera_account_id,
      privateKey,
      destinationAccount: row.destination_account,
      grossAtomic: atomic(row.gross_atomic),
      ownerAtomic: atomic(row.owner_atomic),
      feeAtomic: atomic(row.fee_atomic),
    };
  },
};

export async function sendPayoutTransfer(args: {
  sourceAccount: string;
  sourcePrivateKey: string;
  destinationAccount: string;
  grossAtomic: bigint;
  ownerAtomic: bigint;
  feeAtomic: bigint;
}): Promise<PayoutTransfer> {
  if (args.grossAtomic !== args.ownerAtomic + args.feeAtomic)
    throw new PayoutTransferError("payout amounts do not reconcile", false);
  if (!/^0\.0\.\d+$/.test(args.sourceAccount) || !/^0\.0\.\d+$/.test(args.destinationAccount))
    throw new PayoutTransferError("payout account id is malformed", false);
  if (!/^0\.0\.\d+$/.test(env.TREASURY_ACCOUNT_ID))
    throw new PayoutTransferError("treasury account id is malformed", false);
  const sourceId = AccountId.fromString(args.sourceAccount);
  const sourceKey = PrivateKey.fromStringECDSA(args.sourcePrivateKey);
  const client = Client.forTestnet().setOperator(sourceId, sourceKey).setRequestTimeout(30_000);
  try {
    const transaction = new TransferTransaction()
      .addTokenTransfer(TokenId.fromString(env.HEDERA_USDC_TOKEN_ID), sourceId, -args.grossAtomic)
      .addTokenTransfer(
        TokenId.fromString(env.HEDERA_USDC_TOKEN_ID),
        AccountId.fromString(args.destinationAccount),
        args.ownerAtomic,
      );
    if (args.feeAtomic > 0n)
      transaction.addTokenTransfer(
        TokenId.fromString(env.HEDERA_USDC_TOKEN_ID),
        AccountId.fromString(env.TREASURY_ACCOUNT_ID),
        args.feeAtomic,
      );
    const response = await transaction.execute(client);
    const receipt = await response.getReceipt(client);
    if (receipt.status.toString() !== "SUCCESS")
      throw new PayoutTransferError(`payout transaction status ${receipt.status}`, false);
    return { transactionId: response.transactionId.toString() };
  } catch (error) {
    if (error instanceof PayoutTransferError) throw error;
    throw new PayoutTransferError(
      "payout submission outcome is uncertain; manual reconciliation required",
      true,
    );
  } finally {
    client.close();
  }
}

/** Called after a confirmed transfer. Best effort: never changes the payout's money state. */
export type PayoutAnnouncer = (payout: PayoutRecord, transactionId: string) => Promise<void>;

/** HCS audit message for a confirmed payout (skipped when HCS_SUBMIT_ENABLED=false). */
export async function announcePayoutOnHcs(
  payout: PayoutRecord,
  transactionId: string,
): Promise<void> {
  if (!env.HCS_SUBMIT_ENABLED) return;
  const agent = await db.from("agents").select("ens_name").eq("id", payout.agent_id).maybeSingle();
  if (agent.error || !agent.data)
    throw new UpstreamError(
      "db",
      `payout agent ${payout.agent_id}: ${agent.error?.message ?? "missing"}`,
    );
  const seq = await submitHcs({
    v: 1,
    type: "payout",
    agent: (agent.data as { ens_name: string }).ens_name,
    payout: payout.id,
    date: payout.payout_date,
    gross: String(payout.gross_atomic),
    owner: String(payout.owner_atomic),
    fee: String(payout.fee_atomic),
    asset: env.HEDERA_USDC_TOKEN_ID,
    to: payout.destination_account ?? "",
    treasury: env.TREASURY_ACCOUNT_ID,
    tx: transactionId,
    ts: new Date().toISOString(),
  });
  log("hedera", "payout logged to HCS", { payout: payout.id, seq: seq.toString() });
}

/** The payout batch date: today's UTC date, or tomorrow's to include today's jobs. */
export function payoutDate(now: Date, throughNow = false): string {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (throughNow) day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}

export async function runDailyPayouts(
  options: {
    store?: PayoutStore;
    sender?: PayoutSender;
    announce?: PayoutAnnouncer;
    now?: Date;
    /** Operator-triggered run (scripts/payday): runs even when PAYOUTS_ENABLED=false. */
    manual?: boolean;
    /**
     * Include jobs settled before the next 00:00 UTC (the batch is dated tomorrow, i.e. the
     * midnight the shift ends). The scheduled 00:15 run for that date then finds it already
     * claimed and pays only later jobs on the following day.
     */
    throughNow?: boolean;
  } = {},
): Promise<{ confirmed: number; failed: number; uncertain: number; skipped: number }> {
  const mockedTestRun =
    env.NODE_ENV === "test" && options.store !== undefined && options.sender !== undefined;
  if (options.manual && env.NIGHTSHIFT_SIMULATION)
    throw new Error("manual payouts are refused in simulation mode");
  if (!env.PAYOUTS_ENABLED && !mockedTestRun && !options.manual) {
    log("cron", "daily payout processing is disabled");
    return { confirmed: 0, failed: 0, uncertain: 0, skipped: 0 };
  }
  const store = options.store ?? databaseStore;
  const sender = options.sender ?? sendPayoutTransfer;
  const announce: PayoutAnnouncer =
    options.announce ?? (mockedTestRun ? async () => {} : announcePayoutOnHcs);
  const now = options.now ?? new Date();
  const date = payoutDate(now, options.throughNow);
  const claimed = await store.claimEligible(date);
  const interrupted = await store.listSubmitted(new Date(now.getTime() - 5 * 60_000).toISOString());
  for (const payout of interrupted) {
    await store.mark(payout.id, "uncertain", { error_code: "interrupted_after_submission" });
    logError(
      "cron",
      `payout ${payout.id} was submitted before interruption; manual reconciliation required`,
    );
  }
  const retryable = await store.listRetryable();
  const batch = new Map([...claimed, ...retryable].map((payout) => [payout.id, payout]));
  const counts = { confirmed: 0, failed: 0, uncertain: interrupted.length, skipped: 0 };
  for (const payout of batch.values()) {
    if (!(await store.claimSubmission(payout.id))) {
      counts.skipped++;
      continue;
    }
    let transferStarted = false;
    let transactionId: string | undefined;
    try {
      const source = await store.sourceFor(payout.id);
      if (source.grossAtomic !== source.ownerAtomic + source.feeAtomic)
        throw new PayoutTransferError("stored payout amounts do not reconcile", false);
      transferStarted = true;
      const result = await sender({
        sourceAccount: source.accountId,
        sourcePrivateKey: source.privateKey,
        destinationAccount: source.destinationAccount,
        grossAtomic: source.grossAtomic,
        ownerAtomic: source.ownerAtomic,
        feeAtomic: source.feeAtomic,
      });
      transactionId = result.transactionId;
      if (!/^0\.0\.\d+@\d+\.\d+$/.test(transactionId))
        throw new PayoutTransferError("transfer returned an invalid transaction id", true);
      await store.mark(payout.id, "confirmed", { hedera_tx_id: transactionId });
      counts.confirmed++;
      log("hedera", "daily payout confirmed", { payout: payout.id, transaction: transactionId });
      await announce(payout, transactionId).catch((error: unknown) =>
        logError("hedera", `payout ${payout.id} confirmed but HCS log failed`, error),
      );
    } catch (error) {
      const uncertain =
        transferStarted && (!(error instanceof PayoutTransferError) || error.uncertain);
      const status = uncertain ? "uncertain" : "failed";
      try {
        await store.mark(payout.id, status, {
          ...(transactionId ? { hedera_tx_id: transactionId } : {}),
          error_code: uncertain ? "transfer_outcome_unknown" : "transfer_failed",
        });
      } catch (stateError) {
        logError("db", `could not record payout ${payout.id} as ${status}`, stateError);
      }
      counts[status]++;
      logError("hedera", `payout ${payout.id} ${status}`, error);
    }
  }
  log("cron", "daily payout batch finished", counts);
  return counts;
}
