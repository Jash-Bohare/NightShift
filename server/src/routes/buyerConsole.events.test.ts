import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type ErrorRequestHandler } from "express";
import type { AddressInfo } from "node:net";

const mocks = vi.hoisted(() => ({
  rows: [] as { event_type: string; payload: unknown; created_at: string }[],
  from: vi.fn(),
}));

vi.mock("@nightshift/buyer", () => ({
  DEFAULT_SAMPLE_FILE: "sample.mp3",
  loadRules: () => ({}),
  loadState: () => ({}),
  runBuyer: vi.fn(),
}));
vi.mock("../db/client.js", () => ({ db: { from: mocks.from } }));
vi.mock("../buyer-console-auth.js", () => ({
  authorizeBuyerConsole: vi.fn(async () => "did:privy:testuser"),
}));

import { ApiError, UpstreamError } from "../errors.js";
import { buyerConsoleRouter } from "./buyerConsole.js";

const app = express();
app.use(buyerConsoleRouter);
const onError: ErrorRequestHandler = (error, _req, res, next) => {
  if (error instanceof ApiError) {
    res.status(error.status).json(error.toJSON());
    return;
  }
  if (error instanceof UpstreamError) {
    res.status(503).json({ error: "upstream" });
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

describe("buyer console event recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rows = [
      {
        event_type: "plan",
        payload: {
          kind: "plan",
          runId: "run-1770000000000",
          timestamp: "2030-03-02T00:00:00.000Z",
          task: { skill: "transcribe:ta", units: 2, file: "private/server/path.mp3" },
          rules: { allowedAssets: ["0.0.429274"] },
          privateKey: "must-not-appear",
        },
        created_at: "2030-03-02T00:00:00.000Z",
      },
    ];
    mocks.from.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: async () => ({ data: mocks.rows, error: null }),
          }),
        }),
      }),
    }));
  });

  it("returns only sanitized, allow-listed buyer event data", async () => {
    const response = await fetch(`${baseUrl}/buyer-console/events/run-1770000000000`, {
      headers: { authorization: "Bearer test-token" },
    });
    const body = (await response.json()) as {
      events: { payload: Record<string, unknown> }[];
    };

    expect(response.status).toBe(200);
    expect(body.events[0]?.payload).toMatchObject({
      runId: "run-1770000000000",
      kind: "plan",
      task: { skill: "transcribe:ta", units: 2 },
    });
    expect(body.events[0]?.payload).not.toHaveProperty("privateKey");
    expect(body.events[0]?.payload.task).not.toHaveProperty("file");
  });

  it("rejects malformed run identifiers", async () => {
    const response = await fetch(`${baseUrl}/buyer-console/events/not-a-run`, {
      headers: { authorization: "Bearer test-token" },
    });
    expect(response.status).toBe(422);
  });
});
