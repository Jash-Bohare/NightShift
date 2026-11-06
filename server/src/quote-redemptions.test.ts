import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  used: new Set<string>(),
}));

vi.mock("./db/client.js", () => ({
  db: {
    from: () => ({
      delete: () => ({ lt: async () => ({ error: null }) }),
      insert: async (row: { nonce: string }) => {
        if (state.used.has(row.nonce)) return { error: { code: "23505" } };
        state.used.add(row.nonce);
        return { error: null };
      },
    }),
  },
}));

import { generateKeyPairSync } from "node:crypto";
import { createSignedQuote } from "./quote-signing.js";
import { claimVerifiedQuote } from "./quote-redemptions.js";

const pair = generateKeyPairSync("ed25519");
const privateKey = pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");

describe("one-time quote redemption", () => {
  beforeEach(() => state.used.clear());

  it("allows one verified paid attempt and rejects replay of its nonce", async () => {
    const { claims, token } = createSignedQuote(
      {
        agentId: "50baf702-1284-4d60-8ce6-39b905598d98",
        label: "worker",
        ensName: "worker.nightshift.eth",
        units: 1,
        amount: "30000",
        asset: "0.0.429274",
        network: "hedera:testnet",
        payTo: "0.0.100",
        unit: "minute",
        status: "active",
      },
      privateKey,
    );
    expect(await claimVerifiedQuote(claims, token, claims.agentId)).toBe(true);
    expect(await claimVerifiedQuote(claims, token, claims.agentId)).toBe(false);
  });
});
