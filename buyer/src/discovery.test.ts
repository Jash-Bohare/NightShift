import { describe, expect, it, vi } from "vitest";
import { testPublicKey } from "./test-crypto.js";
import type { BuyerConfig } from "./config.js";
import {
  discoverDirectory,
  verifyDirectoryCandidates,
  type DirectoryHint,
  type EnsReader,
} from "./discovery.js";

const resolver = "0x1111111111111111111111111111111111111111" as const;
const owner = "0x2222222222222222222222222222222222222222" as const;
const config: BuyerConfig = {
  serverUrl: "http://localhost:8787",
  buyerAccountId: "0.0.100",
  buyerPrivateKey: "1".repeat(64),
  quoteVerifyPublicKey: testPublicKey,
  sepoliaRpcUrl: "http://localhost:8545",
  registrarAddress: resolver,
  userRegistryAddress: owner,
  mirrorUrl: "http://localhost:5551",
};
const rules = {
  maxPerJobAtomic: "100000",
  dailyBudgetAtomic: "1000000",
  allowedAssets: ["0.0.429274"],
  allowedNetworks: ["hedera:testnet"],
  allowParentNames: ["nightshift.eth"],
  minSuccess: 0.9,
  humanApprovalAboveAtomic: "500000",
};

function candidate(label = "worker"): DirectoryHint {
  return {
    label,
    ensName: `${label}.nightshift.eth`,
    owner,
    resolver,
    skill: "transcribe:ta",
    price: { amount: "30000" },
    reputation: { jobs: 1, success: 1, p50_ms: 10 },
    status: "active",
  };
}

function ens(overrides: Partial<EnsReader> = {}): EnsReader {
  return {
    chainId: async () => 11155111,
    registrarRegistry: async () => owner,
    registrarResolver: async () => resolver,
    ensResolver: async () => resolver,
    registryStatus: async () => 2,
    registryExpiry: async () => 2_000n,
    registryOwner: async () => owner,
    text: async (_name, key) =>
      ({
        "nightshift.skill": "transcribe:ta",
        "nightshift.price":
          '{"amount":"30000","asset":"0.0.429274","network":"hedera:testnet","unit":"minute"}',
        "nightshift.payto": "0.0.100",
        "agent-endpoint[x402]": "http://localhost:8787/a/worker/run",
        "nightshift.reputation": '{"jobs":1,"success":1,"p50_ms":10}',
      })[key] ?? null,
    ...overrides,
  };
}

describe("ENS worker discovery", () => {
  it("authenticates registry, resolver, owner, records, and Sepolia chain", async () => {
    const result = await verifyDirectoryCandidates(config, [candidate()], "transcribe:ta", rules, {
      ens: ens(),
      now: () => 1_000,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      ensName: "worker.nightshift.eth",
      owner,
      resolver,
      expiry: "2000",
      payTo: "0.0.100",
    });
  });

  it("rejects expired registrations and does not trust directory expiry", async () => {
    const result = await verifyDirectoryCandidates(config, [candidate()], "transcribe:ta", rules, {
      ens: ens({ registryExpiry: async () => 999n }),
      now: () => 1_000_000,
    });
    expect(result).toHaveLength(0);
  });

  it("rejects resolver, owner, and Sepolia-chain mismatches", async () => {
    const resolverMismatch = await verifyDirectoryCandidates(
      config,
      [candidate()],
      "transcribe:ta",
      rules,
      { ens: ens({ ensResolver: async () => owner }) },
    );
    expect(resolverMismatch).toHaveLength(0);

    const directoryResolverMismatch = await verifyDirectoryCandidates(
      config,
      [{ ...candidate(), resolver: owner }],
      "transcribe:ta",
      rules,
      { ens: ens() },
    );
    expect(directoryResolverMismatch).toHaveLength(0);

    const ownerMismatch = await verifyDirectoryCandidates(
      config,
      [candidate()],
      "transcribe:ta",
      rules,
      { ens: ens({ registryOwner: async () => resolver }) },
    );
    expect(ownerMismatch).toHaveLength(0);

    await expect(
      verifyDirectoryCandidates(config, [candidate()], "transcribe:ta", rules, {
        ens: ens({ chainId: async () => 1 }),
      }),
    ).rejects.toThrow(/Sepolia/);
  });

  it("fetches real directory pages and refuses a truncated scan", async () => {
    const page = (number: number, label: string) => ({
      agents: [candidate(label)],
      total: 2,
      page: number,
      limit: 1,
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(page(1, "worker"))))
      .mockResolvedValueOnce(new Response(JSON.stringify(page(2, "scribe"))));
    const result = await discoverDirectory(config, "transcribe:ta", { fetcher });
    expect(result.map((agent) => agent.label)).toEqual(["worker", "scribe"]);
    expect(fetcher).toHaveBeenCalledTimes(2);

    await expect(
      discoverDirectory(config, "transcribe:ta", {
        fetcher: vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            new Response(JSON.stringify({ agents: [], total: 1001, page: 1, limit: 100 })),
          ),
      }),
    ).rejects.toThrow(/incomplete scan/);
  });
});
