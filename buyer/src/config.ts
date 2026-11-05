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

export interface BuyerConfig {
  serverUrl: string;
  buyerAccountId: string;
  buyerPrivateKey: string;
  sepoliaRpcUrl: string;
  registrarAddress: Address;
  zgRouterUrl: string;
  /** Buyer's own 0G key; falls back to the team key when BUYER_ZG_SK_KEY is empty. */
  zgApiKey: string;
  zgChatModel: string;
}

function need(name: string): string {
  const v = process.env[name];
  if (!v || v === "0.0.") throw new Error(`missing env ${name} (see .env.example)`);
  return v;
}

export function loadBuyerConfig(overrides: Partial<BuyerConfig> = {}): BuyerConfig {
  const deployment = JSON.parse(readFileSync(DEPLOYMENT_PATH, "utf8")) as {
    nightshiftRegistrar: Address;
  };
  return {
    serverUrl: overrides.serverUrl ?? need("BUYER_SERVER_URL"),
    buyerAccountId: overrides.buyerAccountId ?? need("BUYER_HEDERA_ACCOUNT_ID"),
    buyerPrivateKey: overrides.buyerPrivateKey ?? need("BUYER_HEDERA_PRIVATE_KEY"),
    sepoliaRpcUrl: overrides.sepoliaRpcUrl ?? need("SEPOLIA_RPC_URL"),
    registrarAddress: overrides.registrarAddress ?? deployment.nightshiftRegistrar,
    zgRouterUrl: overrides.zgRouterUrl ?? need("ZG_ROUTER_URL"),
    zgApiKey: overrides.zgApiKey ?? (process.env.BUYER_ZG_SK_KEY || need("ZG_TEAM_SK_KEY")),
    zgChatModel: overrides.zgChatModel ?? need("ZG_CHAT_MODEL"),
  };
}
