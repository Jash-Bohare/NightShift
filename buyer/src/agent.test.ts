import { existsSync, mkdtempSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BuyerRules } from "@nightshift/shared";
import { DEFAULT_SAMPLE_FILE, type BuyerConfig } from "./config.js";
import { runBuyer, type BuyerDependencies } from "./agent.js";
import type { RankedAgent } from "./decide.js";
import type { WorkerQuote } from "./quote.js";
import { testPublicKey } from "./test-crypto.js";

const resolver = "0x1111111111111111111111111111111111111111" as const;
const owner = "0x2222222222222222222222222222222222222222" as const;
const config: BuyerConfig = {
  serverUrl: "http://localhost:8787",
  buyerAccountId: "0.0.100",
  buyerPrivateKey: "1".repeat(64),
  quoteVerifyPublicKey: testPublicKey,
  sepoliaRpcUrl: "http://localhost:8545",
  registrarAddress: resolver,
  userRegistryAddress: owner,
  mirrorUrl: "http://localhost:5551",
};
const rules: BuyerRules = {
  maxPerJobAtomic: "100000",
  dailyBudgetAtomic: "1000000",
  allowedAssets: ["0.0.429274"],
  allowedNetworks: ["hedera:testnet"],
  allowParentNames: ["nightshift.eth"],
  minSuccess: 0.9,
  humanApprovalAboveAtomic: "500000",
};
const agent: RankedAgent = {
  label: "worker",
  ensName: "worker.nightshift.eth",
  owner,
  resolver,
  expiry: "2000000000",
  skill: "transcribe:ta",
  price: { amount: 30_000n, asset: "0.0.429274", network: "hedera:testnet", unit: "minute" },
  payTo: "0.0.200",
  endpoint: "http://localhost:8787/a/worker/run",
  reputation: { jobs: 1, success: 1, p50_ms: 10 },
  totalAtomic: 30_000n,
};
const quote: WorkerQuote = {
  amount: "30000",
  asset: "0.0.429274",
  network: "hedera:testnet",
  payTo: "0.0.200",
  unit: "minute",
  units: 1,
  status: "active",
  receivedAt: Date.now(),
  issuedAt: Date.now(),
  expiresAt: Date.now() + 30_000,
  expirySource: "server-signed",
  nonce: "07e6b328-9630-4bdb-b52a-2908519b0a7d",
  signedQuote: "signed-quote",
  ensName: "worker.nightshift.eth",
};
const settlement = {
  payment: { verified: true, transactionId: "0.0.100@123456789.000000001" },
  job: { verified: true, status: "verified" as const },
  hcs: { status: "not-configured" as const },
};
const transactionId = "0.0.100@123456789.000000001";
const jobId = "50baf702-1284-4d60-8ce6-39b905598d98";

let tempDirectory = "";
let lockPath = "";
afterEach(() => {
  if (lockPath && existsSync(lockPath)) unlinkSync(lockPath);
  if (tempDirectory && existsSync(tempDirectory)) rmdirSync(tempDirectory);
  tempDirectory = "";
  lockPath = "";
});

function createLockPath(): string {
  tempDirectory = mkdtempSync(join(tmpdir(), "nightshift-buyer-agent-"));
  lockPath = join(tempDirectory, "run.lock");
  return lockPath;
}

function dependencies(overrides: Partial<BuyerDependencies> = {}): BuyerDependencies {
  return {
    measureMinutes: async () => 1,
    discover: async () => [
      {
        label: agent.label,
        ensName: agent.ensName,
        owner,
        resolver,
        skill: agent.skill,
        price: { amount: "30000" },
        reputation: agent.reputation,
        status: "active",
      },
    ],
    verify: async () => [agent],
    quote: async () => quote,
    usdcBalance: async () => 100_000n,
    createPaymentFetch: () => fetch,
    execute: async () => ({
      kind: "response",
      jobId,
      output: "verified result",
      transactionId,
      outputSha256: "a".repeat(64),
      statusToken: "status-token",
      latencyMs: 1,
    }),
    verifyPayment: async () => ({ verified: true, transactionId }),
    verifySettlement: async () => settlement,
    dailySpentAtomic: () => 0n,
    recordSpend: () => {},
    recordCompletedJob: () => {},
    ...overrides,
  };
}

describe("buyer orchestration", () => {
  it("reports a completed job only after payment and settlement verification", async () => {
    const result = await runBuyer(
      { skill: "transcribe:ta", file: DEFAULT_SAMPLE_FILE },
      {
        rules,
        config,
        executionLockPath: createLockPath(),
        dependencies: dependencies(),
      },
    );
    expect(result).toMatchObject({
      success: true,
      jobCompleted: true,
      jobVerified: true,
      paymentState: "confirmed",
      paymentConfirmed: true,
      settlementVerified: true,
      output: "verified result",
    });
  });

  it("does not execute when the buyer balance is insufficient", async () => {
    const execute = vi.fn<BuyerDependencies["execute"]>();
    const result = await runBuyer(
      { skill: "transcribe:ta", file: DEFAULT_SAMPLE_FILE },
      {
        rules,
        config,
        executionLockPath: createLockPath(),
        dependencies: dependencies({ usdcBalance: async () => 0n, execute }),
      },
    );
    expect(result).toMatchObject({ success: false, paymentState: "not-submitted" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not retry after an uncertain paid request and retains the lock", async () => {
    const execute = vi.fn<BuyerDependencies["execute"]>().mockRejectedValue(new Error("timeout"));
    const path = createLockPath();
    const options = {
      rules,
      config,
      executionLockPath: path,
      dependencies: dependencies({ execute }),
    };
    const first = await runBuyer({ skill: "transcribe:ta", file: DEFAULT_SAMPLE_FILE }, options);
    expect(first).toMatchObject({ success: false, paymentState: "unknown" });
    expect(first.error).toMatch(/No retry was attempted/);
    const second = await runBuyer({ skill: "transcribe:ta", file: DEFAULT_SAMPLE_FILE }, options);
    expect(second.error).toMatch(/lock exists/);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not fall through to another worker after an unresolved payment response", async () => {
    const secondAgent: RankedAgent = {
      ...agent,
      label: "second",
      ensName: "second.nightshift.eth",
      endpoint: "http://localhost:8787/a/second/run",
      price: { ...agent.price, amount: 60_000n },
      totalAtomic: 60_000n,
    };
    const execute = vi
      .fn<BuyerDependencies["execute"]>()
      .mockResolvedValue({ kind: "submitted-unverified", reason: "missing settlement receipt" });
    const result = await runBuyer(
      { skill: "transcribe:ta", file: DEFAULT_SAMPLE_FILE },
      {
        rules,
        config,
        executionLockPath: createLockPath(),
        dependencies: dependencies({
          verify: async () => [agent, secondAgent],
          execute,
        }),
      },
    );
    expect(result).toMatchObject({ success: false, paymentState: "unverified" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1].label).toBe("worker");
  });

  it("returns an explicit unverified result when settlement cannot be confirmed", async () => {
    const result = await runBuyer(
      { skill: "transcribe:ta", file: DEFAULT_SAMPLE_FILE },
      {
        rules,
        config,
        executionLockPath: createLockPath(),
        dependencies: dependencies({
          verifySettlement: async () => ({
            payment: { verified: false, transactionId, reason: "mirror unavailable" },
            job: { verified: false, status: "unverified", reason: "job not found" },
            hcs: { status: "not-configured" },
          }),
        }),
      },
    );
    expect(result).toMatchObject({
      success: false,
      jobCompleted: true,
      jobVerified: false,
      paymentState: "unverified",
      settlementVerified: false,
    });
  });
});
