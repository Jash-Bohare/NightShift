import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type ErrorRequestHandler } from "express";
import type { AddressInfo } from "node:net";

const mocks = vi.hoisted(() => ({
  latest: null as Record<string, unknown> | null,
  from: vi.fn(),
}));

vi.mock("../db/client.js", () => ({
  big: (value: string | number | null) => BigInt(value ?? 0),
  db: { from: mocks.from },
}));
vi.mock("../db/queries.js", () => ({ agentByLabel: vi.fn() }));
vi.mock("../ens/read.js", () => ({ readAgentRecords: vi.fn() }));
vi.mock("../health.js", () => ({ health: vi.fn() }));

import { ApiError, UpstreamError } from "../errors.js";
import { health } from "../health.js";
import { publicRouter } from "./public.js";

const app = express();
app.use(publicRouter);
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

describe("allow-listed public job data", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(health).mockResolvedValue({
      ok: true,
      zg: { ok: true, ms: 1 },
      hedera: { ok: true, ms: 1 },
      sepolia: { ok: true, ms: 1 },
      supabase: { ok: true, ms: 1 },
    });
    mocks.latest = {
      id: "job-1",
      status: "settled",
      price_atomic: "30000",
      zg_cost_usd_micro: "1200",
      hedera_tx_id: "0.0.100@1770000000.000000001",
      zg_request_id: "request-1",
      hcs_sequence: "19",
      latency_ms: 100,
      created_at: "2026-03-02T00:00:00.000Z",
      agents: { label: "worker", ens_name: "worker.nightshift.eth" },
      buyer_account: "private-payer",
      error: "private internal failure",
      input: "private input",
      output: "private output",
    };
    mocks.from.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: () => ({
              maybeSingle: async () => ({ data: mocks.latest, error: null }),
            }),
          }),
        }),
      }),
    }));
  });

  it("keeps process liveness separate from dependency readiness", async () => {
    const liveResponse = await fetch(`${baseUrl}/live`);
    expect(liveResponse.status).toBe(200);
    expect(await liveResponse.json()).toEqual({ ok: true });
    expect(health).not.toHaveBeenCalled();

    vi.mocked(health).mockResolvedValue({
      ok: false,
      zg: { ok: false, ms: 1, detail: "unavailable" },
      hedera: { ok: true, ms: 1 },
      sepolia: { ok: true, ms: 1 },
      supabase: { ok: true, ms: 1 },
    });
    const readyResponse = await fetch(`${baseUrl}/ready`);
    expect(readyResponse.status).toBe(503);
    expect(await readyResponse.json()).toMatchObject({ ok: false });
  });

  it("returns a safe receipt and omits sensitive job fields", async () => {
    const response = await fetch(`${baseUrl}/jobs/latest`);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      id: "job-1",
      status: "settled",
      price_atomic: "30000",
      zg_cost_usd_micro: "1200",
      hcs_sequence: "19",
      agents: { label: "worker", ens_name: "worker.nightshift.eth" },
    });
    expect(body).not.toHaveProperty("buyer_account");
    expect(body).not.toHaveProperty("error");
    expect(body).not.toHaveProperty("input");
    expect(body).not.toHaveProperty("output");
  });

  it("returns null rather than a fabricated job when no settled record exists", async () => {
    mocks.latest = null;
    const response = await fetch(`${baseUrl}/jobs/latest`);
    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
  });

  it("fails safely if PostgREST cannot represent an atomic amount exactly", async () => {
    const latest = mocks.latest;
    if (!latest) throw new Error("test job not initialized");
    latest.price_atomic = Number.MAX_SAFE_INTEGER + 2;
    const response = await fetch(`${baseUrl}/jobs/latest`);
    expect(response.status).toBe(503);
  });
});
