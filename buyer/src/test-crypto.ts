import { generateKeyPairSync, sign } from "node:crypto";

const pair = generateKeyPairSync("ed25519");
export const testPrivateKey = pair.privateKey
  .export({ format: "der", type: "pkcs8" })
  .toString("base64");
export const testPublicKey = pair.publicKey
  .export({ format: "der", type: "spki" })
  .toString("base64");

export function signTestToken(payload: unknown): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(null, Buffer.from(encoded), pair.privateKey).toString("base64url")}`;
}

export function jobStatusToken(jobId: string): string {
  const now = Math.floor(Date.now() / 1000);
  return signTestToken({
    v: 1,
    type: "nightshift-job-status",
    jobId,
    iat: now,
    exp: now + 1800,
  });
}

export function signedQuoteToken(overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return signTestToken({
    v: 1,
    type: "nightshift-quote",
    agentId: "50baf702-1284-4d60-8ce6-39b905598d98",
    label: "worker",
    ensName: "worker.nightshift.eth",
    units: 2,
    amount: "60000",
    asset: "0.0.429274",
    network: "hedera:testnet",
    payTo: "0.0.100",
    unit: "minute",
    status: "active",
    iat: now,
    exp: now + 120,
    nonce: "07e6b328-9630-4bdb-b52a-2908519b0a7d",
    ...overrides,
  });
}
