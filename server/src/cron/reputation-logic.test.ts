import { describe, expect, it } from "vitest";
import { computeReputation, median, needsUpdate } from "./reputation-logic.js";

const now = new Date("2030-03-14T10:00:00.123Z");

describe("median", () => {
  it("handles empty, odd and even lists", () => {
    expect(median([])).toBe(0);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(3); // (2+3)/2 rounded
  });
});

describe("computeReputation", () => {
  it("counts settled jobs and excludes 0G outages from success", () => {
    const r = computeReputation(
      [
        { status: "settled", latency_ms: 4000 },
        { status: "settled", latency_ms: 6000 },
        { status: "settled", latency_ms: 5000 },
        { status: "failed_upstream", latency_ms: 100 },
        { status: "refused_budget", latency_ms: null },
        { status: "running", latency_ms: null },
        { status: "settle_failed", latency_ms: 7000 },
      ],
      now,
    );
    expect(r).toEqual({ jobs: 3, success: 0.75, p50_ms: 5000, updated: "2030-03-14T10:00:00Z" });
  });
  it("reports success 1 with no history", () => {
    expect(computeReputation([], now)).toMatchObject({ jobs: 0, success: 1, p50_ms: 0 });
  });
});

describe("needsUpdate", () => {
  const next = { jobs: 1, success: 1, p50_ms: 11056, updated: "2030-03-14T10:00:00Z" };
  it("writes when on-chain is the initial record or differs", () => {
    expect(needsUpdate('{"jobs":0}', next)).toBe(true);
    expect(needsUpdate(null, next)).toBe(true);
    expect(needsUpdate("not json", next)).toBe(true);
  });
  it("skips when only the timestamp would change", () => {
    expect(needsUpdate(JSON.stringify({ ...next, updated: "2030-03-13T00:00:00Z" }), next)).toBe(
      false,
    );
  });
});

describe("sameReputation (directory cache vs ENS)", () => {
  it("ignores key order and spots stale caches", async () => {
    const { sameReputation } = await import("./reputation.js");
    const chain = '{"jobs":8,"success":1,"p50_ms":11989,"updated":"2030-11-06T14:34:35Z"}';
    expect(
      sameReputation(chain, {
        p50_ms: 11989,
        updated: "2030-11-06T14:34:35Z",
        jobs: 8,
        success: 1,
      }),
    ).toBe(true);
    expect(sameReputation(chain, { jobs: 5, success: 1, p50_ms: 11056, updated: "x" })).toBe(false);
    expect(sameReputation('{"jobs":0}', null)).toBe(false);
    expect(sameReputation(null, null)).toBe(true);
    expect(sameReputation("not json", undefined)).toBe(true);
  });
});
