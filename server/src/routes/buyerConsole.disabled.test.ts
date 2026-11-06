import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express, { type ErrorRequestHandler } from "express";
import type { AddressInfo } from "node:net";

const mocks = vi.hoisted(() => ({ runBuyer: vi.fn() }));
vi.mock("../config.js", () => ({ env: { BUYER_CONSOLE_ENABLED: false } }));
vi.mock("../db/client.js", () => ({ db: { from: vi.fn() } }));
vi.mock("@nightshift/buyer", () => ({
  DEFAULT_SAMPLE_FILE: "sample.mp3",
  loadRules: () => ({}),
  loadState: () => ({}),
  runBuyer: mocks.runBuyer,
}));

import { ApiError } from "../errors.js";
import { buyerConsoleRouter } from "./buyerConsole.js";

const app = express();
app.use(buyerConsoleRouter);
const onError: ErrorRequestHandler = (error, _req, res, next) => {
  if (error instanceof ApiError) {
    res.status(error.status).json(error.toJSON());
    return;
  }
  next(error);
};
app.use(onError);

let server: ReturnType<typeof app.listen>;
let baseUrl = "";

beforeAll(() => {
  server = app.listen(0);
  baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe("paid buyer console feature gate", () => {
  it("does not execute a buyer run when disabled", async () => {
    const response = await fetch(`${baseUrl}/buyer-console/run`, { method: "POST" });
    const body = (await response.json()) as { error: string };
    expect(response.status).toBe(503);
    expect(body.error).toBe("feature_disabled");
    expect(mocks.runBuyer).not.toHaveBeenCalled();
  });
});
