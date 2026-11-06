import { describe, expect, it } from "vitest";
import {
  decide,
  nextUtcMidnight,
  Reservations,
  sumRecordedCosts,
  utcDayStart,
} from "./budget-logic.js";

const now = new Date("2030-03-14T10:00:00Z");
const base = {
  now,
  capUsdMicro: 100_000n,
  spentUsdMicro: 0n,
  reservedUsdMicro: 0n,
  estimateUsdMicro: 10_000n,
};

describe("decide: cap boundary", () => {
  it("allows a job that lands exactly on the cap", () => {
    const d = decide({ ...base, spentUsdMicro: 90_000n });
    expect(d).toEqual({ ok: true, estimateUsdMicro: 10_000n, remainingUsdMicro: 0n });
  });
  it("refuses a job that would exceed the cap by 1 micro-USD", () => {
    const d = decide({ ...base, spentUsdMicro: 90_001n });
    expect(d.ok).toBe(false);
    if (!d.ok && d.reason === "over_budget") {
      expect(d.remainingUsdMicro).toBe(9_999n);
      expect(d.resetsAt.toISOString()).toBe("2030-03-15T00:00:00.000Z");
    } else throw new Error("expected over_budget");
  });
  it("counts in-flight reservations against the cap", () => {
    expect(decide({ ...base, spentUsdMicro: 50_000n, reservedUsdMicro: 40_000n }).ok).toBe(true);
    expect(decide({ ...base, spentUsdMicro: 50_000n, reservedUsdMicro: 40_001n }).ok).toBe(false);
  });
  it("refuses everything with a zero cap, and handles overspend without going negative", () => {
    expect(decide({ ...base, capUsdMicro: 0n }).ok).toBe(false);
    const d = decide({ ...base, spentUsdMicro: 150_000n });
    expect(!d.ok && d.reason === "over_budget" && d.remainingUsdMicro).toBe(0n);
  });
});

describe("decide: credits", () => {
  it("refuses when the 0G balance is below the estimate", () => {
    const d = decide({ ...base, balanceUsdMicro: 9_999n });
    expect(d).toMatchObject({ ok: false, reason: "no_credits", balanceUsdMicro: 9_999n });
  });
  it("allows when balance equals the estimate or is not checked", () => {
    expect(decide({ ...base, balanceUsdMicro: 10_000n }).ok).toBe(true);
    expect(decide(base).ok).toBe(true);
  });
  it("reports over_budget before no_credits", () => {
    expect(decide({ ...base, capUsdMicro: 0n, balanceUsdMicro: 0n })).toMatchObject({
      reason: "over_budget",
    });
  });
});

describe("UTC rollover", () => {
  it("day start ignores local time zones", () => {
    expect(utcDayStart(new Date("2030-03-14T23:59:59.999Z")).toISOString()).toBe(
      "2030-03-14T00:00:00.000Z",
    );
    expect(utcDayStart(new Date("2030-03-15T00:00:00.000Z")).toISOString()).toBe(
      "2030-03-15T00:00:00.000Z",
    );
    // 05:00 IST on the 15th is still the 14th in UTC
    expect(utcDayStart(new Date("2030-03-15T05:00:00+05:30")).toISOString()).toBe(
      "2030-03-14T00:00:00.000Z",
    );
  });
  it("next midnight is strictly after now, across month and year ends", () => {
    expect(nextUtcMidnight(new Date("2030-03-15T00:00:00.000Z")).toISOString()).toBe(
      "2030-03-16T00:00:00.000Z",
    );
    expect(nextUtcMidnight(new Date("2030-11-30T23:59:59.999Z")).toISOString()).toBe(
      "2030-12-01T00:00:00.000Z",
    );
    expect(nextUtcMidnight(new Date("2030-12-31T12:00:00Z")).toISOString()).toBe(
      "2031-01-01T00:00:00.000Z",
    );
  });
});

describe("Reservations", () => {
  it("sums holds per agent and releases idempotently", () => {
    const r = new Reservations();
    const a = r.hold("a", 5n);
    const b = r.hold("a", 7n);
    r.hold("b", 100n);
    expect(r.total("a")).toBe(12n);
    a();
    a();
    expect(r.total("a")).toBe(7n);
    b();
    expect(r.total("a")).toBe(0n);
    expect(r.total("b")).toBe(100n);
  });
});

describe("recorded 0G costs", () => {
  it("sums exact integer costs and ignores only explicit budget refusals", () => {
    expect(
      sumRecordedCosts([
        { id: "a", status: "done", zg_cost_usd_micro: "1200" },
        { id: "b", status: "settled", zg_cost_usd_micro: 800 },
        { id: "c", status: "refused_budget", zg_cost_usd_micro: null },
      ]),
    ).toBe(2_000n);
  });

  it("fails closed when a job that may have executed has no billing record", () => {
    expect(() =>
      sumRecordedCosts([{ id: "unknown-job", status: "failed_internal", zg_cost_usd_micro: null }]),
    ).toThrow("job unknown-job has no recorded 0G cost");
  });

  it("rejects unsafe numeric or malformed cost records", () => {
    expect(() =>
      sumRecordedCosts([
        { id: "unsafe", status: "done", zg_cost_usd_micro: Number.MAX_SAFE_INTEGER + 1 },
      ]),
    ).toThrow("unsafe 0G cost");
    expect(() =>
      sumRecordedCosts([{ id: "malformed", status: "done", zg_cost_usd_micro: "12.5" }]),
    ).toThrow("malformed 0G cost");
  });
});
