import type { AddressInfo } from "node:net";
import express, { type ErrorRequestHandler } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiError } from "../errors.js";
import { buyerConsoleRouter } from "./buyerConsole.js";

// Only free paths are exercised here; a real /buyer-console/run would spend testnet funds.
describe("buyer console routes", () => {
  const app = express();
  app.use(buyerConsoleRouter);
  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    const e = err as ApiError;
    res.status(e.status).json(e.toJSON());
  };
  app.use(onError);
  let server: ReturnType<typeof app.listen>;
  let base = "";

  beforeAll(() => {
    server = app.listen(0);
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
  });

  it("GET /buyer-console/budget returns the rules and today's spend", async () => {
    const res = await fetch(`${base}/buyer-console/budget`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rules: { maxPerJobAtomic: string };
      state: { date: string; dailySpentAtomic: string };
    };
    expect(body.rules.maxPerJobAtomic).toBe("100000");
    expect(body.state.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.state.dailySpentAtomic).toMatch(/^\d+$/);
  });

  it("GET /buyer-console/run rejects a malformed skill before starting a run", async () => {
    const res = await fetch(`${base}/buyer-console/run?skill=evil;drop`);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_input");
  });
});
