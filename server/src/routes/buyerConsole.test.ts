import express from "express";
import { describe, expect, it } from "vitest";
import { buyerConsoleRouter } from "./buyerConsole.js";

describe("buyerConsoleRouter endpoints", () => {
  const app = express();
  app.use(buyerConsoleRouter);

  it("GET /buyer/budget returns rules and spending state", async () => {
    const server = app.listen(0);
    const addr = server.address() as { port: number };
    try {
      const res = await fetch(`http://localhost:${addr.port}/buyer/budget`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.success).toBe(true);
      expect(body.rules).toBeDefined();
      expect(body.rules.maxPerJobAtomic).toBe("100000");
      expect(body.state).toBeDefined();
    } finally {
      server.close();
    }
  });

  it("GET /buyer/spending returns current spend metrics", async () => {
    const server = app.listen(0);
    const addr = server.address() as { port: number };
    try {
      const res = await fetch(`http://localhost:${addr.port}/buyer/spending`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.success).toBe(true);
      expect(body.state.date).toBeDefined();
      expect(body.state.dailySpentAtomic).toBeDefined();
      expect(body.state.totalSpentAtomic).toBeDefined();
    } finally {
      server.close();
    }
  });
});
