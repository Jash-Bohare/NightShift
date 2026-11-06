import { describe, expect, it } from "vitest";
import { formatPercent, reputationHeadline } from "./percent";

describe("reputationHeadline", () => {
  it("shows a success rate only once a worker has settled jobs", () => {
    expect(reputationHeadline({ jobs: 8, success: 1 })).toEqual({ headline: "100%", jobs: 8 });
    expect(reputationHeadline({ jobs: 5, success: 0.8 })).toEqual({ headline: "80%", jobs: 5 });
  });
  it("calls a worker with zero jobs new, whatever the default success value", () => {
    expect(reputationHeadline({ jobs: 0, success: 1 })).toEqual({ headline: "new", jobs: 0 });
    expect(reputationHeadline({ jobs: 0 })).toEqual({ headline: "new", jobs: 0 });
    expect(reputationHeadline(null)).toEqual({ headline: "new", jobs: 0 });
  });
  it("formats percentages exactly", () => {
    expect(formatPercent(0.925)).toBe("92.5%");
    expect(formatPercent(Number.NaN)).toBe("—");
  });
});
