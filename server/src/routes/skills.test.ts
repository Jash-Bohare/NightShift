import { describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";

vi.mock("../zg/budget.js", () => ({
  modelUnitPricePico: vi.fn(async () => 130_000_000n),
}));

import { skillsRouter } from "./skills.js";

describe("GET /skills", () => {
  it("lists every skill with its 0G unit cost and a 4x suggested price", async () => {
    const app = express().use(skillsRouter);
    const server = app.listen(0);
    try {
      const res = await fetch(`http://localhost:${(server.address() as AddressInfo).port}/skills`);
      const body = (await res.json()) as { skills: Record<string, string>[] };
      expect(body.skills.map((s) => s.id)).toEqual([
        "transcribe:ta",
        "transcribe:hi",
        "transcribe:en",
      ]);
      expect(body.skills[0]).toMatchObject({
        unit: "minute",
        costUsdMicroPerUnit: "7800",
        suggestedPriceAtomic: "31200",
      });
    } finally {
      server.close();
    }
  });
});
