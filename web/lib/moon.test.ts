import { describe, expect, it } from "vitest";
import { moonLitFraction } from "./moon";

describe("moonLitFraction", () => {
  it("returns the credits-left fraction clamped to the cap", () => {
    expect(moonLitFraction("50", "100")).toBe(0.5);
    expect(moonLitFraction("150", "100")).toBe(1);
    expect(moonLitFraction("0", "100")).toBe(0);
    expect(moonLitFraction("50", "0")).toBe(0);
  });

  it("handles large integer credit amounts without float arithmetic", () => {
    expect(moonLitFraction("500000000000000000", "1000000000000000000")).toBe(0.5);
  });
});
