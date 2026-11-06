import { describe, expect, it } from "vitest";
import { BillingUnavailableError, billedCostUsdMicro, type ZgTrace } from "./router.js";

const trace = (billing: ZgTrace["billing"]): ZgTrace => ({
  request_id: "req-1",
  provider: "0xprovider",
  ...(billing === undefined ? {} : { billing }),
});

function unavailable(billing: ZgTrace["billing"]): BillingUnavailableError {
  try {
    billedCostUsdMicro(trace(billing));
  } catch (error) {
    expect(error).toBeInstanceOf(BillingUnavailableError);
    return error as BillingUnavailableError;
  }
  throw new Error("expected billing to be rejected");
}

describe("0G billing adapter (x_0g_trace.billing contract)", () => {
  it("uses total_cost_usd_micro when present", () => {
    expect(
      billedCostUsdMicro(trace({ currency: "0g", total_cost: "9", total_cost_usd_micro: "12480" })),
    ).toBe(12480n);
  });

  it("falls back to total_cost only for documented usd accounts (micro-USD)", () => {
    expect(
      billedCostUsdMicro(
        trace({ currency: "usd", input_cost: "12000", output_cost: "480", total_cost: "12480" }),
      ),
    ).toBe(12480n);
    expect(billedCostUsdMicro(trace({ currency: "usd", total_cost: "3" }))).toBe(3n);
  });

  it("accepts an explicit zero cost but never substitutes zero", () => {
    expect(billedCostUsdMicro(trace({ total_cost_usd_micro: "0" }))).toBe(0n);
    expect(unavailable(undefined).message).toMatch(/billing is missing/);
    expect(unavailable({}).message).toMatch(/not usd/);
  });

  it("never converts 0g-denominated (wei) costs", () => {
    expect(unavailable({ currency: "0g", total_cost: "1000000000000000" }).message).toMatch(
      /not usd/,
    );
  });

  it("rejects malformed, negative and non-finite amounts", () => {
    for (const bad of [
      "1.2",
      "-5",
      "",
      "1e6",
      "0x10",
      " 12",
      "012",
      Number.NaN,
      Infinity,
      -1,
      1.5,
      null,
      {},
    ]) {
      expect(unavailable({ total_cost_usd_micro: bad }).message).toMatch(/malformed/);
      expect(unavailable({ currency: "usd", total_cost: bad }).message).toMatch(
        /missing or malformed/,
      );
    }
  });

  it("accepts safe integer JSON numbers but not unsafe ones", () => {
    expect(billedCostUsdMicro(trace({ total_cost_usd_micro: 42 }))).toBe(42n);
    expect(unavailable({ total_cost_usd_micro: 2 ** 60 }).message).toMatch(/malformed/);
  });

  it("rejects inconsistent cost components", () => {
    expect(
      unavailable({ currency: "usd", input_cost: "1", output_cost: "1", total_cost: "3" }).message,
    ).toMatch(/does not equal/);
    expect(unavailable({ currency: "usd", input_cost: "1", total_cost: "1" }).message).toMatch(
      /does not equal/,
    );
  });

  it("preserves the request id and provider for reconciliation", () => {
    const error = unavailable({ currency: "usd" });
    expect(error.requestId).toBe("req-1");
    expect(error.provider).toBe("0xprovider");
    expect(error.upstream).toBe("0g");
  });

  it("rejects a response with no request id as a plain upstream failure", () => {
    expect(() => billedCostUsdMicro(undefined)).toThrow(/request_id/);
  });
});
