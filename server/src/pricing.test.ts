import { describe, expect, it } from "vitest";
import {
  audioMinutes,
  estimateCostUsdMicro,
  parseDeclaredUnits,
  priceFor,
  usdDecimalToPico,
} from "./pricing.js";

describe("usdDecimalToPico", () => {
  it("parses live /v1/models prices", () => {
    expect(usdDecimalToPico("0.00013")).toBe(130_000_000n); // whisper, per second
    expect(usdDecimalToPico("0.000000021875")).toBe(21_875n); // qwen-flash, per token
    expect(usdDecimalToPico("0")).toBe(0n);
    expect(usdDecimalToPico("1")).toBe(1_000_000_000_000n);
  });
  it("rejects garbage and sub-pico precision", () => {
    expect(() => usdDecimalToPico("1e-4")).toThrow();
    expect(() => usdDecimalToPico("-0.1")).toThrow();
    expect(() => usdDecimalToPico("0.0000000000001")).toThrow();
    expect(usdDecimalToPico("0.1000000000000")).toBe(100_000_000_000n); // trailing zeros fine
  });
});

describe("estimateCostUsdMicro", () => {
  it("matches the verified Whisper bill without safety factor", () => {
    // 96 billed seconds × $0.00013 = 12480 micro-USD (see PROOFS.md)
    expect(estimateCostUsdMicro(130_000_000n, 96n, 100n)).toBe(12_480n);
  });
  it("applies ×1.2 by default and rounds up", () => {
    expect(estimateCostUsdMicro(130_000_000n, 96n)).toBe(14_976n);
    expect(estimateCostUsdMicro(21_875n, 1n)).toBe(1n); // 0.02625 micro -> 1
    expect(estimateCostUsdMicro(0n, 1000n)).toBe(0n);
  });
});

describe("audioMinutes", () => {
  it("rounds up with a minimum of 1", () => {
    expect(audioMinutes(0)).toBe(1);
    expect(audioMinutes(59.9)).toBe(1);
    expect(audioMinutes(60)).toBe(1);
    expect(audioMinutes(60.01)).toBe(2);
    expect(audioMinutes(90)).toBe(2);
  });
  it("rejects bad durations", () => {
    expect(() => audioMinutes(Number.NaN)).toThrow();
    expect(() => audioMinutes(-1)).toThrow();
  });
});

describe("parseDeclaredUnits", () => {
  it("accepts positive numbers and rounds up", () => {
    expect(parseDeclaredUnits("2")).toBe(2);
    expect(parseDeclaredUnits(" 1.5 ")).toBe(2);
    expect(parseDeclaredUnits("0")).toBe(1);
  });
  it("rejects missing, negative, non-numeric and huge values", () => {
    for (const h of [undefined, null, "", "-1", "abc", "1e3", "10001"])
      expect(parseDeclaredUnits(h)).toBeNull();
  });
});

describe("priceFor", () => {
  it("multiplies per-unit price by whole units", () => {
    expect(priceFor(30_000n, 2)).toBe(60_000n);
    expect(priceFor(30_000n, 0)).toBe(30_000n);
    expect(priceFor(30_000n, 1.2)).toBe(60_000n);
  });
});
