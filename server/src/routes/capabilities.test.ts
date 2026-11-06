import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express, { type ErrorRequestHandler } from "express";
import type { AddressInfo } from "node:net";

const flags = vi.hoisted(() => ({ launch: false, console: false }));
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get(target, key) {
        if (key === "OWNER_LAUNCH_ENABLED") return flags.launch;
        if (key === "OWNER_LAUNCH_ALLOWED_PRIVY_USER_IDS") return "did:privy:owner";
        if (key === "BUYER_CONSOLE_ENABLED") return flags.console;
        if (key === "BUYER_CONSOLE_ALLOWED_PRIVY_USER_IDS") return "did:privy:owner";
        return target[key as keyof typeof target];
      },
    }),
  };
});
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

import { ApiError } from "../errors.js";
import { capabilitiesRouter } from "./capabilities.js";

const app = express().use(capabilitiesRouter);
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
const get = (path: string, token?: string) =>
  fetch(`${base}${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : {});

describe("capabilities", () => {
  it("public: reports restricted launch and console when switched on", async () => {
    flags.launch = true;
    flags.console = true;
    const body = (await (await get("/capabilities")).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ownerLaunch: "restricted", buyerConsole: "restricted" });
  });

  it("per account: the allow-listed owner may launch and run; a stranger gets reasons", async () => {
    flags.launch = true;
    flags.console = true;
    expect(await (await get("/me/capabilities", "owner")).json()).toEqual({
      canLaunch: true,
      canRunBuyerConsole: true,
    });
    const stranger = (await (await get("/me/capabilities", "stranger")).json()) as Record<
      string,
      unknown
    >;
    expect(stranger).toMatchObject({ canLaunch: false, canRunBuyerConsole: false });
    expect(stranger.launchReason).toMatch(/not permitted/);
    expect(stranger.buyerConsoleReason).toMatch(/not permitted/);
  });

  it("explains switched-off features and requires sign-in for the per-account view", async () => {
    flags.launch = false;
    flags.console = false;
    const owner = (await (await get("/me/capabilities", "owner")).json()) as Record<
      string,
      unknown
    >;
    expect(owner.launchReason).toMatch(/switched off/);
    expect(owner.buyerConsoleReason).toMatch(/switched off/);
    expect((await get("/me/capabilities")).status).toBe(401);
  });
});
