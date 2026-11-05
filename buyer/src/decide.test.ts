import type { BuyerRules } from "@nightshift/shared";
import { describe, expect, it } from "vitest";
import {
  filterRequirements,
  isValidPayTo,
  nameAllowed,
  parseEnsPrice,
  parseReputation,
  quoteMismatch,
  rankCandidates,
  type VerifiedAgent,
} from "./decide.js";

const rules: BuyerRules = {
  maxPerJobAtomic: "100000",
  dailyBudgetAtomic: "1000000",
  allowedAssets: ["0.0.429274"],
  allowedNetworks: ["hedera:testnet"],
  allowParentNames: ["nightshift.eth"],
  minSuccess: 0.9,
  humanApprovalAboveAtomic: "500000",
};

const price = (amount: bigint) => ({
  amount,
  asset: "0.0.429274",
  network: "hedera:testnet",
  unit: "minute",
});

function agent(label: string, amount: bigint, success = 1, jobs = 3, p50 = 10_000): VerifiedAgent {
  return {
    label,
    ensName: `${label}.nightshift.eth`,
    skill: "transcribe:ta",
    price: price(amount),
    payTo: "0.0.100",
    endpoint: `http://localhost:8787/a/${label}/run`,
    reputation: { jobs, success, p50_ms: p50 },
  };
}

describe("parseReputation", () => {
  it("reads success as a rate, as the registrar writes it", () => {
    expect(parseReputation('{"jobs":12,"success":0.98,"p50_ms":4200}')).toEqual({
      jobs: 12,
      success: 0.98,
      p50_ms: 4200,
    });
  });
  it('treats the initial {"jobs":0} record as no failures', () => {
    expect(parseReputation('{"jobs":0}')).toEqual({ jobs: 0, success: 1, p50_ms: 0 });
  });
  it("rejects missing, malformed and out-of-range records", () => {
    for (const t of [null, "", "nope", '{"success":1}', '{"jobs":5,"success":7}', '{"jobs":-1}'])
      expect(parseReputation(t)).toBeNull();
  });
});

describe("parseEnsPrice", () => {
  it("parses the registrar's price JSON", () => {
    expect(
      parseEnsPrice(
        '{"amount":"30000","asset":"0.0.429274","network":"hedera:testnet","unit":"minute"}',
      ),
    ).toEqual(price(30_000n));
  });
  it("rejects non-integer amounts and missing fields", () => {
    expect(parseEnsPrice('{"amount":"0.03","asset":"a","network":"n","unit":"u"}')).toBeNull();
    expect(parseEnsPrice('{"amount":"30000"}')).toBeNull();
    expect(parseEnsPrice("30000")).toBeNull();
  });
});

describe("names and payTo", () => {
  it("requires <label>.<allowed parent>", () => {
    expect(nameAllowed("kural", "kural.nightshift.eth", ["nightshift.eth"])).toBe(true);
    expect(nameAllowed("kural", "evil.nightshift.eth", ["nightshift.eth"])).toBe(false);
    expect(nameAllowed("kural", "kural.other.eth", ["nightshift.eth"])).toBe(false);
  });
  it("accepts only Hedera account ids", () => {
    expect(isValidPayTo("0.0.11323621")).toBe(true);
    expect(isValidPayTo("0x1234")).toBe(false);
    expect(isValidPayTo(null)).toBe(false);
  });
});

describe("rankCandidates", () => {
  it("orders by total price, then success, then latency", () => {
    const { queue } = rankCandidates(
      [agent("chennai-ears", 50_000n), agent("tamil-scribe", 30_000n), agent("kural", 20_000n)],
      2,
      rules,
      1_000_000n,
    );
    expect(queue.map((a) => a.label)).toEqual(["kural", "tamil-scribe", "chennai-ears"]);
    expect(queue[0]!.totalAtomic).toBe(40_000n);
  });

  it("keeps a perfect agent with many jobs (regression: success is a rate, not a count)", () => {
    const { queue, rejected } = rankCandidates(
      [agent("busy", 30_000n, 1, 50)],
      2,
      rules,
      1_000_000n,
    );
    expect(queue).toHaveLength(1);
    expect(rejected).toHaveLength(0);
  });

  it("applies every rule with a reason", () => {
    const { queue, rejected } = rankCandidates(
      [
        agent("flaky", 20_000n, 0.8),
        agent("pricey", 60_000n),
        { ...agent("hbar", 10_000n), price: { ...price(10_000n), asset: "0.0.0" } },
        { ...agent("mainnet", 10_000n), price: { ...price(10_000n), network: "hedera:mainnet" } },
        agent("ok", 30_000n),
      ],
      2,
      rules,
      1_000_000n,
    );
    expect(queue.map((a) => a.label)).toEqual(["ok"]);
    expect(Object.fromEntries(rejected.map((r) => [r.label, r.reason]))).toEqual({
      flaky: "success 0.8 below minimum 0.9",
      pricey: "total 120000 exceeds max per job 100000",
      hbar: "asset 0.0.0 not allowed",
      mainnet: "network hedera:mainnet not allowed",
    });
  });

  it("respects the remaining daily budget and the human-approval threshold", () => {
    expect(rankCandidates([agent("a", 30_000n)], 2, rules, 59_999n).queue).toHaveLength(0);
    const strict = { ...rules, humanApprovalAboveAtomic: "50000" };
    expect(
      rankCandidates([agent("a", 30_000n)], 2, strict, 1_000_000n).rejected[0]!.reason,
    ).toMatch(/human approval/);
  });

  it("puts agents without latency data after measured ones on a tie", () => {
    const { queue } = rankCandidates(
      [agent("new", 30_000n, 1, 0, 0), agent("old", 30_000n, 1, 9, 12_000)],
      1,
      rules,
      1_000_000n,
    );
    expect(queue.map((a) => a.label)).toEqual(["old", "new"]);
  });
});

describe("quote and payment policy", () => {
  const ranked = { ...agent("tamil-scribe", 30_000n), payTo: "0.0.11323621", totalAtomic: 60_000n };
  const good = {
    amount: "60000",
    asset: "0.0.429274",
    network: "hedera:testnet",
    payTo: "0.0.11323621",
  };

  it("accepts a quote that matches ENS", () => {
    expect(quoteMismatch(good, ranked)).toBeNull();
  });
  it("rejects a quote with another amount or payTo", () => {
    expect(quoteMismatch({ ...good, amount: "70000" }, ranked)).toMatch(/quote 70000/);
    expect(quoteMismatch({ ...good, payTo: "0.0.666" }, ranked)).toMatch(/payTo/);
  });
  it("filters out requirements that redirect payment or change the amount", () => {
    const expected = {
      payTo: "0.0.11323621",
      asset: "0.0.429274",
      network: "hedera:testnet",
      amount: 60_000n,
    };
    const reqs = [
      good,
      { ...good, payTo: "0.0.666" },
      { ...good, amount: "60001" },
      { ...good, asset: "0.0.0" },
    ];
    expect(filterRequirements(reqs, expected, rules)).toEqual([good]);
  });
});
