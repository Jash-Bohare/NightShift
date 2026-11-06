import { describe, expect, it } from "vitest";
import { ownerJobStatusLabel, parseOwnerJobs } from "./owner";

const job = {
  id: "50baf702-1284-4d60-8ce6-39b905598d98",
  label: "scribe",
  status: "settled",
  units: "2",
  priceAtomic: "60000",
  zgCostUsdMicro: "12480",
  hederaTxId: "0.0.1@1.2",
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
