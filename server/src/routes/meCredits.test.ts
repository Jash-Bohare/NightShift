import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type ErrorRequestHandler } from "express";
import type { AddressInfo } from "node:net";
import { FakeSupabase } from "../testing/fake-supabase.js";

const state = vi.hoisted(() => ({
  db: undefined as unknown as FakeSupabase,
  balance: vi.fn(),
}));
vi.mock("../db/client.js", () => ({
  get db() {
    return state.db;
  },
}));
vi.mock("../zg/router.js", () => ({ balance: state.balance }));
vi.mock("../buyer-console-auth.js", async () => {
  const { ApiError } = await import("../errors.js");
  return {
    authenticatePrivyUser: vi.fn(async (authorization?: string) => {
      if (authorization === "Bearer owner") return "did:privy:owner";
      if (authorization === "Bearer stranger") return "did:privy:stranger";
      throw new ApiError(401, "unauthorized", "valid Privy authentication is required");
    }),
  };
});

import { env } from "../config.js";
import { encrypt } from "../crypto.js";
import { ApiError } from "../errors.js";
import { clearCreditCache, meCreditsRouter } from "./meCredits.js";

const app = express().use(meCreditsRouter);
const onError: ErrorRequestHandler = (error, _req, res, next) => {
  if (error instanceof ApiError) {
    res.status(error.status).json(error.toJSON());
    return;
  }
  next(error);
};
app.use(onError);
let server: ReturnType<typeof app.listen>;
let base = "";
beforeAll(() => {
  server = app.listen(0);
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
const get = async (token?: string) => {
  const res = await fetch(`${base}/me/zg-credits`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const seedAgent = (id: string, ownerId: string, label: string, mk: string | null) => {
  state.db.seed("agents", [{ id, owner_id: ownerId, label }]);
  state.db.seed("agent_secrets", [
    {
      agent_id: id,
      zg_api_key_enc: encrypt("sk-x", env.SECRETS_MASTER_KEY),
      zg_mgmt_key_enc: mk ? encrypt(mk, env.SECRETS_MASTER_KEY) : null,
      hedera_private_key_enc: encrypt("0x1", env.SECRETS_MASTER_KEY),
    },
  ]);
};

beforeEach(() => {
  clearCreditCache();
  state.balance.mockReset();
  state.db = new FakeSupabase();
  state.db.seed("owners", [
    { id: OWNER, privy_user_id: "did:privy:owner", evm_address: "0x" + "a".repeat(40) },
    { id: OTHER, privy_user_id: "did:privy:other", evm_address: "0x" + "b".repeat(40) },
  ]);
  seedAgent("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", OWNER, "tamil-scribe", "mk-team");
  seedAgent("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", OWNER, "kural", "mk-team");
  seedAgent("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3", OWNER, "no-key", null);
  seedAgent("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", OTHER, "someone-else", "mk-other");
});

describe("GET /me/zg-credits", () => {
  it("reads each 0G account once, for this owner's workers only", async () => {
    state.balance.mockResolvedValue({
      address: "0xe79e",
      currency: "usd",
      credit_balance: "4837100",
      total_balance: "4837100",
    });
    const { status, body } = await get("owner");
    expect(status).toBe(200);
    expect(body.accounts).toEqual([
      {
        address: "0xe79e",
        creditBalanceUsdMicro: "4837100",
        totalBalanceUsdMicro: "4837100",
        workers: ["tamil-scribe", "kural"],
      },
    ]);
    expect(state.balance).toHaveBeenCalledTimes(1);
    expect(state.balance).toHaveBeenCalledWith("mk-team");
    expect(JSON.stringify(body)).not.toMatch(/mk-/);
  });

  it("caches a read for 15 s", async () => {
    state.balance.mockResolvedValue({ address: "0x1", credit_balance: "1", total_balance: "1" });
    await get("owner");
    await get("owner");
    expect(state.balance).toHaveBeenCalledTimes(1);
  });

  it("reports an unavailable or malformed 0G read per account instead of failing", async () => {
    state.balance.mockRejectedValueOnce(new Error("timeout"));
    const failed = await get("owner");
    expect(failed.status).toBe(200);
    expect(failed.body.accounts).toEqual([
      { workers: ["tamil-scribe", "kural"], error: "0G balance unavailable right now" },
    ]);
    clearCreditCache();
    state.balance.mockResolvedValueOnce({
      address: "0x1",
      credit_balance: "4.8",
      total_balance: "1",
    });
    const malformed = await get("owner");
    expect((malformed.body.accounts as { error?: string }[])[0]!.error).toMatch(/unavailable/);
  });

  it("returns no accounts for a user without workers, and requires sign-in", async () => {
    expect((await get("stranger")).body.accounts).toEqual([]);
    expect((await get()).status).toBe(401);
    expect(state.balance).not.toHaveBeenCalled();
  });
});
