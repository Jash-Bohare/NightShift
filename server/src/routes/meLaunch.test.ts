import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type ErrorRequestHandler } from "express";
import type { AddressInfo } from "node:net";
import { FakeSupabase } from "../testing/fake-supabase.js";

const WALLET = "0x1111111111111111111111111111111111111111";

const state = vi.hoisted(() => ({
  db: undefined as unknown as FakeSupabase,
  launchEnabled: true,
  wallets: [] as string[],
  launch: vi.fn(),
  sync: vi.fn(async () => "indexed"),
  payoutOk: true,
}));

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get(target, key) {
        if (key === "OWNER_LAUNCH_ENABLED") return state.launchEnabled;
        if (key === "OWNER_MAX_AGENTS") return 2;
        return target[key as keyof typeof target];
      },
    }),
  };
});
vi.mock("../db/client.js", () => ({
  get db() {
    return state.db;
  },
}));
vi.mock("../auth/privy-wallets.js", () => ({
  linkedEthereumWallets: vi.fn(async () => state.wallets),
}));
vi.mock("../agents/launch.js", () => ({ launchAgent: state.launch }));
vi.mock("../ens/indexer.js", () => ({ syncAgentToDirectory: state.sync }));
vi.mock("../hedera/mirror.js", () => ({
  checkPayoutAccount: vi.fn(async () =>
    state.payoutOk ? { ok: true } : { ok: false, reason: "not_associated" },
  ),
}));
vi.mock("../buyer-console-auth.js", async () => {
  const { ApiError } = await import("../errors.js");
  return {
    authenticatePrivyUser: vi.fn(async (authorization?: string) => {
      if (authorization === "Bearer owner") return "did:privy:owner";
      throw new ApiError(401, "unauthorized", "valid Privy authentication is required");
    }),
  };
});

import { ApiError } from "../errors.js";
import { meLaunchRouter, resetLaunchLock } from "./meLaunch.js";

const app = express();
app.use(meLaunchRouter);
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

const valid = {
  label: "tamil-scribe-2",
  skill: "transcribe:ta",
  priceAtomic: "30000",
  dailyCapUsdMicro: "800000",
  zgApiKey: "sk-abcdefghijkl",
  ownerAddress: WALLET.toLowerCase(),
};

function post(body: unknown, token: string | null = "owner") {
  return fetch(`${baseUrl}/me/agents`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function lines(res: Response): Promise<Record<string, unknown>[]> {
  return (await res.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetLaunchLock();
  state.db = new FakeSupabase();
  state.launchEnabled = true;
  state.wallets = [WALLET];
  state.payoutOk = true;
  state.launch.mockImplementation(async (_input, onProgress: (e: unknown) => void) => {
    onProgress({ step: "validate", status: "running" });
    onProgress({ step: "ens_register", status: "sent", txHash: "0xabc" });
    return {
      agentId: "id",
      ensName: "tamil-scribe-2.nightshift.eth",
      registerTx: "0xabc",
      resolver: "0xdef",
      hederaAccount: "0.0.9",
    };
  });
});

describe("POST /me/agents", () => {
  it("requires authentication before anything else", async () => {
    const res = await post(valid, null);
    expect(res.status).toBe(401);
    expect(state.launch).not.toHaveBeenCalled();
  });

  it("is refused while OWNER_LAUNCH_ENABLED is false", async () => {
    state.launchEnabled = false;
    const res = await post(valid);
    expect(res.status).toBe(503);
    expect(state.launch).not.toHaveBeenCalled();
  });

  it("streams progress and the result, passing the checksummed linked wallet", async () => {
    const res = await post({ ...valid, description: "Tamil audio to text" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/x-ndjson/);
    const out = await lines(res);
    expect(out[0]).toEqual({ type: "progress", step: "validate", status: "running" });
    expect(out[1]).toMatchObject({ type: "progress", status: "sent", txHash: "0xabc" });
    expect(out.at(-1)).toMatchObject({ type: "done", result: { hederaAccount: "0.0.9" } });
    const input = state.launch.mock.calls[0]![0] as Record<string, unknown>;
    expect(input).toMatchObject({
      owner: { privyUserId: "did:privy:owner", evmAddress: WALLET },
      priceAtomic: 30000n,
      dailyCapUsdMicro: 800000n,
      description: "Tamil audio to text",
      dripOwnerEth: true,
    });
    expect(state.sync).toHaveBeenCalledWith("tamil-scribe-2");
  });

  it("refuses an owner address that is not linked to the Privy user", async () => {
    state.wallets = ["0x2222222222222222222222222222222222222222"];
    const res = await post(valid);
    expect(res.status).toBe(403);
    expect(state.launch).not.toHaveBeenCalled();
  });

  it("validates every field before launching", async () => {
    for (const patch of [
      { label: "AB" },
      { skill: "ocr:doc" },
      { priceAtomic: "0" },
      { priceAtomic: "10000001" },
      { dailyCapUsdMicro: "1000000001" },
      { zgApiKey: "mk-abcdefghijkl" },
      { zgMgmtKey: "sk-abcdefghijkl" },
      { hederaPayoutAccount: "12345" },
      { ownerAddress: "0x12" },
      { extra: true },
    ]) {
      const res = await post({ ...valid, ...patch });
      expect(res.status, JSON.stringify(patch)).toBe(422);
    }
    expect(state.launch).not.toHaveBeenCalled();
  });

  it("refuses a payout account that cannot receive USDC", async () => {
    state.payoutOk = false;
    const res = await post({ ...valid, hederaPayoutAccount: "0.0.12345" });
    expect(res.status).toBe(422);
    expect(state.launch).not.toHaveBeenCalled();
  });

  it("enforces the per-owner worker limit, ignoring failed launches", async () => {
    state.db.seed("owners", [{ id: "o1", privy_user_id: "did:privy:owner", evm_address: WALLET }]);
    state.db.seed("agents", [
      { owner_id: "o1", label: "a-one", status: "active" },
      { owner_id: "o1", label: "a-two", status: "failed" },
    ]);
    expect((await post(valid)).status).toBe(200);
    state.db.seed("agents", [{ owner_id: "o1", label: "a-three", status: "paused_owner" }]);
    expect((await post(valid)).status).toBe(409);
  });

  it("reports a launch failure as a final error line", async () => {
    state.launch.mockImplementation(async () => {
      throw new ApiError(409, "label_taken", "tamil-scribe-2.nightshift.eth is taken");
    });
    const out = await lines(await post(valid));
    expect(out.at(-1)).toEqual({
      type: "error",
      error: "label_taken",
      message: "tamil-scribe-2.nightshift.eth is taken",
    });
    expect(state.sync).not.toHaveBeenCalled();
  });

  it("runs one launch at a time and releases the lock afterwards", async () => {
    let release!: () => void;
    state.launch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              agentId: "id",
              ensName: "x",
              registerTx: "0x",
              resolver: "0x",
              hederaAccount: "0.0.1",
            });
        }),
    );
    const first = post(valid);
    await vi.waitFor(() => expect(state.launch).toHaveBeenCalledTimes(1));
    expect((await post(valid)).status).toBe(429);
    release();
    expect((await first).status).toBe(200);
    expect((await post(valid)).status).toBe(200);
  });
});
