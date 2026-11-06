import { describe, expect, it } from "vitest";
import { formatCountdown, formatCountdownToUtcMidnight, secondsUntilUtcMidnight } from "./time";

describe("UTC shift countdown", () => {
  it("counts down to the next UTC midnight", () => {
    expect(formatCountdownToUtcMidnight(Date.UTC(2025, 0, 1, 23, 59, 59))).toBe("00:00:01");
  });

  it("uses the following day when the timestamp is exactly midnight", () => {
    expect(secondsUntilUtcMidnight(Date.UTC(2025, 0, 1))).toBe(86_400);
  });

  it("formats durations longer than one day without wrapping hours", () => {
    expect(formatCountdown(100_000)).toBe("27:46:40");
  });

  it("rejects invalid time input", () => {
    expect(() => secondsUntilUtcMidnight(Number.NaN)).toThrow(RangeError);
    expect(() => formatCountdown(-1)).toThrow(RangeError);
  });
});
