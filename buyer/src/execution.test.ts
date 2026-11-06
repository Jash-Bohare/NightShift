import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { BuyerConfig } from "./config.js";
import type { VerifiedAgent } from "./decide.js";
import { executePaidJob } from "./execution.js";
import { readPaymentResponse } from "./payment.js";
import { jobStatusToken, testPublicKey } from "./test-crypto.js";

vi.mock("./payment.js", () => ({ readPaymentResponse: vi.fn() }));
const readReceipt = vi.mocked(readPaymentResponse);

const config = { quoteVerifyPublicKey: testPublicKey } as BuyerConfig;
const agent: VerifiedAgent = {
  label: "worker",
  ensName: "worker.nightshift.eth",
  owner: "0x1111111111111111111111111111111111111111",
  resolver: "0x2222222222222222222222222222222222222222",
  expiry: "2000000000",
  skill: "transcribe:ta",
  price: { amount: 30_000n, asset: "0.0.429274", network: "hedera:testnet", unit: "minute" },
  payTo: "0.0.100",
  endpoint: "https://nightshift.example/a/worker/run",
  reputation: { jobs: 1, success: 1, p50_ms: 10 },
};
const jobId = "50baf702-1284-4d60-8ce6-39b905598d98";

function paidFetch(response: Response): typeof fetch {
  return vi.fn<typeof fetch>().mockResolvedValue(response);
}

function paidJobBody(output = "Transcript", id = jobId) {
  return {
    job_id: id,
    output,
    output_sha256: createHash("sha256").update(output).digest("hex"),
    status_token: jobStatusToken(id),
  };
}

function execute(fetcher: typeof fetch) {
  return executePaidJob(
    config,
    agent,
    Buffer.from("audio"),
    "sample.mp3",
    1,
    "signed-quote",
    fetcher,
  );
}

describe("paid job request handling", () => {
  beforeEach(() => vi.resetAllMocks());

  it("accepts a validated job result and records the settlement receipt", async () => {
    readReceipt.mockReturnValue({ success: true, transaction: "0.0.100@123456789.000000001" });
    const fetcher = paidFetch(
      new Response(JSON.stringify(paidJobBody()), {
        headers: { "PAYMENT-RESPONSE": "receipt", "X-Nightshift-Job": jobId },
      }),
    );
    const result = await execute(fetcher);
    expect(result).toMatchObject({ kind: "response", jobId, output: "Transcript" });
    expect(vi.mocked(fetcher).mock.calls[0]?.[1]?.headers).toMatchObject({
      "X-Nightshift-Quote": "signed-quote",
    });
  });

  it("treats only known server 503 prechecks as explicit unpaid refusals", async () => {
    const result = await execute(
      paidFetch(new Response('{"error":"no_credits"}', { status: 503 })),
    );
    expect(result).toMatchObject({ kind: "refused", reason: expect.stringMatching(/no_credits/) });

    const overBudget = await execute(
      paidFetch(new Response('{"error":"over_budget"}', { status: 503 })),
    );
    expect(overBudget).toMatchObject({
      kind: "refused",
      reason: expect.stringMatching(/over_budget/),
    });

    const generic503 = await execute(
      paidFetch(new Response('{"error":"upstream_unavailable"}', { status: 503 })),
    );
    expect(generic503.kind).toBe("submitted-unverified");

    const malformed503 = await execute(
      paidFetch(new Response("service unavailable", { status: 503 })),
    );
    expect(malformed503.kind).toBe("submitted-unverified");
  });

  it("does not claim payment or completion for failed receipts and malformed jobs", async () => {
    readReceipt.mockReturnValue({ success: false, transaction: "0.0.100@123456789.000000001" });
    const rejected = await execute(
      paidFetch(
        new Response(JSON.stringify(paidJobBody("x")), {
          headers: { "PAYMENT-RESPONSE": "receipt" },
        }),
      ),
    );
    expect(rejected.kind).toBe("submitted-unverified");

    readReceipt.mockReturnValue({ success: true, transaction: "0.0.100@123456789.000000001" });
    const invalidJob = await execute(
      paidFetch(
        new Response(JSON.stringify(paidJobBody("", "bad")), {
          headers: { "PAYMENT-RESPONSE": "receipt" },
        }),
      ),
    );
    expect(invalidJob).toMatchObject({
      kind: "submitted-unverified",
      transactionId: expect.any(String),
    });
  });

  it("treats non-precheck errors, missing receipts, and mismatched ids as unresolved", async () => {
    const paymentRejected = await execute(
      vi.fn<typeof fetch>().mockRejectedValue(new Error("wallet rejected payment")),
    ).catch((error: unknown) => error);
    expect(paymentRejected).toMatchObject({ message: "wallet rejected payment" });

    const paymentChallenge = await execute(
      paidFetch(new Response("payment required", { status: 402 })),
    );
    expect(paymentChallenge.kind).toBe("submitted-unverified");

    const serverError = await execute(paidFetch(new Response("failure", { status: 500 })));
    expect(serverError.kind).toBe("submitted-unverified");

    readReceipt.mockReturnValue({ success: true, transaction: "0.0.100@123456789.000000001" });
    const mismatch = await execute(
      paidFetch(
        new Response(JSON.stringify(paidJobBody()), {
          headers: { "PAYMENT-RESPONSE": "receipt", "X-Nightshift-Job": "different" },
        }),
      ),
    );
    expect(mismatch.kind).toBe("submitted-unverified");
  });

  it("rejects output integrity mismatches before claiming a completed job", async () => {
    readReceipt.mockReturnValue({ success: true, transaction: "0.0.100@123456789.000000001" });
    const body = paidJobBody();
    body.output_sha256 = "b".repeat(64);
    const result = await execute(
      paidFetch(
        new Response(JSON.stringify(body), {
          headers: { "PAYMENT-RESPONSE": "receipt" },
        }),
      ),
    );
    expect(result).toMatchObject({
      kind: "submitted-unverified",
      reason: expect.stringMatching(/SHA-256/),
    });
  });
});

describe("paymentRejection", () => {
  it("reads the x402 reason from a 402 PAYMENT-REQUIRED header", async () => {
    const { paymentRejection } = await import("./execution.js");
    const header = Buffer.from(JSON.stringify({ error: "invalid_exact_hedera_payload" })).toString(
      "base64",
    );
    const headers = new Headers({ "payment-required": header });
    expect(paymentRejection({ status: 402, headers })).toBe(
      " (payment rejected: invalid_exact_hedera_payload)",
    );
    expect(paymentRejection({ status: 500, headers })).toBe("");
    expect(paymentRejection({ status: 402, headers: new Headers() })).toBe("");
    expect(
      paymentRejection({ status: 402, headers: new Headers({ "payment-required": "%%%" }) }),
    ).toBe("");
  });
});
