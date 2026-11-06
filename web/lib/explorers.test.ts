import { describe, expect, it } from "vitest";
import {
  ensAppUrl,
  etherscanAddressUrl,
  etherscanTransactionUrl,
  hashscanAccountUrl,
  hashscanTopicUrl,
  hashscanTransactionUrl,
} from "./explorers";

describe("explorer URL builders", () => {
  it("builds HashScan links from valid Hedera identifiers", () => {
    expect(hashscanAccountUrl("0.0.123")).toBe("https://hashscan.io/testnet/account/0.0.123");
    expect(hashscanTopicUrl("0.0.456")).toBe("https://hashscan.io/testnet/topic/0.0.456");
    expect(hashscanTransactionUrl("0.0.123@1793889582.937364275")).toBe(
      "https://hashscan.io/testnet/transaction/0.0.123-1793889582-937364275",
    );
  });

  it("does not construct links from malformed Hedera identifiers", () => {
    expect(hashscanAccountUrl("0.0.bad")).toBeNull();
    expect(hashscanTransactionUrl("not-a-transaction")).toBeNull();
  });

  it("builds Sepolia links only for valid Ethereum values", () => {
    const address = `0x${"a".repeat(40)}`;
    const hash = `0x${"b".repeat(64)}`;
    expect(etherscanAddressUrl(address)).toBe(`https://sepolia.etherscan.io/address/${address}`);
    expect(etherscanTransactionUrl(hash)).toBe(`https://sepolia.etherscan.io/tx/${hash}`);
    expect(etherscanAddressUrl("0x123")).toBeNull();
  });

  it("encodes ENS names as a path segment", () => {
    expect(ensAppUrl("tamil-scribe.nightshift.eth")).toBe(
      "https://app.ens.dev/tamil-scribe.nightshift.eth",
    );
  });
});
