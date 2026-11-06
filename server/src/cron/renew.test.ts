import { describe, expect, it } from "vitest";
import { selectLapsed, selectRenewals } from "./renew.js";

const NOW = Date.parse("2030-11-30T01:00:00Z");
const at = (days: number) => new Date(NOW + days * 24 * 60 * 60 * 1000).toISOString();

const agents = [
  { id: "a", label: "soon-busy", status: "active" as const, expiry: at(5) },
  { id: "b", label: "soon-idle", status: "active" as const, expiry: at(5) },
  { id: "c", label: "later-busy", status: "active" as const, expiry: at(20) },
  { id: "d", label: "paused-busy", status: "paused_owner" as const, expiry: at(1) },
  { id: "e", label: "lapsed", status: "active" as const, expiry: at(-1) },
  { id: "f", label: "revoked", status: "revoked" as const, expiry: at(2) },
  { id: "g", label: "edge", status: "paused_budget" as const, expiry: at(7) },
  { id: "h", label: "no-expiry", status: "active" as const, expiry: null },
];
const busy = new Set(["a", "c", "d", "e", "f", "g", "h"]);

describe("selectRenewals", () => {
  it("renews live names expiring within 7 days that earned in the last 30 days", () => {
    expect(selectRenewals(agents, busy, NOW).map((a) => a.label)).toEqual([
      "soon-busy",
      "paused-busy",
      "edge",
    ]);
  });
  it("never renews idle, distant, lapsed, revoked or expiry-less names", () => {
    const labels = selectRenewals(agents, busy, NOW).map((a) => a.label);
    for (const skip of ["soon-idle", "later-busy", "lapsed", "revoked", "no-expiry"])
      expect(labels).not.toContain(skip);
  });
});

describe("selectLapsed", () => {
  it("flags only live names whose expiry has passed", () => {
    expect(selectLapsed(agents, NOW).map((a) => a.label)).toEqual(["lapsed"]);
  });
});
