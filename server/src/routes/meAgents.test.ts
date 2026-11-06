import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type ErrorRequestHandler } from "express";
import type { AddressInfo } from "node:net";
import { FakeSupabase } from "../testing/fake-supabase.js";

const state = vi.hoisted(() => ({
  db: undefined as unknown as FakeSupabase,
  payoutCheck: { ok: true } as { ok: boolean; reason?: string },
}));

vi.mock("../db/client.js", () => ({
  get db() {
    return state.db;
  },
}));

vi.mock("../hedera/mirror.js", () => ({
  checkPayoutAccount: vi.fn(async () => state.payoutCheck),
}));

vi.mock("../buyer-console-auth.js", async () => {
  const { ApiError } = await import("../errors.js");
  return {
    authenticatePrivyUser: vi.fn(async (authorization?: string) => {
      if (authorization === "Bearer owner-a") return "did:privy:ownerA";
      if (authorization === "Bearer owner-b") return "did:privy:ownerB";
      if (authorization === "Bearer stranger") return "did:privy:stranger";
      throw new ApiError(401, "unauthorized", "valid Privy authentication is required");
    }),
  };
});

import { ApiError } from "../errors.js";
import { meAgentsRouter, ownerTransition } from "./meAgents.js";

const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";
const AGENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const app = express();
app.use(meAgentsRouter);
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

function call(method: string, path: string, token: string | null, body?: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function agent(id: string, ownerId: string, label: string, status: string) {
  return {
    id,
    owner_id: ownerId,
    label,
    ens_name: `${label}.nightshift.eth`,
    skill: "transcribe:ta",
    model: "whisper-large-v3",
    price_atomic: "30000",
    price_unit: "minute",
    daily_cap_usd_micro: "500000",
    status,
    hedera_account_id: "0.0.700",
    expiry: "2027-01-01T00:00:00.000Z",
  };
}

beforeEach(() => {
  state.db = new FakeSupabase();
  state.payoutCheck = { ok: true };
  state.db.seed("owners", [
    { id: OWNER_A, privy_user_id: "did:privy:ownerA", evm_address: "0x" + "a".repeat(40) },
    { id: OWNER_B, privy_user_id: "did:privy:ownerB", evm_address: "0x" + "b".repeat(40) },
  ]);
  state.db.seed("agents", [
    agent(AGENT_A, OWNER_A, "worker-a", "active"),
    agent(AGENT_B, OWNER_B, "worker-b", "active"),
  ]);
  state.db.seed("directory", [
    { label: "worker-a", status: "active" },
    { label: "worker-b", status: "active" },
  ]);
});

describe("ownerTransition", () => {
  it("lets owners pause runnable workers and resume only their own pause", () => {
    expect(ownerTransition("active", "paused_owner")).toBe("allowed");
    expect(ownerTransition("paused_budget", "paused_owner")).toBe("allowed");
    expect(ownerTransition("paused_owner", "active")).toBe("allowed");
    expect(ownerTransition("paused_owner", "paused_owner")).toBe("noop");
    expect(ownerTransition("active", "active")).toBe("noop");
  });
  it("never lets an owner override the budget guard or lifecycle states", () => {
    expect(ownerTransition("paused_budget", "active")).toBe("forbidden");
    for (const s of ["pending", "failed", "expired", "revoked"] as const) {
      expect(ownerTransition(s, "active")).toBe("forbidden");
      expect(ownerTransition(s, "paused_owner")).toBe("forbidden");
    }
  });
});

describe("PATCH /me/agents/:id", () => {
  it("requires authentication", async () => {
    const res = await call("PATCH", `/me/agents/${AGENT_A}`, null, { status: "paused_owner" });
    expect(res.status).toBe(401);
  });

  it("pauses and resumes the owner's agent and mirrors the status into the directory", async () => {
    let res = await call("PATCH", `/me/agents/${AGENT_A}`, "owner-a", { status: "paused_owner" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "paused_owner" });
    expect(state.db.table("directory").find((r) => r.label === "worker-a")!.status).toBe(
      "paused_owner",
    );
    res = await call("PATCH", `/me/agents/${AGENT_A}`, "owner-a", { status: "active" });
    expect(res.status).toBe(200);
    expect(state.db.table("agents").find((r) => r.id === AGENT_A)!.status).toBe("active");
  });

  it("returns 404 for another owner's agent and changes nothing", async () => {
    const res = await call("PATCH", `/me/agents/${AGENT_B}`, "owner-a", {
      status: "paused_owner",
      dailyCapUsdMicro: "1",
    });
    expect(res.status).toBe(404);
    const b = state.db.table("agents").find((r) => r.id === AGENT_B)!;
    expect(b.status).toBe("active");
    expect(b.daily_cap_usd_micro).toBe("500000");
  });

  it("returns 404 for a signed-in user with no owner record", async () => {
    const res = await call("PATCH", `/me/agents/${AGENT_A}`, "stranger", {
      status: "paused_owner",
    });
    expect(res.status).toBe(404);
  });

  it("updates the daily cap as an integer string", async () => {
    const res = await call("PATCH", `/me/agents/${AGENT_A}`, "owner-a", {
      dailyCapUsdMicro: "250000",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dailyCapUsdMicro: "250000" });
  });

  it("rejects bad caps, unknown fields, empty bodies and forbidden states without writing", async () => {
    for (const body of [
      { dailyCapUsdMicro: "0" },
      { dailyCapUsdMicro: "1.5" },
      { dailyCapUsdMicro: 100 },
      { status: "revoked" },
      { status: "active", price: "1" },
      {},
    ]) {
      const res = await call("PATCH", `/me/agents/${AGENT_A}`, "owner-a", body);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
    const tooHigh = await call("PATCH", `/me/agents/${AGENT_A}`, "owner-a", {
      dailyCapUsdMicro: "1000000001",
    });
    expect(tooHigh.status).toBe(422);
    state.db.table("agents").find((r) => r.id === AGENT_A)!.status = "paused_budget";
    const forced = await call("PATCH", `/me/agents/${AGENT_A}`, "owner-a", {
      status: "active",
      dailyCapUsdMicro: "999",
    });
    expect(forced.status).toBe(409);
    const a = state.db.table("agents").find((r) => r.id === AGENT_A)!;
    expect(a.status).toBe("paused_budget");
    expect(a.daily_cap_usd_micro).toBe("500000");
  });
});

describe("PATCH /me (payout account)", () => {
  it("stores a verified payout account and clears it with null", async () => {
    let res = await call("PATCH", "/me", "owner-a", { hederaPayoutAccount: "0.0.12345" });
    expect(res.status).toBe(200);
    expect(state.db.table("owners").find((r) => r.id === OWNER_A)!.hedera_payout_account).toBe(
      "0.0.12345",
    );
    res = await call("PATCH", "/me", "owner-a", { hederaPayoutAccount: null });
    expect(res.status).toBe(200);
    expect(state.db.table("owners").find((r) => r.id === OWNER_A)!.hedera_payout_account).toBe(
      null,
    );
  });

  it("refuses an account that cannot receive USDC", async () => {
    state.payoutCheck = { ok: false, reason: "not_associated" };
    const res = await call("PATCH", "/me", "owner-a", { hederaPayoutAccount: "0.0.12345" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { message: string }).message).toMatch(/not associated/);
    expect(state.db.table("owners").find((r) => r.id === OWNER_A)!.hedera_payout_account).toBe(
      undefined,
    );
  });

  it("rejects malformed ids and users without an owner record", async () => {
    expect((await call("PATCH", "/me", "owner-a", { hederaPayoutAccount: "0x12" })).status).toBe(
      422,
    );
    expect(
      (await call("PATCH", "/me", "stranger", { hederaPayoutAccount: "0.0.12345" })).status,
    ).toBe(404);
  });
});

describe("GET /me/payouts", () => {
  it("lists only the owner's payouts", async () => {
    state.db.seed("payouts", [
      {
        agent_id: AGENT_A,
        payout_date: "2026-11-05",
        gross_atomic: "100000",
        owner_atomic: "90000",
        fee_atomic: "10000",
        status: "confirmed",
        hedera_tx_id: "0.0.700@1.2",
        destination_account: "0.0.12345",
      },
      {
        agent_id: AGENT_B,
        payout_date: "2026-11-05",
        gross_atomic: "50000",
        owner_atomic: "45000",
        fee_atomic: "5000",
        status: "confirmed",
        hedera_tx_id: "0.0.701@1.2",
        destination_account: "0.0.999",
      },
    ]);
    const res = await call("GET", "/me/payouts", "owner-a");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Record<string, unknown>[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      label: "worker-a",
      grossAtomic: "100000",
      ownerAtomic: "90000",
      feeAtomic: "10000",
      transactionId: "0.0.700@1.2",
    });
  });

  it("returns an empty list for a user without an owner record", async () => {
    const res = await call("GET", "/me/payouts", "stranger");
    expect(await res.json()).toEqual({ items: [], page: 1, limit: 20 });
  });
});
