import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createJobStatusToken,
  createSignedQuote,
  verifyJobStatusToken,
  verifySignedQuote,
} from "./quote-signing.js";

const pair = generateKeyPairSync("ed25519");
const privateKey = pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
const quoteInput = {
  agentId: "50baf702-1284-4d60-8ce6-39b905598d98",
  label: "worker",
  ensName: "worker.nightshift.eth",
  units: 2,
  amount: "60000",
  asset: "0.0.429274",
  network: "hedera:testnet",
  payTo: "0.0.100",
  unit: "minute",
  status: "active" as const,
};

describe("signed quote tokens", () => {
  it("verifies signed price, identity, network, and expiry claims", () => {
    const { claims, token } = createSignedQuote(quoteInput, privateKey, 1000);
    expect(verifySignedQuote(token, publicKey, 1001)).toEqual(claims);
  });

  it("rejects expired, modified, malformed, and incorrectly signed quotes", () => {
    const { token } = createSignedQuote(quoteInput, privateKey, 1000);
    expect(() => verifySignedQuote(token, publicKey, 1120)).toThrow(/expired/);
    const [payload, signature] = token.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
    claims.amount = "1";
    const changed = Buffer.from(JSON.stringify(claims)).toString("base64url");
    expect(() => verifySignedQuote(`${changed}.${signature}`, publicKey, 1001)).toThrow(
      /signature/,
    );
    expect(() => verifySignedQuote(token, "bad-key", 1001)).toThrow();
    expect(() => verifySignedQuote("broken", publicKey, 1001)).toThrow(/malformed/);
  });

  it("binds a short-lived status capability to one job id", () => {
    const id = "50baf702-1284-4d60-8ce6-39b905598d98";
    const token = createJobStatusToken(id, privateKey, 1000);
    expect(verifyJobStatusToken(token, publicKey, id, 1001).jobId).toBe(id);
    expect(() =>
      verifyJobStatusToken(token, publicKey, "77d434ed-8a69-4f2c-9e90-f0e9ce76c028", 1001),
    ).toThrow(/does not match/);
    expect(() => verifyJobStatusToken(token, publicKey, id, 3000)).toThrow(/expired/);
  });
});
