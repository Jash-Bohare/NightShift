import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatUsdc,
  SKILL_IDS,
  type AgentReputation,
  type BuyerEvent,
  type BuyerEventHandler,
  type BuyerRules,
} from "@nightshift/shared";
import { parseBuffer } from "music-metadata";
import { loadBuyerConfig, type BuyerConfig } from "./config.js";
import {
  discoverDirectory,
  verifyDirectoryCandidates,
  type DirectoryHint,
  type DiscoveryOptions,
} from "./discovery.js";
import { rankCandidates, type RankedAgent, type Rejection, type VerifiedAgent } from "./decide.js";
import { executePaidJob, type PaidJobResponse } from "./execution.js";
import {
  HederaMirrorClient,
  type PaymentExpectation,
  type PaymentIntent,
  type PaymentVerification,
} from "./hedera.js";
import { hashscanTxUrl } from "./hashscan.js";
import { createX402Fetch, paymentReadinessError } from "./payment.js";
import { fetchWorkerQuote, validateQuote, type WorkerQuote } from "./quote.js";
import type { BuyerExecutionReport } from "./report.js";
import { acquireBuyerRunLock } from "./run-lock.js";
import {
  loadRules,
  loadState,
  recordCompletedJob,
  recordSpend,
  validateRules,
} from "./spending.js";
import { verifySettlement, type SettlementReport } from "./settlement.js";

export interface BuyerTask {
  skill: string;
  file: string;
  units?: number;
}

export interface BuyerDependencies {
  measureMinutes(buffer: Buffer): Promise<number>;
  discover(config: BuyerConfig, skill: string): Promise<DirectoryHint[]>;
  verify(
    config: BuyerConfig,
    candidates: DirectoryHint[],
    requestedSkill: string,
    rules: BuyerRules,
    options: DiscoveryOptions,
  ): Promise<VerifiedAgent[]>;
  quote(config: BuyerConfig, label: string, units: number): Promise<WorkerQuote>;
  usdcBalance(config: BuyerConfig, accountId: string, asset: string): Promise<bigint>;
  createPaymentFetch(config: BuyerConfig, rules: BuyerRules, expected: PaymentIntent): typeof fetch;
  execute(
    config: BuyerConfig,
    agent: RankedAgent,
    file: Buffer,
    fileName: string,
    units: number,
    signedQuote: string,
    paidFetch: typeof fetch,
  ): Promise<PaidJobResponse>;
  verifyPayment(config: BuyerConfig, expected: PaymentExpectation): Promise<PaymentVerification>;
  verifySettlement(
    config: BuyerConfig,
    expected: {
      jobId: string;
      agent: RankedAgent;
      amountAtomic: bigint;
      transactionId: string;
      outputSha256: string;
      statusToken: string;
      network: string;
      units: number;
      buyerAccountId: string;
      asset: string;
    },
  ): Promise<SettlementReport>;
  dailySpentAtomic(): bigint;
  recordSpend(amountAtomic: bigint, jobCompleted: boolean): void;
  recordCompletedJob(): void;
}

export interface BuyerOptions {
  rules?: BuyerRules;
  onEvent?: BuyerEventHandler;
  config?: Partial<BuyerConfig>;
  /** Test seam; production callers should use the default safe lock path. */
  executionLockPath?: string;
  dependencies?: Partial<BuyerDependencies>;
}

export type BuyerRunResult = BuyerExecutionReport;

const BUYER_DIR = dirname(fileURLToPath(import.meta.url));
export const BUYER_RUN_LOCK_PATH = resolve(BUYER_DIR, "../.buyer-run.lock");
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const nowIso = () => new Date().toISOString();
const emptyReport = (): BuyerExecutionReport => ({
  success: false,
  jobCompleted: false,
  jobVerified: false,
  paymentState: "not-submitted",
  paymentConfirmed: false,
  settlementVerified: false,
});

async function measureMinutes(buffer: Buffer): Promise<number> {
  const metadata = await parseBuffer(
    new Uint8Array(buffer),
    { mimeType: "audio/mpeg", size: buffer.length },
    { duration: true, skipCovers: true },
  );
  const seconds = metadata.format.duration;
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0)
    throw new Error("could not determine audio duration");
  return Math.max(1, Math.ceil(seconds / 60));
}

function directoryReputation(value: DirectoryHint["reputation"]): AgentReputation | null {
  if (
    !value ||
    value.jobs === undefined ||
    value.success === undefined ||
    value.p50_ms === undefined
  )
    return null;
  return { jobs: value.jobs, success: value.success, p50_ms: value.p50_ms };
}

function staticRationale(chosen: RankedAgent, others: RankedAgent[]): string {
  const second = others[0];
  return second
    ? `Selected ${chosen.ensName} at ${formatUsdc(chosen.totalAtomic)} USDC; the next eligible worker costs ${formatUsdc(second.totalAtomic)} USDC.`
    : `Selected the only eligible verified worker, ${chosen.ensName}, at ${formatUsdc(chosen.totalAtomic)} USDC.`;
}

function defaultDependencies(): BuyerDependencies {
  const mirror = (config: BuyerConfig) => new HederaMirrorClient(config.mirrorUrl);
  return {
    measureMinutes,
    discover: discoverDirectory,
    verify: (config, candidates, requestedSkill, rules, options) =>
      verifyDirectoryCandidates(config, candidates, requestedSkill, rules, options),
    quote: fetchWorkerQuote,
    usdcBalance: (config, accountId, asset) => mirror(config).usdcBalance(accountId, asset),
    createPaymentFetch: createX402Fetch,
    execute: executePaidJob,
    verifyPayment: (config, expected) => mirror(config).verifyPayment(expected),
    verifySettlement,
    dailySpentAtomic: () => BigInt(loadState().dailySpentAtomic),
    recordSpend: (amount, jobCompleted) => {
      recordSpendOnDisk(amount, jobCompleted);
    },
    recordCompletedJob: () => {
      recordCompletedJobOnDisk();
    },
  };
}

function recordSpendOnDisk(amount: bigint, jobCompleted: boolean): void {
  recordSpend(amount, { jobCompleted });
}
function recordCompletedJobOnDisk(): void {
  recordCompletedJob();
}

export async function runBuyer(
  task: BuyerTask,
  options: BuyerOptions = {},
): Promise<BuyerRunResult> {
  const emit = (event: BuyerEvent) => options.onEvent?.(event);
  const fail = (
    step: string,
    message: string,
    report: Partial<BuyerExecutionReport> = {},
  ): BuyerRunResult => {
    emit({ kind: "error", step, message, timestamp: nowIso() });
    return { ...emptyReport(), ...report, success: false, error: message };
  };
  let lock: ReturnType<typeof acquireBuyerRunLock>;
  try {
    lock = acquireBuyerRunLock(options.executionLockPath ?? BUYER_RUN_LOCK_PATH);
  } catch (error) {
    return fail(
      "initialize",
      error instanceof Error ? error.message : "buyer run is already locked",
    );
  }
  let preserveLock = false;
  try {
    return await runBuyerLocked(task, options, emit, fail, () => {
      preserveLock = true;
    });
  } catch (error) {
    return fail("run", error instanceof Error ? error.message : "buyer execution failed");
  } finally {
    if (!preserveLock) lock.release();
  }
}

async function runBuyerLocked(
  task: BuyerTask,
  options: BuyerOptions,
  emit: (event: BuyerEvent) => void,
  fail: (step: string, message: string, report?: Partial<BuyerExecutionReport>) => BuyerRunResult,
  preserveLock: () => void,
): Promise<BuyerRunResult> {
  let config: BuyerConfig;
  let rules: BuyerRules;
  try {
    config = loadBuyerConfig(options.config);
    rules = validateRules(options.rules ?? loadRules());
  } catch (error) {
    return fail(
      "initialize",
      error instanceof Error ? error.message : "buyer configuration is invalid",
    );
  }
  const deps = { ...defaultDependencies(), ...options.dependencies };
  if (!SKILL_IDS.includes(task.skill as (typeof SKILL_IDS)[number]))
    return fail("plan", `unsupported skill ${task.skill}`);
  if (task.units !== undefined && (!Number.isSafeInteger(task.units) || task.units < 1))
    return fail("plan", "units must be a positive safe integer");

  let file: Buffer;
  let units: number;
  try {
    file = readFileSync(resolve(task.file));
    if (file.byteLength === 0 || file.byteLength > MAX_FILE_BYTES)
      return fail("plan", `audio file must be between 1 byte and ${MAX_FILE_BYTES} bytes`);
    const measured = await deps.measureMinutes(file);
    if (task.units !== undefined && task.units < measured)
      return fail("plan", `declared ${task.units} minute(s) but the file is ${measured}`);
    units = task.units ?? measured;
  } catch (error) {
    return fail(
      "plan",
      `cannot read or measure audio: ${error instanceof Error ? error.message : "invalid file"}`,
    );
  }
  emit({
    kind: "plan",
    task: { skill: task.skill, file: basename(task.file), units },
    rules,
    timestamp: nowIso(),
  });

  let candidates: DirectoryHint[];
  try {
    candidates = await deps.discover(config, task.skill);
  } catch (error) {
    return fail(
      "discover",
      `worker discovery failed: ${error instanceof Error ? error.message : "invalid response"}`,
    );
  }
  emit({
    kind: "discover",
    candidates: candidates.map((candidate) => ({
      label: candidate.label,
      ensName: candidate.ensName,
      skill: candidate.skill ?? "",
      priceAtomic: candidate.price.amount ?? "0",
      reputation: directoryReputation(candidate.reputation),
    })),
    timestamp: nowIso(),
  });
  if (candidates.length === 0) return fail("discover", `no available workers offer ${task.skill}`);

  const verified: VerifiedAgent[] = [];
  try {
    const verifiedAgents = await deps.verify(config, candidates, task.skill, rules, {
      onVerify: (candidate, result) => {
        emit({
          kind: "verify",
          label: candidate.label,
          ensName: candidate.ensName,
          ok: result.ok,
          ...(result.ok
            ? { resolver: result.agent.resolver, payTo: result.agent.payTo }
            : { reason: result.reason }),
          timestamp: nowIso(),
        });
      },
    });
    verified.push(...verifiedAgents);
  } catch (error) {
    return fail("verify", error instanceof Error ? error.message : "ENS verification failed");
  }
  if (verified.length === 0) return fail("verify", "no worker passed ENS identity verification");

  let spent: bigint;
  try {
    spent = deps.dailySpentAtomic();
  } catch (error) {
    return fail("budget", error instanceof Error ? error.message : "cannot read buyer spend state");
  }
  const dailyBudget = BigInt(rules.dailyBudgetAtomic);
  const remaining = dailyBudget > spent ? dailyBudget - spent : 0n;
  const { queue, rejected } = rankCandidates(verified, units, rules, remaining);
  const skipped: Rejection[] = [...rejected];
  if (queue.length === 0)
    return fail(
      "decide",
      `no verified worker fits buyer budget: ${skipped.map((item) => `${item.label} (${item.reason})`).join("; ")}`,
    );

  for (const [index, agent] of queue.entries()) {
    emit({
      kind: "decide",
      chosen: {
        label: agent.label,
        ensName: agent.ensName,
        priceAtomic: agent.price.amount.toString(),
        payTo: agent.payTo,
      },
      rationale: staticRationale(agent, queue.slice(index + 1)),
      rejected: [...skipped],
      timestamp: nowIso(),
    });

    let quote: WorkerQuote;
    try {
      quote = await deps.quote(config, agent.label, units);
      const ranked = { ...agent, totalAtomic: agent.price.amount * BigInt(units) };
      const mismatch = validateQuote(quote, ranked, units, rules);
      if (mismatch) throw new Error(mismatch);
    } catch (error) {
      const reason = `quote rejected before payment: ${error instanceof Error ? error.message : "invalid quote"}`;
      emit({ kind: "payment_failed", label: agent.label, error: reason, timestamp: nowIso() });
      skipped.push({ label: agent.label, reason });
      continue;
    }

    const amountAtomic = agent.price.amount * BigInt(units);
    let balance: bigint;
    try {
      balance = await deps.usdcBalance(config, config.buyerAccountId, agent.price.asset);
    } catch (error) {
      return fail(
        "payment-readiness",
        `could not verify buyer USDC balance: ${error instanceof Error ? error.message : "mirror lookup failed"}`,
      );
    }
    const readiness = paymentReadinessError(balance, amountAtomic);
    if (readiness) return fail("payment-readiness", readiness);

    emit({
      kind: "quote",
      label: agent.label,
      units,
      amount: quote.amount,
      asset: quote.asset,
      payTo: quote.payTo,
      timestamp: nowIso(),
    });
    const expectation = {
      buyerAccountId: config.buyerAccountId,
      payTo: agent.payTo,
      asset: agent.price.asset,
      network: agent.price.network,
      amountAtomic,
    };

    let paidFetch: typeof fetch;
    try {
      paidFetch = deps.createPaymentFetch(config, rules, expectation);
    } catch (error) {
      return fail(
        "payment-prepare",
        `payment could not be prepared: ${error instanceof Error ? error.message : "invalid buyer signer"}`,
      );
    }

    let execution: PaidJobResponse;
    try {
      execution = await deps.execute(
        config,
        agent,
        file,
        basename(task.file),
        units,
        quote.signedQuote,
        paidFetch,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : "paid request outcome is unknown";
      preserveLock();
      let accountingError: string | undefined;
      try {
        deps.recordSpend(amountAtomic, false);
      } catch (spendError) {
        accountingError = spendError instanceof Error ? spendError.message : "write failed";
      }
      return fail(
        "payment-outcome-unknown",
        `${reason}; the request may have been paid. No retry was attempted. Resolve the transaction before clearing the buyer lock.${accountingError ? ` Spend accounting also failed: ${accountingError}.` : ""}`,
        {
          paymentState: "unknown",
          chosenAgent: agent.ensName,
        },
      );
    }

    if (execution.kind === "refused") {
      emit({
        kind: "refused",
        label: agent.label,
        status: execution.status,
        reason: execution.reason,
        timestamp: nowIso(),
      });
      skipped.push({ label: agent.label, reason: `pre-payment refusal (${execution.reason})` });
      continue;
    }

    if (execution.kind === "submitted-unverified") {
      preserveLock();
      let accountingError: string | undefined;
      try {
        deps.recordSpend(amountAtomic, false);
      } catch (spendError) {
        accountingError = spendError instanceof Error ? spendError.message : "write failed";
      }
      let payment: PaymentVerification | undefined;
      let paymentVerificationError: string | undefined;
      if (execution.transactionId) {
        try {
          payment = await deps.verifyPayment(config, {
            ...expectation,
            transactionId: execution.transactionId,
          });
        } catch (error) {
          payment = undefined;
          paymentVerificationError =
            error instanceof Error ? error.message : "Hedera Mirror verification failed";
        }
      }
      if (payment?.verified) {
        const url = execution.transactionId ? hashscanTxUrl(execution.transactionId) : null;
        if (url) {
          emit({
            kind: "paid",
            label: agent.label,
            txId: execution.transactionId!,
            hashscanUrl: url,
            amount: amountAtomic.toString(),
            timestamp: nowIso(),
          });
        }
      }
      const failedTxUrl = execution.transactionId ? hashscanTxUrl(execution.transactionId) : null;
      const details = [
        execution.reason,
        ...(paymentVerificationError
          ? [`independent payment verification failed: ${paymentVerificationError}`]
          : []),
        ...(accountingError ? [`spend accounting failed: ${accountingError}`] : []),
      ].join("; ");
      return fail("execution-verification", details, {
        paymentState: payment?.verified ? "confirmed" : "unverified",
        paymentConfirmed: payment?.verified ?? false,
        chosenAgent: agent.ensName,
        ...(execution.transactionId ? { txId: execution.transactionId } : {}),
        ...(failedTxUrl ? { hashscanUrl: failedTxUrl } : {}),
      });
    }

    const hashscanUrl = hashscanTxUrl(execution.transactionId);
    try {
      deps.recordSpend(amountAtomic, false);
    } catch (error) {
      preserveLock();
      return fail(
        "spending-state",
        `payment may have settled but buyer spend state could not be saved: ${error instanceof Error ? error.message : "write failed"}`,
        {
          jobCompleted: true,
          jobVerified: false,
          jobId: execution.jobId,
          paymentState: "submitted",
          chosenAgent: agent.ensName,
          txId: execution.transactionId,
          ...(hashscanUrl ? { hashscanUrl } : {}),
          output: execution.output,
          ...(execution.zgRequestId ? { zgRequestId: execution.zgRequestId } : {}),
        },
      );
    }
    const verification = await deps
      .verifySettlement(config, {
        jobId: execution.jobId,
        agent,
        amountAtomic,
        transactionId: execution.transactionId,
        outputSha256: execution.outputSha256,
        statusToken: execution.statusToken,
        network: agent.price.network,
        units,
        buyerAccountId: config.buyerAccountId,
        asset: agent.price.asset,
      })
      .catch((error): SettlementReport => ({
        job: {
          verified: false,
          status: "unverified",
          reason: error instanceof Error ? error.message : "job verification failed",
        },
        payment: {
          verified: false,
          transactionId: execution.transactionId,
          reason: error instanceof Error ? error.message : "payment verification failed",
        },
        hcs: { status: config.hcsTopicId ? "unverified" : "not-configured" },
      }));

    if (verification.payment.verified) {
      if (hashscanUrl) {
        emit({
          kind: "paid",
          label: agent.label,
          txId: execution.transactionId,
          hashscanUrl,
          amount: amountAtomic.toString(),
          timestamp: nowIso(),
        });
      }
    } else {
      preserveLock();
      emit({
        kind: "payment_failed",
        label: agent.label,
        error: `payment submitted but not independently verified: ${verification.payment.reason ?? "unknown mirror-node result"}`,
        timestamp: nowIso(),
      });
    }
    emit({
      kind: "result",
      label: agent.label,
      text: execution.output,
      jobId: execution.jobId,
      ...(execution.zgRequestId ? { zgRequestId: execution.zgRequestId } : {}),
      latencyMs: execution.latencyMs,
      timestamp: nowIso(),
    });

    if (verification.job.verified && verification.payment.verified) {
      try {
        deps.recordCompletedJob();
      } catch (error) {
        return fail(
          "spending-state",
          `job and payment verified, but completion state could not be saved: ${error instanceof Error ? error.message : "write failed"}`,
          {
            jobCompleted: true,
            jobVerified: verification.job.verified,
            jobId: execution.jobId,
            paymentState: "confirmed",
            paymentConfirmed: true,
            settlementVerified: false,
            verification,
            chosenAgent: agent.ensName,
            output: execution.output,
            ...(execution.zgRequestId ? { zgRequestId: execution.zgRequestId } : {}),
            txId: execution.transactionId,
            ...(hashscanUrl ? { hashscanUrl } : {}),
          },
        );
      }
    }
    const settlementVerified =
      verification.payment.verified &&
      verification.job.verified &&
      verification.hcs.status !== "unverified";
    const success = settlementVerified;
    if (!success) {
      preserveLock();
      const reason =
        verification.payment.reason ??
        verification.job.reason ??
        verification.hcs.reason ??
        "job, payment, or settlement could not be independently verified";
      return fail("settlement-verification", reason, {
        jobCompleted: true,
        jobVerified: verification.job.verified,
        jobId: execution.jobId,
        paymentState: verification.payment.verified ? "confirmed" : "unverified",
        paymentConfirmed: verification.payment.verified,
        settlementVerified: false,
        verification,
        chosenAgent: agent.ensName,
        output: execution.output,
        ...(execution.zgRequestId ? { zgRequestId: execution.zgRequestId } : {}),
        txId: execution.transactionId,
        ...(hashscanUrl ? { hashscanUrl } : {}),
      });
    }
    return {
      success: true,
      jobCompleted: true,
      jobVerified: true,
      jobId: execution.jobId,
      paymentState: "confirmed",
      paymentConfirmed: true,
      settlementVerified: true,
      verification,
      chosenAgent: agent.ensName,
      output: execution.output,
      ...(execution.zgRequestId ? { zgRequestId: execution.zgRequestId } : {}),
      txId: execution.transactionId,
      ...(hashscanUrl ? { hashscanUrl } : {}),
    };
  }
  return fail(
    "execute",
    `all ${queue.length} candidates refused or failed before payment: ${skipped.map((item) => `${item.label} (${item.reason})`).join("; ")}`,
  );
}

export { hashscanTxUrl };
