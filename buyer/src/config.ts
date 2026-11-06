// Buyer configuration: env vars (loaded by the CLI or the host server) + the Sepolia deployment record.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Address } from "viem";

const DEPLOYMENT_PATH = fileURLToPath(
  new URL("../../contracts/deployments/sepolia.json", import.meta.url),
);

/** The demo clip shipped with the repo, resolved independently of the process cwd. */
export const DEFAULT_SAMPLE_FILE = fileURLToPath(
  new URL("../samples/tamil-90s.mp3", import.meta.url),
);

export interface BuyerPublicConfig {
  serverUrl: string;
  quoteVerifyPublicKey: string;
  sepoliaRpcUrl: string;
  registrarAddress: Address;
  userRegistryAddress: Address;
  mirrorUrl: string;
  hcsTopicId?: string;
}

export interface BuyerConfig extends BuyerPublicConfig {
  buyerAccountId: string;
  buyerPrivateKey: string;
}

function need(name: string): string {
  const v = process.env[name];
  if (!v || v === "0.0.") throw new Error(`missing env ${name} (see .env.example)`);
  return v;
}

function requireHttpUrl(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error(`${name} must be an absolute HTTP(S) URL`);
  return value;
}

export function loadBuyerPublicConfig(
  overrides: Partial<BuyerPublicConfig> = {},
): BuyerPublicConfig {
  const deployment = JSON.parse(readFileSync(DEPLOYMENT_PATH, "utf8")) as {
    nightshiftRegistrar: Address;
    userRegistry: Address;
  };
  const serverUrl = requireHttpUrl(
    "BUYER_SERVER_URL",
    overrides.serverUrl ?? need("BUYER_SERVER_URL"),
  );
  const quoteVerifyPublicKey =
    overrides.quoteVerifyPublicKey ?? need("NIGHTSHIFT_QUOTE_VERIFY_PUBLIC_KEY");
  const mirrorUrl = requireHttpUrl(
    "HEDERA_MIRROR_URL",
    overrides.mirrorUrl ?? need("HEDERA_MIRROR_URL"),
  );
  const sepoliaRpcUrl = requireHttpUrl(
    "SEPOLIA_RPC_URL",
    overrides.sepoliaRpcUrl ?? need("SEPOLIA_RPC_URL"),
  );
  return {
    serverUrl: serverUrl.replace(/\/+$/, ""),
    quoteVerifyPublicKey,
    sepoliaRpcUrl,
    registrarAddress: overrides.registrarAddress ?? deployment.nightshiftRegistrar,
    userRegistryAddress: overrides.userRegistryAddress ?? deployment.userRegistry,
    mirrorUrl: mirrorUrl.replace(/\/+$/, ""),
    ...((overrides.hcsTopicId ?? process.env.HEDERA_HCS_TOPIC_ID)
      ? { hcsTopicId: overrides.hcsTopicId ?? process.env.HEDERA_HCS_TOPIC_ID }
      : {}),
  };
}

export function loadBuyerConfig(overrides: Partial<BuyerConfig> = {}): BuyerConfig {
  const publicConfig = loadBuyerPublicConfig(overrides);
  const accountId = overrides.buyerAccountId ?? need("BUYER_HEDERA_ACCOUNT_ID");
  if (!/^0\.0\.\d+$/.test(accountId)) throw new Error("BUYER_HEDERA_ACCOUNT_ID is invalid");
  const privateKey = overrides.buyerPrivateKey ?? need("BUYER_HEDERA_PRIVATE_KEY");
  if (!/^(?:0x)?[0-9a-fA-F]{64}$/.test(privateKey))
    throw new Error("BUYER_HEDERA_PRIVATE_KEY must be a 32-byte ECDSA private key");
  return {
    ...publicConfig,
    buyerAccountId: accountId,
    buyerPrivateKey: privateKey,
  };
}
