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

describe("formatElapsedSince", () => {
  it("clamps a clock that lags the start time (the console Run crash) to 00:00", async () => {
    const { formatElapsedSince } = await import("./time");
    expect(formatElapsedSince(1_000_500, 1_000_000)).toBe("00:00");
  });
  it("formats normal elapsed time", async () => {
    const { formatElapsedSince } = await import("./time");
    expect(formatElapsedSince(1_000_000, 1_065_000)).toBe("01:05");
  });
  it("returns null without a known start (resumed run) or with bad input", async () => {
    const { formatElapsedSince } = await import("./time");
    expect(formatElapsedSince(0, Date.now())).toBeNull();
    expect(formatElapsedSince(Number.NaN, 1)).toBeNull();
    expect(formatElapsedSince(1, Number.POSITIVE_INFINITY)).toBeNull();
  });
});
