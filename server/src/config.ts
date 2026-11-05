// Loads the repo-root .env, validates it with zod, and loads the Sepolia deployment record.
import { readFileSync } from "node:fs";
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Node's 250 ms per-address connect budget is too short on WSL (IPv6 unreachable,
// IPv4 handshake to Alchemy ~2.5 s), so outbound fetch fails without this. See docs/07.
setDefaultAutoSelectFamilyAttemptTimeout(5_000);

const ROOT = new URL("../../", import.meta.url);
const ENV_PATH = fileURLToPath(new URL(".env", ROOT));
const DEPLOYMENT_PATH = fileURLToPath(new URL("contracts/deployments/sepolia.json", ROOT));

try {
  process.loadEnvFile(ENV_PATH);
} catch {
  // Hosted deploys pass env vars directly; a missing file is fine.
}

const hederaId = z.string().regex(/^0\.0\.\d+$/, "expected a Hedera id like 0.0.123");
const hex32Key = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected a 0x-prefixed 32-byte hex key");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8787),
  PUBLIC_SERVER_URL: z.url(),
  PUBLIC_WEB_URL: z.url(),
  WEB_ORIGIN: z.url(),
  SECRETS_MASTER_KEY: z.string().regex(/^[0-9a-f]{64}$/, "openssl rand -hex 32"),

  ZG_ROUTER_URL: z.url(),
  ZG_TEAM_SK_KEY: z.string().startsWith("sk-"),
  ZG_TEAM_MK_KEY: z.string().startsWith("mk-").optional(),
  ZG_WHISPER_MODEL: z.string().min(1),
  ZG_CHAT_MODEL: z.string().min(1),

  HEDERA_OPERATOR_ID: hederaId,
  HEDERA_OPERATOR_KEY: hex32Key,
  HEDERA_USDC_TOKEN_ID: hederaId,
  HEDERA_HCS_TOPIC_ID: hederaId,
  HEDERA_MIRROR_URL: z.url(),
  TREASURY_ACCOUNT_ID: hederaId,
  X402_FACILITATOR_URL: z.url(),

  SEPOLIA_RPC_URL: z.url(),
  ENS_OPERATOR_PRIVATE_KEY: hex32Key,

  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
});

const DeploymentSchema = z.object({
  chainId: z.literal(11155111),
  deployBlock: z.number().int(),
  nightshiftRegistrar: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  operator: z.string(),
  parentName: z.string(),
  userRegistry: z.string(),
});

// Treat blank values and the `0.0.` placeholder from .env.example as unset.
function cleanEnv(raw: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (v && v !== "0.0.") out[k] = v;
  return out;
}

function load() {
  const parsed = EnvSchema.safeParse(cleanEnv(process.env));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`[config] invalid environment:\n${issues.join("\n")}`);
  }
  const deployment = DeploymentSchema.parse(JSON.parse(readFileSync(DEPLOYMENT_PATH, "utf8")));
  return { env: parsed.data, deployment };
}

export const { env, deployment } = load();
export type Env = typeof env;
