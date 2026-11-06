import { describe, expect, it, vi } from "vitest";
import type { BuyerConfig } from "./config.js";
import type { VerifiedAgent } from "./decide.js";
import { verifyHcsJob, verifyPublicJob } from "./settlement.js";
import { jobStatusToken, testPublicKey } from "./test-crypto.js";

const jobId = "50baf702-1284-4d60-8ce6-39b905598d98";
const transactionId = "0.0.100@123456789.000000001";
const agent: VerifiedAgent = {
  label: "worker",
  ensName: "worker.nightshift.eth",
  owner: "0x1111111111111111111111111111111111111111",
  resolver: "0x2222222222222222222222222222222222222222",
  expiry: "2000000000",
  skill: "transcribe:ta",
  price: { amount: 30_000n, asset: "0.0.429274", network: "hedera:testnet", unit: "minute" },
  payTo: "0.0.200",
  endpoint: "https://nightshift.example/a/worker/run",
  reputation: { jobs: 1, success: 1, p50_ms: 10 },
};
const config = {
  serverUrl: "https://nightshift.example",
  quoteVerifyPublicKey: testPublicKey,
  mirrorUrl: "https://mirror.example",
  hcsTopicId: "0.0.500",
} as BuyerConfig;
const job = {
  id: jobId,
  status: "settled",
  units: 1,
  price_atomic: "30000",
  hedera_tx_id: transactionId,
  hcs_sequence: "19",
  output_sha256: "a".repeat(64),
  asset: "0.0.429274",
  network: "hedera:testnet",
  agent: { label: "worker", ensName: "worker.nightshift.eth" },
};
const expected = {
  jobId,
  agent,
  amountAtomic: 30_000n,
  transactionId,
  outputSha256: "a".repeat(64),
  statusToken: jobStatusToken(jobId),
  units: 1,
};

describe("independent job and HCS settlement verification", () => {
  it("verifies the settled public job identity, amount, and transaction", async () => {
    const result = await verifyPublicJob(config, expected, {
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(job))),
      pause: async () => {},
    });
    expect(result).toMatchObject({
      job: { verified: true, status: "verified" },
      hcsSequence: "19",
    });
  });

  it("rejects job rows with wrong identity, transaction, or status", async () => {
    const result = await verifyPublicJob(config, expected, {
      fetcher: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify({ ...job, hedera_tx_id: "different" }))),
      attempts: 1,
    });
    expect(result.job).toMatchObject({ verified: false, status: "unverified" });
  });

  it("rejects a job whose output digest or units differs from the execution response", async () => {
    const digestMismatch = await verifyPublicJob(config, expected, {
      fetcher: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify({ ...job, output_sha256: "b".repeat(64) }))),
      attempts: 1,
    });
    expect(digestMismatch.job.reason).toMatch(/digest/);
    const unitsMismatch = await verifyPublicJob(config, expected, {
      fetcher: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify({ ...job, units: 2 }))),
      attempts: 1,
    });
    expect(unitsMismatch.job.reason).toMatch(/units/);
  });

  it("checks the HCS message contents against the verified job", async () => {
    const log = {
      v: 1,
      type: "job",
      agent: agent.ensName,
      job: jobId,
      units: 1,
      amount: "30000",
      asset: "0.0.429274",
      payer: "0.0.100",
      tx: transactionId,
      output_sha256: "a".repeat(64),
      ts: "2029-01-01T00:00:00.000Z",
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ message: Buffer.from(JSON.stringify(log)).toString("base64") }),
        ),
      );
    const mismatchFetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ message: Buffer.from(JSON.stringify(log)).toString("base64") }),
        ),
      );
    await expect(
      verifyHcsJob(
        config,
        "19",
        {
          ...expected,
          units: 1,
          buyerAccountId: "0.0.100",
          asset: "0.0.429274",
          outputSha256: "a".repeat(64),
        },
        { fetcher: mismatchFetcher },
      ),
    ).resolves.toMatchObject({ status: "verified", sequence: "19" });

    await expect(
      verifyHcsJob(
        config,
        "19",
        {
          ...expected,
          units: 2,
          buyerAccountId: "0.0.100",
          asset: "0.0.429274",
          outputSha256: "a".repeat(64),
        },
        { fetcher },
      ),
    ).resolves.toMatchObject({ status: "unverified" });
  });
});
