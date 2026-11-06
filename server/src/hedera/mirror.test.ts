import { describe, expect, it } from "vitest";
import { checkPayoutAccount } from "./mirror.js";

function fakeFetch(routes: Record<string, { status: number; body?: unknown }>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const key = Object.keys(routes).find((path) => url.endsWith(path));
    if (!key) throw new Error(`unexpected ${url}`);
    const r = routes[key]!;
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
}

const USDC = "0.0.429274";

describe("checkPayoutAccount", () => {
  it("accepts unlimited auto-association without a token lookup", async () => {
    const f = fakeFetch({
      "/api/v1/accounts/0.0.5": {
        status: 200,
        body: { account: "0.0.5", deleted: false, max_automatic_token_associations: -1 },
      },
    });
    expect(await checkPayoutAccount("0.0.5", USDC, f)).toEqual({ ok: true });
  });

  it("accepts an explicit USDC association and refuses a missing one", async () => {
    const account = {
      status: 200,
      body: { account: "0.0.5", deleted: false, max_automatic_token_associations: 0 },
    };
    const yes = fakeFetch({
      "/api/v1/accounts/0.0.5": account,
      [`/tokens?token.id=${USDC}`]: { status: 200, body: { tokens: [{ token_id: USDC }] } },
    });
    const no = fakeFetch({
      "/api/v1/accounts/0.0.5": account,
      [`/tokens?token.id=${USDC}`]: { status: 200, body: { tokens: [] } },
    });
    expect(await checkPayoutAccount("0.0.5", USDC, yes)).toEqual({ ok: true });
    expect(await checkPayoutAccount("0.0.5", USDC, no)).toEqual({
      ok: false,
      reason: "not_associated",
    });
  });

  it("reports missing and deleted accounts, and throws on mirror errors", async () => {
    expect(
      await checkPayoutAccount(
        "0.0.5",
        USDC,
        fakeFetch({ "/api/v1/accounts/0.0.5": { status: 404 } }),
      ),
    ).toEqual({ ok: false, reason: "not_found" });
    expect(
      await checkPayoutAccount(
        "0.0.5",
        USDC,
        fakeFetch({
          "/api/v1/accounts/0.0.5": {
            status: 200,
            body: { account: "0.0.5", deleted: true, max_automatic_token_associations: -1 },
          },
        }),
      ),
    ).toEqual({ ok: false, reason: "deleted" });
    await expect(
      checkPayoutAccount("0.0.5", USDC, fakeFetch({ "/api/v1/accounts/0.0.5": { status: 500 } })),
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe("usdcBalance", () => {
  it("reads the USDC balance and treats no relationship as zero", async () => {
    const { usdcBalance } = await import("./mirror.js");
    const path = `/api/v1/accounts/0.0.5/tokens?token.id=${USDC}`;
    expect(
      await usdcBalance(
        "0.0.5",
        USDC,
        fakeFetch({
          [path]: { status: 200, body: { tokens: [{ token_id: USDC, balance: 940000 }] } },
        }),
      ),
    ).toBe(940_000n);
    expect(
      await usdcBalance(
        "0.0.5",
        USDC,
        fakeFetch({ [path]: { status: 200, body: { tokens: [] } } }),
      ),
    ).toBe(0n);
    await expect(
      usdcBalance("0.0.5", USDC, fakeFetch({ [path]: { status: 404 } })),
    ).rejects.toThrow(/not found/);
  });
});
