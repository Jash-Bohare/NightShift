import { describe, expect, it } from "vitest";
import { allowList, canLaunch, canRunBuyerConsole, launchMode } from "./capabilities.js";

const me = "did:privy:owner";
describe("deployment capabilities", () => {
  it("launch: off, open to any owner, or restricted to the allow-list", () => {
    expect(launchMode(false, allowList(""))).toBe("off");
    expect(launchMode(true, allowList(""))).toBe("open");
    expect(launchMode(true, allowList(`${me}, did:privy:other`))).toBe("restricted");
    expect(canLaunch(me, true, allowList(""))).toBe(true);
    expect(canLaunch(me, true, allowList(me))).toBe(true);
    expect(canLaunch("did:privy:stranger", true, allowList(me))).toBe(false);
    expect(canLaunch(me, false, allowList(me))).toBe(false);
  });
  it("buyer console: only allow-listed users, only when enabled", () => {
    expect(canRunBuyerConsole(me, true, allowList(me))).toBe(true);
    expect(canRunBuyerConsole("did:privy:stranger", true, allowList(me))).toBe(false);
    expect(canRunBuyerConsole(me, false, allowList(me))).toBe(false);
    expect(canRunBuyerConsole(me, true, allowList(""))).toBe(false);
  });
});
