import { describe, expect, it } from "vitest";
import { validateSpend, type SpendValidation } from "./spending.js";

describe("buyer spending validation", () => {
  const rules = {
    maxPerJobAtomic: "100000", // $0.10
    dailyBudgetAtomic: "1000000", // $1.00
    allowedAssets: ["0.0.429274"],
    allowedNetworks: ["hedera:testnet"],
    allowParentNames: ["nightshift.eth"],
    minSuccess: 0.9,
    humanApprovalAboveAtomic: "500000",
  };

  it("approves jobs within limit", () => {
    const res = validateSpend(60000n, rules); // 0.06 USDC
    expect(res.allowed).toBe(true);
  });

  it("rejects jobs exceeding maxPerJob", () => {
    const res = validateSpend(120000n, rules); // 0.12 USDC > 0.10 USDC
    expect(res.allowed).toBe(false);
    expect(res.reason).toContain("exceeds max per job");
  });
});
