import type { AddressInfo } from "node:net";
import express, { type ErrorRequestHandler } from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ApiError } from "../errors.js";

// Replace the real buyer (which spends testnet funds) with a slow fake to test the limits.
let release: () => void = () => {};
vi.mock("@nightshift/buyer", () => ({
  DEFAULT_SAMPLE_FILE: "/dev/null",
  loadRules: () => ({}),
  loadState: () => ({}),
  runBuyer: vi.fn(
    async (_task: unknown, opts: { onEvent?: (e: unknown) => void }) =>
      new Promise((resolve) => {
        opts.onEvent?.({ kind: "plan", timestamp: new Date().toISOString() });
        release = () => resolve({ success: true, chosenAgent: "fake.nightshift.eth" });
      }),
  ),
}));
vi.mock("../db/client.js", () => ({
  db: { from: () => ({ insert: () => Promise.resolve({ error: null }) }) },
}));
vi.mock("../buyer-console-auth.js", () => ({
  authorizeBuyerConsole: vi.fn(async () => "did:privy:testuser"),
}));

const { buyerConsoleRouter } = await import("./buyerConsole.js");

describe("buyer console run limits", () => {
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

  it("streams a run, refuses a concurrent one, then rate-limits for 20 s", async () => {
    const first = await fetch(`${base}/buyer-console/run`, {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
    });
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toContain("text/event-stream");

    const concurrent = await fetch(`${base}/buyer-console/run`, {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
    });
    expect(concurrent.status).toBe(429);
    expect(((await concurrent.json()) as { message: string }).message).toMatch(/in progress/);

    release();
    const body = await first.text();
    expect(body).toContain("event: plan");
    expect(body).toContain('event: complete\ndata: {"success":true,"chosen":"fake.nightshift.eth"');

    const tooSoon = await fetch(`${base}/buyer-console/run`, {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
    });
    expect(tooSoon.status).toBe(429);
    expect(((await tooSoon.json()) as { message: string }).message).toMatch(/one run per 20 s/);
  });
});
