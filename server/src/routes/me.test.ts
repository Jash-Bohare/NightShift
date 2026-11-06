import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type ErrorRequestHandler } from "express";
import type { AddressInfo } from "node:net";

const state = vi.hoisted(() => ({
  owner: {
    id: "50baf702-1284-4d60-8ce6-39b905598d98",
    evm_address: "0x2222222222222222222222222222222222222222",
    created_at: "2026-03-02T00:00:00.000Z",
  } as Record<string, unknown> | null,
  agents: [] as Record<string, unknown>[],
  todayJobs: [] as Record<string, unknown>[],
  jobsAgentFilter: [] as string[],
  ownerIdFilter: "",
  from: vi.fn(),
}));

vi.mock("../buyer-console-auth.js", () => ({
  authenticatePrivyUser: vi.fn(async (authorization?: string) => {
    if (authorization !== "Bearer valid-token") {
      const error = new Error("unauthorized") as Error & {
        status: number;
        toJSON: () => { error: string };
      };
      error.status = 401;
      error.toJSON = () => ({ error: "unauthorized" });
      throw error;
    }
    return "did:privy:owner";
  }),
}));

vi.mock("../db/client.js", () => ({
  db: {
    from: state.from,
  },
}));

import { meRouter } from "./me.js";

const app = express();
app.use(meRouter);
const onError: ErrorRequestHandler = (error, _req, res, next) => {
  if (typeof error?.status === "number") {
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

describe("owner dashboard API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.ownerIdFilter = "";
    state.owner = {
      id: "50baf702-1284-4d60-8ce6-39b905598d98",
      evm_address: "0x2222222222222222222222222222222222222222",
      created_at: "2026-03-02T00:00:00.000Z",
    };
    state.agents = [
      {
        id: "8962ca34-6b72-4741-91aa-4ba98480a99e",
        label: "worker",
        ens_name: "worker.nightshift.eth",
        skill: "transcribe:ta",
        model: "whisper-large-v3",
        price_atomic: "30000",
        price_unit: "minute",
        daily_cap_usd_micro: "500000",
        status: "active",
        expiry: "2027-03-02T00:00:00.000Z",
        created_at: "2026-03-02T00:00:00.000Z",
        zg_api_key_enc: "must-not-appear",
        hedera_private_key_enc: "must-not-appear",
      },
    ];
    state.todayJobs = [
      {
        agent_id: "8962ca34-6b72-4741-91aa-4ba98480a99e",
        status: "settled",
        price_atomic: "60000",
        zg_cost_usd_micro: "12480",
      },
      {
        agent_id: "8962ca34-6b72-4741-91aa-4ba98480a99e",
        status: "refused_budget",
        price_atomic: "60000",
        zg_cost_usd_micro: null,
      },
      {
        agent_id: "8962ca34-6b72-4741-91aa-4ba98480a99e",
        status: "running",
        price_atomic: "30000",
        zg_cost_usd_micro: "100",
      },
    ];
    state.from.mockImplementation((table: string) => ({
      select: () => ({
        in: (column: string, ids: string[]) => {
          if (table !== "jobs" || column !== "agent_id") throw new Error(`unexpected in ${table}`);
          state.jobsAgentFilter = ids;
          return { gte: async () => ({ data: state.todayJobs, error: null }) };
        },
        eq: (column: string, value: string) => {
          if (table === "owners") {
            return {
              maybeSingle: async () => ({ data: state.owner, error: null }),
            };
          }
          if (table === "agents") {
            state.ownerIdFilter = column === "owner_id" ? value : "";
            return {
              order: async () => ({ data: state.agents, error: null }),
            };
          }
          throw new Error(`unexpected table ${table}`);
        },
      }),
    }));
  });

  it("requires a verified owner token before accessing owner data", async () => {
    const response = await fetch(`${baseUrl}/me`);
    expect(response.status).toBe(401);
    expect(state.from).not.toHaveBeenCalled();
  });

  it("returns only the authenticated owner's allow-listed roster", async () => {
    const response = await fetch(`${baseUrl}/me`, {
      headers: { authorization: "Bearer valid-token" },
    });
    const body = (await response.json()) as {
      owner: { evmAddress: string };
      agents: Record<string, unknown>[];
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(state.ownerIdFilter).toBe(state.owner?.id);
    expect(body.owner.evmAddress).toBe("0x2222222222222222222222222222222222222222");
    expect(body.agents[0]).toMatchObject({
      label: "worker",
      ensName: "worker.nightshift.eth",
      priceAtomic: "30000",
      dailyCapUsdMicro: "500000",
    });
    expect(body.agents[0]!.today).toEqual({
      spentUsdMicro: "12580",
      earnedAtomic: "60000",
      jobsSettled: 1,
    });
    expect(state.jobsAgentFilter).toEqual(["8962ca34-6b72-4741-91aa-4ba98480a99e"]);
    expect(body.agents[0]).not.toHaveProperty("zg_api_key_enc");
    expect(body.agents[0]).not.toHaveProperty("hedera_private_key_enc");
  });

  it("returns an honest empty roster for a verified user without an owner record", async () => {
    state.owner = null;
    const response = await fetch(`${baseUrl}/me`, {
      headers: { authorization: "Bearer valid-token" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ owner: null, agents: [] });
  });
});
