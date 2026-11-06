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

describe("workerBadge", () => {
  it("is deterministic per name and ignores case and padding", async () => {
    const { workerBadge } = await import("./moon");
    expect(workerBadge("tamil-scribe")).toEqual(workerBadge(" Tamil-Scribe "));
  });
  it("varies between workers and stays within the badge", async () => {
    const { workerBadge, BADGE_SKIES } = await import("./moon");
    const names = ["tamil-scribe", "kural", "chennai-ears", "hindi-scribe", "a", "b", "c", "d"];
    const badges = names.map(workerBadge);
    expect(new Set(badges.map((b) => JSON.stringify(b))).size).toBe(names.length);
    for (const b of badges) {
      expect(BADGE_SKIES).toContain(b.sky);
      expect(b.tilt).toBeGreaterThanOrEqual(-60);
      expect(b.tilt).toBeLessThan(60);
      expect(b.stars).toHaveLength(2);
      for (const s of b.stars) {
        expect(s.x).toBeGreaterThan(15);
        expect(s.x).toBeLessThan(85);
        expect(s.r).toBeGreaterThanOrEqual(2);
      }
    }
  });
  it("has a sensible default for an empty name (launch preview before typing)", async () => {
    const { workerBadge } = await import("./moon");
    expect(workerBadge("")).toEqual(workerBadge("nightshift"));
  });
});
