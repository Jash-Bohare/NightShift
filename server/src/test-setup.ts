import { generateKeyPairSync } from "node:crypto";

process.env.NODE_ENV = "test";
const quoteKeys = generateKeyPairSync("ed25519");
process.env.NIGHTSHIFT_QUOTE_SIGNING_PRIVATE_KEY = quoteKeys.privateKey
  .export({ format: "der", type: "pkcs8" })
  .toString("base64");
process.env.NIGHTSHIFT_QUOTE_VERIFY_PUBLIC_KEY = quoteKeys.publicKey
  .export({ format: "der", type: "spki" })
  .toString("base64");

const defaults: Record<string, string> = {
  PUBLIC_SERVER_URL: "http://localhost:8787",
  PUBLIC_WEB_URL: "http://localhost:3000",
  WEB_ORIGIN: "http://localhost:3000",
  SECRETS_MASTER_KEY: "0".repeat(64),
  ZG_ROUTER_URL: "http://localhost:1",
  ZG_TEAM_SK_KEY: "sk-test",
  ZG_WHISPER_MODEL: "test-model",
  ZG_CHAT_MODEL: "test-model",
  HEDERA_OPERATOR_ID: "0.0.100",
  HEDERA_OPERATOR_KEY: `0x${"1".repeat(64)}`,
  HEDERA_USDC_TOKEN_ID: "0.0.429274",
  HEDERA_HCS_TOPIC_ID: "0.0.500",
  HEDERA_MIRROR_URL: "http://localhost:1",
  TREASURY_ACCOUNT_ID: "0.0.100",
  X402_FACILITATOR_URL: "http://localhost:1",
  PAYOUTS_ENABLED: "false",
  BUYER_CONSOLE_ENABLED: "true",
  BUYER_CONSOLE_ALLOWED_PRIVY_USER_IDS: "did:privy:testuser",
  PRIVY_APP_ID: "test-privy-app",
  PRIVY_APP_SECRET: "test-privy-secret",
  SEPOLIA_RPC_URL: "http://localhost:1",
  ENS_OPERATOR_PRIVATE_KEY: `0x${"2".repeat(64)}`,
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key-not-a-secret",
};
for (const [name, value] of Object.entries(defaults)) process.env[name] = value;
