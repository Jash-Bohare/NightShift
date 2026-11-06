import { describe, expect, it } from "vitest";
import { parseMeCapabilities } from "./capabilities";

describe("parseMeCapabilities", () => {
  it("accepts the server shape with or without reasons", () => {
    expect(parseMeCapabilities({ canLaunch: true, canRunBuyerConsole: true })).toEqual({
      canLaunch: true,
      canRunBuyerConsole: true,
    });
    expect(
      parseMeCapabilities({
        canLaunch: false,
        launchReason: "Launching workers is switched off on this server.",
        canRunBuyerConsole: false,
        buyerConsoleReason: "x",
      }).launchReason,
    ).toMatch(/switched off/);
  });
  it("rejects malformed responses", () => {
    for (const bad of [
      null,
      {},
      { canLaunch: "yes", canRunBuyerConsole: true },
      { canLaunch: true, canRunBuyerConsole: true, launchReason: 1 },
    ])
      expect(() => parseMeCapabilities(bad)).toThrow(/malformed/);
  });
});
