import { describe, expect, it } from "vitest";
import {
  agentStatusStamp,
  capUsedPercent,
  formatUsdMicro,
  ownerJobStatusLabel,
  parseOwnerDashboard,
  parseOwnerJobs,
  parseOwnerPayouts,
} from "./owner";

const job = {
  id: "50baf702-1284-4d60-8ce6-39b905598d98",
  label: "scribe",
  status: "settled",
  units: "2",
  priceAtomic: "60000",
  zgCostUsdMicro: "12480",
  hederaTxId: "0.0.1@1.2",
  zgRequestId: "req-1",
  hcsSequence: "3",
  outputSha256: "a".repeat(64),
  latencyMs: 11056,
  createdAt: "2026-11-05T14:40:02.650Z",
};

describe("owner job history contract", () => {
  it("accepts the server response shape", () => {
    expect(parseOwnerJobs({ items: [job], page: 1, limit: 20, nextPage: 2 })).toEqual({
      items: [job],
      page: 1,
      limit: 20,
      nextPage: 2,
    });
  });

  it("treats a missing 0G request id (older server) as null", () => {
    const older: Record<string, unknown> = { ...job };
    delete older.zgRequestId;
    expect(parseOwnerJobs({ items: [older], page: 1, limit: 20 }).items[0]!.zgRequestId).toBeNull();
  });

  it("rejects floating money, bad digests and missing fields", () => {
    for (const bad of [
      { ...job, priceAtomic: "0.06" },
      { ...job, outputSha256: "xyz" },
      { ...job, zgCostUsdMicro: 12480 },
      { ...job, label: undefined },
    ])
      expect(() => parseOwnerJobs({ items: [bad], page: 1, limit: 20 })).toThrow(/malformed/);
    expect(() => parseOwnerJobs({ items: "nope", page: 1, limit: 20 })).toThrow(/malformed/);
  });

  it("labels reconciliation states explicitly", () => {
    expect(ownerJobStatusLabel("needs_reconciliation")).toMatch(/reconciliation/);
    expect(ownerJobStatusLabel("settle_failed")).toMatch(/not charged/);
  });
});

const agent = {
  id: "a1",
  label: "scribe",
  ensName: "scribe.nightshift.eth",
  skill: "transcribe:ta",
  model: "whisper-large-v3",
  priceAtomic: "30000",
  priceUnit: "minute",
  dailyCapUsdMicro: "800000",
  status: "active",
  expiry: null,
  createdAt: "2026-11-05T00:00:00.000Z",
  hederaAccountId: "0.0.9",
  resolverAddress: "0x" + "1".repeat(40),
  registerTx: "0x" + "2".repeat(64),
  today: { spentUsdMicro: "12480", earnedAtomic: "60000", jobsSettled: 1 },
};

describe("owner dashboard contract", () => {
  it("accepts the server response and the no-owner response", () => {
    const owner = { evmAddress: "0xabc", hederaPayoutAccount: null, createdAt: "x" };
    expect(parseOwnerDashboard({ owner, agents: [agent] }).agents[0]!.today.jobsSettled).toBe(1);
    expect(parseOwnerDashboard({ owner: null, agents: [] })).toEqual({ owner: null, agents: [] });
  });
  it("rejects float money and missing usage", () => {
    const owner = { evmAddress: "0xabc", createdAt: "x" };
    for (const bad of [
      { ...agent, priceAtomic: "0.03" },
      { ...agent, today: { ...agent.today, spentUsdMicro: 1 } },
      { ...agent, today: undefined },
    ])
      expect(() => parseOwnerDashboard({ owner, agents: [bad] })).toThrow(/invalid/);
  });
});

describe("dashboard display rules", () => {
  it("maps statuses to the design's stamps", () => {
    expect(agentStatusStamp("active")).toEqual({ text: "ON SHIFT", tone: "green" });
    expect(agentStatusStamp("paused_budget")).toEqual({ text: "OUT OF CREDITS", tone: "red" });
    expect(agentStatusStamp("paused_owner")).toEqual({ text: "PAUSED", tone: "orange" });
  });
  it("computes cap usage with integer math and clamps at 100", () => {
    expect(capUsedPercent("12480", "800000")).toBe(1);
    expect(capUsedPercent("400000", "800000")).toBe(50);
    expect(capUsedPercent("900000", "800000")).toBe(100);
    expect(capUsedPercent("0", "0")).toBe(100);
  });
  it("formats micro-USD exactly", () => {
    expect(formatUsdMicro("12480")).toBe("0.012480");
    expect(formatUsdMicro("1000000")).toBe("1.000000");
  });
});

describe("owner payouts contract", () => {
  const payout = {
    id: "p1",
    label: "scribe",
    payoutDate: "2026-11-06",
    grossAtomic: "100000",
    ownerAtomic: "90000",
    feeAtomic: "10000",
    status: "confirmed",
    transactionId: "0.0.9@1.2",
    destinationAccount: "0.0.5",
    createdAt: "x",
  };
  it("accepts valid payouts and rejects unknown statuses or float money", () => {
    expect(parseOwnerPayouts({ items: [payout] }).items).toHaveLength(1);
    expect(() => parseOwnerPayouts({ items: [{ ...payout, status: "sent" }] })).toThrow();
    expect(() => parseOwnerPayouts({ items: [{ ...payout, feeAtomic: "0.1" }] })).toThrow();
  });
});
