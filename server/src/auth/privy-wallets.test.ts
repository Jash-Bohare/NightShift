import { describe, expect, it } from "vitest";
import { ethereumWalletsFrom } from "./privy-wallets.js";

describe("ethereumWalletsFrom", () => {
  it("keeps only linked Ethereum wallets, checksummed and de-duplicated", () => {
    const a = "0x52908400098527886e0f7030069857d2e4169ee7";
    expect(
      ethereumWalletsFrom([
        { type: "wallet", chain_type: "ethereum", address: a, connector_type: "embedded" },
        { type: "wallet", chain_type: "ethereum", address: a.toUpperCase().replace("0X", "0x") },
        {
          type: "wallet",
          chain_type: "solana",
          address: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
        },
        { type: "email", address: "someone@example.com" },
        { type: "wallet", chain_type: "ethereum", address: "not-an-address" },
        null,
      ]),
    ).toEqual(["0x52908400098527886E0F7030069857D2E4169EE7"]);
  });
});
