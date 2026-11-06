import { describe, expect, it } from "vitest";
import { formatUsdMicro } from "./money";

describe("formatUsdMicro", () => {
  it.each([
    ["0", "$0"],
    ["1", "$0.000001"],
    ["12500", "$0.0125"],
    ["1000000", "$1"],
    ["-250000", "-$0.25"],
  ])("formats %s without floating-point rounding", (amount, expected) => {
    expect(formatUsdMicro(amount)).toBe(expected);
  });
});
