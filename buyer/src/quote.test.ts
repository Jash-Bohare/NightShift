import { describe, expect, it, vi } from "vitest";
import type { BuyerRules } from "@nightshift/shared";
import type { BuyerConfig } from "./config.js";
import { validateQuote, fetchWorkerQuote } from "./quote.js";
import type { RankedAgent } from "./decide.js";
import { signedQuoteToken, testPublicKey } from "./test-crypto.js";

const config = {
  serverUrl: "https://nightshift.example",
  quoteVerifyPublicKey: testPublicKey,
} as BuyerConfig;
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
  owner: "0x1111111111111111111111111111111111111111",
  resolver: "0x2222222222222222222222222222222222222222",
  expiry: "2000000000",
  skill: "transcribe:ta",
  price: { amount: 30_000n, asset: "0.0.429274", network: "hedera:testnet", unit: "minute" },
  payTo: "0.0.100",
  endpoint: "https://nightshift.example/a/worker/run",
  reputation: { jobs: 3, success: 1, p50_ms: 100 },
  totalAtomic: 60_000n,
};
const response = {
  amount: "60000",
  asset: "0.0.429274",
  network: "hedera:testnet",
  payTo: "0.0.100",
  unit: "minute",
  units: 2,
  status: "active",
  issuedAt: "1970-01-01T00:00:01.000Z",
  expiresAt: "1970-01-01T00:00:31.000Z",
  nonce: "07e6b328-9630-4bdb-b52a-2908519b0a7d",
  signedQuote: signedQuoteToken({ iat: 1, exp: 31 }),
};

describe("worker quotes", () => {
  it("retrieves and verifies a server-signed expiring quote", async () => {
    const quote = await fetchWorkerQuote(config, "worker", 2, {
      now: () => 1_000,
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(response))),
    });
    expect(quote.expirySource).toBe("server-signed");
    expect(quote.expiresAt).toBe(31_000);
    expect(validateQuote(quote, agent, 2, rules, 1_001)).toBeNull();
  });

  it("rejects expired, future-issued, and mismatched quotes", async () => {
    const quote = await fetchWorkerQuote(config, "worker", 2, {
      now: () => 1_000,
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(response))),
    });
    expect(validateQuote(quote, agent, 2, rules, 32_000)).toMatch(/expired/);
    expect(validateQuote({ ...quote, issuedAt: 40_000 }, agent, 2, rules, 1_001)).toMatch(
      /issue time/,
    );
    expect(
      validateQuote({ ...quote, amount: "60001", expiresAt: 40_000 }, agent, 2, rules, 1_001),
    ).toMatch(/quote 60001/);
  });

  it("rejects malformed or unavailable API responses", async () => {
    const invalidSignature = `${response.signedQuote.slice(0, -1)}${response.signedQuote.endsWith("A") ? "B" : "A"}`;
    await expect(
      fetchWorkerQuote(config, "worker", 2, {
        fetcher: vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            new Response(JSON.stringify({ ...response, signedQuote: invalidSignature })),
          ),
      }),
    ).rejects.toThrow(/encoding|signature/);
    await expect(
      fetchWorkerQuote(config, "worker", 2, {
        fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 200 })),
      }),
    ).rejects.toThrow(/malformed/);
    await expect(
      fetchWorkerQuote(config, "worker", 2, {
        fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 503 })),
      }),
    ).rejects.toThrow(/HTTP 503/);
  });
});
