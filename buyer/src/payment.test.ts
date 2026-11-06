import { describe, expect, it } from "vitest";
import { paymentReadinessError, readPaymentResponse } from "./payment.js";

describe("x402 payment readiness and receipts", () => {
  it("uses atomic integer balances for payment readiness", () => {
    expect(paymentReadinessError(30_000n, 30_000n)).toBeNull();
    expect(paymentReadinessError(29_999n, 30_000n)).toMatch(/insufficient/);
    expect(paymentReadinessError(0n, 0n)).toMatch(/positive/);
  });

  it("parses a payment response header without treating it as independent proof", () => {
    const header = Buffer.from(
      JSON.stringify({ success: true, transaction: "0.0.100@123456789.000000001" }),
    ).toString("base64");
    expect(readPaymentResponse(header)).toEqual({
      success: true,
      transaction: "0.0.100@123456789.000000001",
    });
    expect(() => readPaymentResponse("not-a-valid-header")).toThrow();
  });
});
