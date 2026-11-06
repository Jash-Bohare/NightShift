import { describe, expect, it } from "vitest";
import { classifySettlementFailure } from "./x402/server.js";
import { quoteMatchesWorker } from "./routes/run.js";
import { WindowCounter } from "./rate-limit.js";
import type { AgentRow } from "./db/types.js";
import type { QuoteClaims } from "./quote-signing.js";

const agent: AgentRow = {
  id: "10000000-0000-4000-8000-000000000001",
  owner_id: "00000000-0000-4000-8000-000000000001",
  label: "scribe",
  ens_name: "scribe.nightshift.eth",
  skill: "transcribe:ta",
  model: "m",
  price_atomic: "30000",
  price_unit: "minute",
  daily_cap_usd_micro: "500000",
  status: "active",
  hedera_account_id: "0.0.7",
  resolver_address: null,
  register_tx: null,
  expiry: null,
  created_at: "2030-01-01T00:00:00Z",
};
const quote: QuoteClaims = {
  v: 1,
  type: "nightshift-quote",
  agentId: agent.id,
  label: "scribe",
  ensName: "scribe.nightshift.eth",
  units: 2,
  amount: "60000",
  asset: "0.0.429274",
  network: "hedera:testnet",
  payTo: "0.0.7",
  unit: "minute",
  status: "paused_budget",
  iat: 1,
  exp: 2,
  nonce: "20000000-0000-4000-8000-000000000001",
};

describe("signed quote ↔ worker binding", () => {
  it("accepts a paused_budget quote for an active worker (and vice versa)", () => {
    expect(quoteMatchesWorker(quote, agent, 2, "0.0.429274")).toBe(true);
    expect(
      quoteMatchesWorker(
        { ...quote, status: "active" },
        { ...agent, status: "paused_budget" },
        2,
        "0.0.429274",
      ),
    ).toBe(true);
  });

  it("rejects any change to identity, units, price, asset, network, pay-to or unit", () => {
    const changed: Partial<QuoteClaims>[] = [
      { agentId: "10000000-0000-4000-8000-000000000009" },
      { label: "other" },
      { ensName: "other.nightshift.eth" },
      { units: 3 },
      { amount: "59999" },
      { asset: "0.0.1" },
      { network: "hedera:mainnet" },
      { payTo: "0.0.8" },
      { unit: "page" },
    ];
    for (const patch of changed)
      expect(quoteMatchesWorker({ ...quote, ...patch }, agent, 2, "0.0.429274")).toBe(false);
    expect(quoteMatchesWorker(quote, agent, 3, "0.0.429274")).toBe(false);
    expect(quoteMatchesWorker(quote, { ...agent, price_atomic: "30001" }, 2, "0.0.429274")).toBe(
      false,
    );
  });
});

describe("settlement failure classification", () => {
  const settleError = (transaction: string) =>
    Object.assign(new Error("insufficient_funds"), { name: "SettleError", transaction });

  it("treats a structured refusal without a transaction as definite", () => {
    expect(classifySettlementFailure(settleError(""))).toBe("definite");
  });

  it("treats pending transactions, timeouts, network and unknown errors as uncertain", () => {
    expect(classifySettlementFailure(settleError("0.0.1@1.2"))).toBe("uncertain");
    expect(
      classifySettlementFailure(Object.assign(new Error("t"), { name: "FacilitatorTimeoutError" })),
    ).toBe("uncertain");
    expect(classifySettlementFailure(new TypeError("fetch failed"))).toBe("uncertain");
    expect(classifySettlementFailure("weird")).toBe("uncertain");
  });
});

describe("fixed-window rate limiter", () => {
  it("allows the limit per window, then reports a wait, then resets", () => {
    let now = 0;
    const counter = new WindowCounter(2, 60_000, 10, () => now);
    expect(counter.hit("a")).toBe(0);
    expect(counter.hit("a")).toBe(0);
    expect(counter.hit("a")).toBe(60);
    expect(counter.hit("b")).toBe(0);
    now = 60_000;
    expect(counter.hit("a")).toBe(0);
  });

  it("refuses new clients once the key table is full of live windows", () => {
    const counter = new WindowCounter(5, 60_000, 1, () => 0);
    expect(counter.hit("a")).toBe(0);
    expect(counter.hit("b")).toBeGreaterThan(0);
  });
});
