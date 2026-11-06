import { z } from "zod";
import type { BuyerPublicConfig } from "./config.js";
import type { VerifiedAgent } from "./decide.js";
import { HederaMirrorClient, type PaymentVerification } from "./hedera.js";
import { verifyJobStatusToken } from "./quote-signature.js";

const IntegerString = z.union([z.string().regex(/^\d+$/), z.number().int().safe().nonnegative()]);
const PublicJob = z.object({
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
  price_atomic: IntegerString,
  hedera_tx_id: z.string().nullable(),
  hcs_sequence: IntegerString.nullable(),
  output_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  asset: z.string(),
  network: z.string(),
  agent: z.object({ label: z.string(), ensName: z.string() }),
});
const HcsJob = z.object({
  v: z.literal(1),
  type: z.literal("job"),
  agent: z.string(),
  job: z.string().uuid(),
  units: z.number().int().positive(),
  amount: z.string().regex(/^\d+$/),
  asset: z.string(),
  payer: z.string().regex(/^0\.0\.\d+$/),
  tx: z.string(),
  output_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  ts: z.string().datetime({ offset: true }),
});

export interface JobVerification {
  verified: boolean;
  status: "verified" | "unverified";
  reason?: string;
  hcsSequence?: string;
}

export interface HcsVerification {
  status: "verified" | "unverified" | "not-configured" | "not-available";
  sequence?: string;
  reason?: string;
}

export interface SettlementReport {
  job: JobVerification;
  payment: PaymentVerification;
  hcs: HcsVerification;
}

function integerString(value: string | number): string {
  return String(value);
}

export async function verifyPublicJob(
  config: BuyerPublicConfig,
  expected: {
    jobId: string;
    agent: VerifiedAgent;
    amountAtomic: bigint;
    transactionId: string;
    outputSha256: string;
    statusToken: string;
    units: number;
  },
  options: {
    fetcher?: typeof fetch;
    attempts?: number;
    pause?: (ms: number) => Promise<void>;
  } = {},
): Promise<{ job: JobVerification; hcsSequence: string | null }> {
  try {
    verifyJobStatusToken(expected.statusToken, config.quoteVerifyPublicKey, expected.jobId);
  } catch {
    return {
      job: { verified: false, status: "unverified", reason: "job status capability is invalid" },
      hcsSequence: null,
    };
  }
  const fetcher = options.fetcher ?? fetch;
  const pause = options.pause ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const attempts = options.attempts ?? 8;
  const url = new URL(`/jobs/${encodeURIComponent(expected.jobId)}/status`, config.serverUrl);
  let lastReason = "job status endpoint did not return a job record";
  for (let attempt = 0; attempt < attempts; attempt++) {
    const response = await fetcher(url, {
      headers: { Authorization: `Bearer ${expected.statusToken}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      lastReason = `job status lookup returned HTTP ${response.status}`;
      if (response.status !== 404 && response.status < 500) break;
    } else {
      const parsed = PublicJob.safeParse(await response.json());
      if (!parsed.success) {
        lastReason = "job status lookup returned a malformed record";
      } else {
        const row = parsed.data;
        const validIdentity =
          row.id === expected.jobId &&
          row.agent.label === expected.agent.label &&
          row.agent.ensName === expected.agent.ensName;
        const validPayment =
          BigInt(integerString(row.price_atomic)) === expected.amountAtomic &&
          row.hedera_tx_id === expected.transactionId;
        const validOutput = row.output_sha256 === expected.outputSha256;
        if (
          row.status === "settled" &&
          validIdentity &&
          validPayment &&
          validOutput &&
          Number(row.units) === expected.units &&
          row.asset === expected.agent.price.asset &&
          row.network === expected.agent.price.network
        ) {
          return {
            job: { verified: true, status: "verified" },
            hcsSequence: row.hcs_sequence === null ? null : integerString(row.hcs_sequence),
          };
        }
        lastReason = !validIdentity
          ? "job record worker identity does not match the verified ENS worker"
          : !validPayment
            ? "job record payment does not match the verified transaction and quote"
            : !validOutput
              ? "job output digest does not match the response"
              : Number(row.units) !== expected.units
                ? "job units do not match the requested execution"
                : row.status !== "settled"
                  ? `job record status is ${row.status}, not settled`
                  : "job record payment asset or network does not match";
      }
    }
    if (attempt + 1 < attempts) await pause(1_000 * (attempt + 1));
  }
  return {
    job: { verified: false, status: "unverified", reason: lastReason },
    hcsSequence: null,
  };
}

export async function verifyHcsJob(
  config: BuyerPublicConfig,
  sequence: string | null,
  expected: {
    jobId: string;
    agent: VerifiedAgent;
    units: number;
    amountAtomic: bigint;
    transactionId: string;
    buyerAccountId: string;
    asset: string;
    outputSha256: string;
  },
  options: { fetcher?: typeof fetch } = {},
): Promise<HcsVerification> {
  if (!config.hcsTopicId) return { status: "not-configured" };
  if (!sequence) return { status: "not-available", reason: "job record has no HCS sequence" };
  if (!/^\d+$/.test(sequence))
    return { status: "unverified", reason: "job record HCS sequence is invalid" };
  const url = `${config.mirrorUrl}/api/v1/topics/${encodeURIComponent(config.hcsTopicId)}/messages/${sequence}`;
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(url, { signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    // A Mirror Node outage must not discard the payment and job verification results.
    return {
      status: "unverified",
      sequence,
      reason: `HCS mirror lookup failed: ${error instanceof Error ? error.message : "network error"}`,
    };
  }
  if (!response.ok)
    return {
      status: "unverified",
      sequence,
      reason: `HCS mirror lookup returned HTTP ${response.status}`,
    };
  const message: unknown = await response.json();
  const base64 = z.object({ message: z.string() }).safeParse(message);
  if (!base64.success)
    return { status: "unverified", sequence, reason: "HCS response is malformed" };
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(base64.data.message, "base64").toString("utf8"));
  } catch {
    return { status: "unverified", sequence, reason: "HCS message is not valid JSON" };
  }
  const parsed = HcsJob.safeParse(decoded);
  if (!parsed.success)
    return { status: "unverified", sequence, reason: "HCS message is not a valid job log" };
  const log = parsed.data;
  const matches =
    log.job === expected.jobId &&
    log.agent === expected.agent.ensName &&
    log.units === expected.units &&
    log.amount === expected.amountAtomic.toString() &&
    log.asset === expected.asset &&
    log.payer === expected.buyerAccountId &&
    log.tx === expected.transactionId &&
    log.output_sha256 === expected.outputSha256;
  return matches
    ? { status: "verified", sequence }
    : {
        status: "unverified",
        sequence,
        reason: "HCS job log fields do not match the job, output digest, and settlement",
      };
}

export async function verifySettlement(
  config: BuyerPublicConfig,
  expected: {
    jobId: string;
    agent: VerifiedAgent;
    amountAtomic: bigint;
    transactionId: string;
    outputSha256: string;
    statusToken: string;
    network: string;
    units: number;
    buyerAccountId: string;
    asset: string;
  },
  options: {
    fetcher?: typeof fetch;
    mirror?: HederaMirrorClient;
    jobAttempts?: number;
    pause?: (ms: number) => Promise<void>;
  } = {},
): Promise<SettlementReport> {
  const mirror = options.mirror ?? new HederaMirrorClient(config.mirrorUrl, options.fetcher);
  const [paymentResult, jobResult] = await Promise.allSettled([
    mirror.verifyPayment({
      transactionId: expected.transactionId,
      buyerAccountId: expected.buyerAccountId,
      payTo: expected.agent.payTo,
      asset: expected.asset,
      network: expected.network,
      amountAtomic: expected.amountAtomic,
    }),
    verifyPublicJob(config, expected, {
      fetcher: options.fetcher,
      attempts: options.jobAttempts,
      pause: options.pause,
    }),
  ]);
  const payment =
    paymentResult.status === "fulfilled"
      ? paymentResult.value
      : {
          verified: false,
          transactionId: expected.transactionId,
          reason:
            paymentResult.reason instanceof Error
              ? paymentResult.reason.message
              : "Hedera payment verification failed",
        };
  const { job, hcsSequence } =
    jobResult.status === "fulfilled"
      ? jobResult.value
      : {
          job: {
            verified: false,
            status: "unverified" as const,
            reason:
              jobResult.reason instanceof Error
                ? jobResult.reason.message
                : "job status verification failed",
          },
          hcsSequence: null,
        };
  const hcs = job.verified
    ? await verifyHcsJob(config, hcsSequence, expected, { fetcher: options.fetcher })
    : {
        status: config.hcsTopicId ? ("unverified" as const) : ("not-configured" as const),
        reason: job.reason,
      };
  return { job, payment, hcs };
}
