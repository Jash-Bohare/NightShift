import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type ErrorRequestHandler } from "express";
import type { AddressInfo } from "node:net";

const mocks = vi.hoisted(() => ({
  agent: { id: "agent-1" as string | null },
  rows: [] as Record<string, unknown>[],
  from: vi.fn(),
}));

vi.mock("../db/client.js", () => ({ db: { from: mocks.from } }));

import { ApiError, UpstreamError } from "../errors.js";
import { payoutsRouter } from "./payouts.js";

const app = express();
app.use(payoutsRouter);
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

describe("public payout history", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.agent.id = "agent-1";
    mocks.rows = [
      {
        id: "payout-1",
        payout_date: "2026-03-01",
        gross_atomic: "100000",
        owner_atomic: "90000",
        fee_atomic: "10000",
        status: "confirmed",
        hedera_tx_id: "0.0.100@1770000000.000000001",
        created_at: "2026-03-02T00:00:00.000Z",
        destination_account: "private",
        internal_note: "private",
      },
    ];
    mocks.from.mockImplementation((table: string) => {
      if (table === "agents") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: mocks.agent.id ? { id: mocks.agent.id } : null,
                error: null,
              }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => {
            const query = {
              order: () => query,
              range: async () => ({ data: mocks.rows, error: null }),
            };
            return query;
          },
        }),
      };
    });
  });

  it("returns only allow-listed payout fields", async () => {
    const response = await fetch(`${baseUrl}/agents/nightshift-worker/payouts`);
    const body = (await response.json()) as { items: Record<string, unknown>[] };

    expect(response.status).toBe(200);
    expect(body.items[0]).toEqual({
      id: "payout-1",
      payoutDate: "2026-03-01",
      grossAtomic: "100000",
      ownerAtomic: "90000",
      feeAtomic: "10000",
      status: "confirmed",
      transactionId: "0.0.100@1770000000.000000001",
      createdAt: "2026-03-02T00:00:00.000Z",
    });
    expect(body.items[0]).not.toHaveProperty("destination_account");
    expect(body.items[0]).not.toHaveProperty("internal_note");
  });

  it("rejects malformed labels and pagination", async () => {
    const badLabel = await fetch(`${baseUrl}/agents/not_valid/payouts`);
    const badPage = await fetch(`${baseUrl}/agents/nightshift-worker/payouts?page=0`);
    expect(badLabel.status).toBe(422);
    expect(badPage.status).toBe(422);
  });

  it("returns not found for unknown workers", async () => {
    mocks.agent.id = null;
    const response = await fetch(`${baseUrl}/agents/nightshift-worker/payouts`);
    expect(response.status).toBe(404);
  });

  it("rejects unsafe numeric atomic amounts instead of rounding them", async () => {
    const payout = mocks.rows[0];
    if (!payout) throw new Error("test payout not initialized");
    payout.gross_atomic = Number.MAX_SAFE_INTEGER + 2;
    const response = await fetch(`${baseUrl}/agents/nightshift-worker/payouts`);
    expect(response.status).toBe(503);
  });
});
