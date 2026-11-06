import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  policy: undefined as
    | ((version: number, requirements: Record<string, unknown>[]) => Record<string, unknown>[])
    | undefined,
}));

vi.mock("@x402/fetch", () => ({
  x402Client: class {
    register() {
      return this;
    }
    setSpendControls() {
      return this;
    }
    registerPolicy(
      policy: (
        version: number,
        requirements: Record<string, unknown>[],
      ) => Record<string, unknown>[],
    ) {
      mocks.policy = policy;
      return this;
    }
  },
  wrapFetchWithPayment:
    (fetcher: typeof fetch) => async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const challenge = await fetcher(input, init);
      if (challenge.status !== 402) return challenge;
      const accepted = mocks.policy?.(2, [
        {
          scheme: "exact",
          network: "hedera:testnet",
          asset: "0.0.429274",
          amount: "30000",
          payTo: "0.0.200",
        },
        {
          scheme: "exact",
          network: "hedera:testnet",
          asset: "0.0.429274",
          amount: "30001",
          payTo: "0.0.200",
        },
      ]);
      if (accepted?.length !== 1) return challenge;
      const headers = new Headers(init?.headers);
      headers.set("PAYMENT-SIGNATURE", "mock-only-no-transaction");
      return fetcher(input, { ...init, headers });
    },
}));
vi.mock("@x402/hedera", () => ({
  createClientHederaSigner: vi.fn(),
  PrivateKey: { fromStringECDSA: vi.fn(() => ({})) },
}));
vi.mock("@x402/hedera/exact/client", () => ({
  ExactHederaScheme: class {},
}));

import type { BuyerRules } from "@nightshift/shared";
import type { BuyerConfig } from "./config.js";
import { createX402Fetch } from "./payment.js";

const rules: BuyerRules = {
  maxPerJobAtomic: "100000",
  dailyBudgetAtomic: "1000000",
  allowedAssets: ["0.0.429274"],
  allowedNetworks: ["hedera:testnet"],
  allowParentNames: ["nightshift.eth"],
  minSuccess: 0.9,
  humanApprovalAboveAtomic: "500000",
};
const config = {
  buyerAccountId: "0.0.100",
  buyerPrivateKey: "1".repeat(64),
} as BuyerConfig;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mocked x402 challenge and retry", () => {
  it("retries only the exact quoted payment and preserves the signed quote header", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("payment required", { status: 402 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const paidFetch = createX402Fetch(config, rules, {
      buyerAccountId: "0.0.100",
      payTo: "0.0.200",
      asset: "0.0.429274",
      network: "hedera:testnet",
      amountAtomic: 30_000n,
    });
    const response = await paidFetch("https://nightshift.example/a/worker/run", {
      method: "POST",
      headers: { "X-Nightshift-Quote": "signed-quote-for-test" },
      body: "mock file",
    });
    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const retriedHeaders = new Headers(fetcher.mock.calls[1]?.[1]?.headers);
    expect(retriedHeaders.get("X-Nightshift-Quote")).toBe("signed-quote-for-test");
    expect(retriedHeaders.get("PAYMENT-SIGNATURE")).toBe("mock-only-no-transaction");
  });
});
