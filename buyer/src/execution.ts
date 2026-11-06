import { createHash } from "node:crypto";
import { z } from "zod";
import type { BuyerConfig } from "./config.js";
import type { VerifiedAgent } from "./decide.js";
import { readPaymentResponse } from "./payment.js";
import { verifyJobStatusToken } from "./quote-signature.js";

const JobResponse = z.object({
  job_id: z.string().uuid(),
  output: z.string().min(1),
  output_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  status_token: z.string().min(1),
  zg: z
    .object({
      request_id: z.string().min(1).optional(),
      provider: z.string().optional(),
    })
    .optional(),
});

export type PaidJobResponse =
  | { kind: "refused"; status: number; reason: string }
  | { kind: "submitted-unverified"; transactionId?: string; reason: string }
  | {
      kind: "response";
      jobId: string;
      output: string;
      zgRequestId?: string;
      transactionId: string;
      outputSha256: string;
      statusToken: string;
      latencyMs: number;
    };

/**
 * The x402 reason carried in a 402's PAYMENT-REQUIRED header (base64 JSON with an `error`
 * field), e.g. the facilitator's invalid reason. Empty when absent or unreadable.
 */
export function paymentRejection(response: Pick<Response, "status" | "headers">): string {
  if (response.status !== 402) return "";
  const header = response.headers.get("payment-required");
  if (!header) return "";
  try {
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
      error?: unknown;
    };
    return typeof decoded.error === "string" && decoded.error
      ? ` (payment rejected: ${decoded.error.slice(0, 200)})`
      : "";
  } catch {
    return "";
  }
}

export async function executePaidJob(
  config: BuyerConfig,
  agent: VerifiedAgent,
  fileBuffer: Buffer,
  fileName: string,
  units: number,
  signedQuote: string,
  paidFetch: typeof fetch,
): Promise<PaidJobResponse> {
  const body = new FormData();
  body.append("file", new Blob([new Uint8Array(fileBuffer)], { type: "audio/mpeg" }), fileName);
  const started = performance.now();
  const response = await paidFetch(agent.endpoint, {
    method: "POST",
    headers: {
      "X-Nightshift-Units": String(units),
      "X-Nightshift-Quote": signedQuote,
    },
    body,
    signal: AbortSignal.timeout(180_000),
  });
  const text = await response.text();
  if (response.status === 503) {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return {
        kind: "submitted-unverified",
        reason: `HTTP 503 returned a malformed refusal: ${text.slice(0, 200)}`,
      };
    }
    if (
      typeof data === "object" &&
      data !== null &&
      "error" in data &&
      (data.error === "over_budget" || data.error === "no_credits")
    ) {
      const message = "message" in data && typeof data.message === "string" ? data.message : "";
      return {
        kind: "refused",
        status: response.status,
        reason: `${data.error}: ${message}`.trim(),
      };
    }
    return {
      kind: "submitted-unverified",
      reason: `HTTP 503 did not match a known pre-payment refusal: ${text.slice(0, 200)}`,
    };
  }
  if (!response.ok)
    return {
      kind: "submitted-unverified",
      reason: `paid job returned HTTP ${response.status}${paymentRejection(response)}: ${text.slice(0, 200)}`,
    };

  const header = response.headers.get("PAYMENT-RESPONSE");
  if (!header)
    return {
      kind: "submitted-unverified",
      reason: "job response is missing the x402 settlement receipt",
    };
  let payment: ReturnType<typeof readPaymentResponse>;
  try {
    payment = readPaymentResponse(header);
  } catch (error) {
    return {
      kind: "submitted-unverified",
      reason: error instanceof Error ? error.message : "x402 settlement receipt is invalid",
    };
  }
  if (!payment.success)
    return {
      kind: "submitted-unverified",
      transactionId: payment.transaction,
      reason: "x402 reports that payment settlement failed",
    };

  const transactionId = payment.transaction;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      kind: "submitted-unverified",
      transactionId,
      reason: "paid job returned malformed JSON after payment submission",
    };
  }
  const parsed = JobResponse.safeParse(raw);
  if (!parsed.success)
    return {
      kind: "submitted-unverified",
      transactionId,
      reason: "paid job response is missing a valid job id or result",
    };
  const outputSha256 = createHash("sha256").update(parsed.data.output, "utf8").digest("hex");
  if (outputSha256 !== parsed.data.output_sha256)
    return {
      kind: "submitted-unverified",
      transactionId,
      reason: "job output does not match the server's SHA-256 digest",
    };
  try {
    verifyJobStatusToken(parsed.data.status_token, config.quoteVerifyPublicKey, parsed.data.job_id);
  } catch {
    return {
      kind: "submitted-unverified",
      transactionId,
      reason: "job status capability is invalid or does not match the job",
    };
  }
  const headerJobId = response.headers.get("X-Nightshift-Job");
  if (headerJobId && headerJobId !== parsed.data.job_id)
    return {
      kind: "submitted-unverified",
      transactionId,
      reason: "job id in response body does not match the job header",
    };
  return {
    kind: "response",
    jobId: parsed.data.job_id,
    output: parsed.data.output,
    ...(parsed.data.zg?.request_id ? { zgRequestId: parsed.data.zg.request_id } : {}),
    transactionId,
    outputSha256,
    statusToken: parsed.data.status_token,
    latencyMs: Math.round(performance.now() - started),
  };
}
