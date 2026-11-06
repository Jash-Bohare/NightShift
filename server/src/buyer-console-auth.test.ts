import { describe, expect, it, vi } from "vitest";
import { createBuyerConsoleAuthorizer } from "./buyer-console-auth.js";

const claims = { app_id: "nightshift-app", user_id: "did:privy:operator" };

describe("buyer console Privy authorization", () => {
  it("requires a bearer token before calling Privy", async () => {
    const verify = vi.fn(async () => claims);
    const authorize = createBuyerConsoleAuthorizer(
      verify,
      "nightshift-app",
      new Set([claims.user_id]),
    );

    await expect(authorize(undefined)).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it("rejects invalid tokens and tokens issued for another app", async () => {
    const rejected = createBuyerConsoleAuthorizer(
      async () => {
        throw new Error("signature invalid");
      },
      "nightshift-app",
      new Set([claims.user_id]),
    );
    await expect(rejected("Bearer invalid")).rejects.toMatchObject({ status: 401 });

    const wrongApp = createBuyerConsoleAuthorizer(
      async () => ({ ...claims, app_id: "other-app" }),
      "nightshift-app",
      new Set([claims.user_id]),
    );
    await expect(wrongApp("Bearer valid")).rejects.toMatchObject({ status: 401 });
  });

  it("allows only explicitly allow-listed verified Privy users", async () => {
    const denied = createBuyerConsoleAuthorizer(
      async () => claims,
      "nightshift-app",
      new Set(["did:privy:another-user"]),
    );
    await expect(denied("Bearer valid")).rejects.toMatchObject({ status: 403 });

    const allowed = createBuyerConsoleAuthorizer(
      async () => claims,
      "nightshift-app",
      new Set([claims.user_id]),
    );
    await expect(allowed("Bearer valid")).resolves.toBe(claims.user_id);
  });
});
