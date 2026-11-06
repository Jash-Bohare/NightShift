import { afterEach, describe, expect, it, vi } from "vitest";
import { runPreflight } from "./preflight.js";
import type { BuyerPublicConfig } from "./config.js";
import { testPublicKey } from "./test-crypto.js";

const required = [
  "BUYER_SERVER_URL",
  "SEPOLIA_RPC_URL",
  "HEDERA_MIRROR_URL",
  "NIGHTSHIFT_QUOTE_VERIFY_PUBLIC_KEY",
] as const;
const paymentCredentials = ["BUYER_HEDERA_ACCOUNT_ID", "BUYER_HEDERA_PRIVATE_KEY"] as const;
const allEnvironment = [...required, ...paymentCredentials];
const saved = new Map<string, string | undefined>();

afterEach(() => {
  for (const name of allEnvironment) {
    const value = saved.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
  vi.unstubAllGlobals();
});

describe("read-only buyer preflight", () => {
  it("reports missing configuration without making network or payment requests", async () => {
    for (const name of allEnvironment) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
    const fetcher = vi.fn<typeof fetch>();
    const report = await runPreflight({ fetcher });
    expect(report.exitCode).toBe(2);
    expect(report.checks.some((check) => check.status === "NOT CONFIGURED")).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses only GET health, directory, and mirror requests and never builds payment", async () => {
    for (const name of allEnvironment) saved.set(name, process.env[name]);
    process.env.BUYER_SERVER_URL = "http://nightshift.example";
    process.env.SEPOLIA_RPC_URL = "http://rpc.example";
    process.env.HEDERA_MIRROR_URL = "http://mirror.example";
    process.env.NIGHTSHIFT_QUOTE_VERIFY_PUBLIC_KEY = testPublicKey;
    delete process.env.BUYER_HEDERA_ACCOUNT_ID;
    delete process.env.BUYER_HEDERA_PRIVATE_KEY;

    const userRegistryAddress = "0x2222222222222222222222222222222222222222" as const;
    const publicConfig: BuyerPublicConfig = {
      serverUrl: "http://nightshift.example",
      quoteVerifyPublicKey: testPublicKey,
      sepoliaRpcUrl: "http://rpc.example",
      registrarAddress: "0x1111111111111111111111111111111111111111",
      userRegistryAddress,
      mirrorUrl: "http://mirror.example",
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/health")) return new Response(JSON.stringify({ ok: true }));
      if (url.includes("/directory?"))
        return new Response(JSON.stringify({ agents: [], total: 0, page: 1, limit: 100 }));
      if (url.includes("/jobs/") && url.endsWith("/status"))
        return new Response("unauthorized", { status: 401 });
      if (url.includes("/api/v1/network/nodes")) return new Response(JSON.stringify({ nodes: [] }));
      throw new Error(`unexpected preflight request: ${url} ${init?.method ?? "GET"}`);
    });
    const rpcFetch = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { method: string };
      const result =
        request.method === "eth_chainId"
          ? "0xaa36a7"
          : request.method === "eth_call"
            ? `0x${userRegistryAddress.slice(2).padStart(64, "0")}`
            : "0x6000";
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", rpcFetch);

    const report = await runPreflight({ fetcher, publicConfig });
    expect(
      report.checks.find((check) => check.name === "Sepolia RPC and deployments")?.status,
    ).toBe("PASS");
    expect(fetcher.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
    expect(
      fetcher.mock.calls.every(([, init]) => !new Headers(init?.headers).has("PAYMENT-SIGNATURE")),
    ).toBe(true);
    expect(rpcFetch.mock.calls.every(([, init]) => !String(init?.body).includes("payment"))).toBe(
      true,
    );
    expect(report.exitCode).toBe(2);
  });
});
