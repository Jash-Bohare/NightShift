// Loads the repo-root .env, validates it with zod, and loads the Sepolia deployment record.
import { readFileSync } from "node:fs";
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { validateQuoteKeyPair } from "./quote-signing.js";

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

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().int().positive().default(8787),
    // Number of reverse-proxy hops to trust for req.ip (0 = connect directly, no proxy).
    // SIMULATION MODE (local QA only): in-memory database, loopback x402 facilitator and 0G
    // endpoints, no HCS submission. Refused in production; see STAGING_SETUP.md.
    NIGHTSHIFT_SIMULATION: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    // HCS job-log submission (spends operator HBAR). Disable for QA environments.
    HCS_SUBMIT_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    // Paid-run upload limits (process-local). Defaults suit a single small instance.
    UPLOAD_MAX_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(8),
    UPLOAD_MAX_CONCURRENT_PER_CLIENT: z.coerce.number().int().min(1).max(100).default(2),
    UPLOAD_MAX_CONCURRENT_TOTAL: z.coerce.number().int().min(1).max(1_000).default(8),
    WORKER_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(60),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
    // Scheduled jobs (indexer, reputation writes to Sepolia, settlement recovery) are opt-in.
    // Leave false for local development, QA and staging that share any external resource.
    CRONS_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    PUBLIC_SERVER_URL: z.url(),
    PUBLIC_WEB_URL: z.url(),
    // Browser origin(s) allowed by CORS: one URL or a comma-separated list. Each is normalised to
    // its origin, so "https://x.vercel.app/" (trailing slash) still matches what browsers send.
    WEB_ORIGIN: z
      .string()
      .min(1)
      .transform((value, ctx) => {
        const origins: string[] = [];
        for (const part of value
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean)) {
          try {
            const url = new URL(part);
            if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("protocol");
            origins.push(url.origin);
          } catch {
            ctx.addIssue({ code: "custom", message: `not an http(s) URL: ${part}` });
            return z.NEVER;
          }
        }
        if (origins.length === 0) {
          ctx.addIssue({ code: "custom", message: "at least one origin is required" });
          return z.NEVER;
        }
        return [...new Set(origins)];
      }),
    SECRETS_MASTER_KEY: z.string().regex(/^[0-9a-f]{64}$/, "openssl rand -hex 32"),
    NIGHTSHIFT_QUOTE_SIGNING_PRIVATE_KEY: z.string().min(1),
    NIGHTSHIFT_QUOTE_VERIFY_PUBLIC_KEY: z.string().min(1),

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
    PAYOUTS_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    BUYER_CONSOLE_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    BUYER_CONSOLE_ALLOWED_PRIVY_USER_IDS: z.string().optional(),
    // Owner self-service launch (POST /me/agents). Each launch spends operator Sepolia gas,
    // a 2 HBAR account float and an optional ETH drip, so it is opt-in.
    OWNER_LAUNCH_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    OWNER_MAX_AGENTS: z.coerce.number().int().min(1).max(100).default(3),
    // Sepolia ETH sent to a launching owner whose balance is under 0.002 ETH (0 disables).
    SEPOLIA_DRIP_WEI: z
      .string()
      .regex(/^\d{1,20}$/)
      .default("3000000000000000")
      .transform((value) => BigInt(value)),
    PRIVY_APP_ID: z.string().min(1).optional(),
    PRIVY_APP_SECRET: z.string().min(1).optional(),
    // Optional PEM (SPKI) ES256 key from the Privy dashboard. When set, access tokens are
    // verified locally against it instead of fetching the app JWKS.
    PRIVY_JWT_VERIFICATION_KEY: z.string().min(1).optional(),

    SEPOLIA_RPC_URL: z.url(),
    // eth_getLogs over wide block ranges (Alchemy free tier caps the range); defaults to SEPOLIA_RPC_URL.
    SEPOLIA_LOGS_RPC_URL: z.url().optional(),
    ENS_OPERATOR_PRIVATE_KEY: hex32Key,

    SUPABASE_URL: z.url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  })
  .superRefine((value, ctx) => {
    if (value.NIGHTSHIFT_SIMULATION) {
      const loopback = (url: string) => {
        try {
          return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);
        } catch {
          return false;
        }
      };
      if (value.NODE_ENV === "production")
        ctx.addIssue({
          code: "custom",
          path: ["NIGHTSHIFT_SIMULATION"],
          message: "never allowed in production",
        });
      for (const key of ["X402_FACILITATOR_URL", "ZG_ROUTER_URL"] as const)
        if (!loopback(value[key]))
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: "simulation requires a loopback (local simulated) endpoint",
          });
      if (
        value.HCS_SUBMIT_ENABLED ||
        value.PAYOUTS_ENABLED ||
        value.CRONS_ENABLED ||
        value.BUYER_CONSOLE_ENABLED ||
        value.OWNER_LAUNCH_ENABLED
      )
        ctx.addIssue({
          code: "custom",
          path: ["NIGHTSHIFT_SIMULATION"],
          message:
            "simulation requires HCS_SUBMIT_ENABLED, PAYOUTS_ENABLED, CRONS_ENABLED, BUYER_CONSOLE_ENABLED and OWNER_LAUNCH_ENABLED to be false",
        });
    }
    if (value.PAYOUTS_ENABLED && !value.CRONS_ENABLED)
      ctx.addIssue({
        code: "custom",
        path: ["PAYOUTS_ENABLED"],
        message: "payouts run on the scheduler; set CRONS_ENABLED=true explicitly to use them",
      });
    if (value.OWNER_LAUNCH_ENABLED && (!value.PRIVY_APP_ID || !value.PRIVY_APP_SECRET))
      ctx.addIssue({
        code: "custom",
        path: ["OWNER_LAUNCH_ENABLED"],
        message: "PRIVY_APP_ID and PRIVY_APP_SECRET are required when OWNER_LAUNCH_ENABLED=true",
      });
    if (!value.BUYER_CONSOLE_ENABLED) return;
    if (!value.PRIVY_APP_ID)
      ctx.addIssue({
        code: "custom",
        path: ["PRIVY_APP_ID"],
        message: "required when BUYER_CONSOLE_ENABLED=true",
      });
    if (!value.PRIVY_APP_SECRET)
      ctx.addIssue({
        code: "custom",
        path: ["PRIVY_APP_SECRET"],
        message: "required when BUYER_CONSOLE_ENABLED=true",
      });
    const allowedUsers = value.BUYER_CONSOLE_ALLOWED_PRIVY_USER_IDS?.split(",")
      .map((userId) => userId.trim())
      .filter(Boolean);
    if (
      !allowedUsers?.length ||
      allowedUsers.some((userId) => !/^did:privy:[A-Za-z0-9]+$/.test(userId))
    )
      ctx.addIssue({
        code: "custom",
        path: ["BUYER_CONSOLE_ALLOWED_PRIVY_USER_IDS"],
        message: "a comma-separated allow-list of Privy user IDs is required when enabled",
      });
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
  try {
    validateQuoteKeyPair(
      parsed.data.NIGHTSHIFT_QUOTE_SIGNING_PRIVATE_KEY,
      parsed.data.NIGHTSHIFT_QUOTE_VERIFY_PUBLIC_KEY,
    );
  } catch (error) {
    throw new Error(
      `[config] invalid quote signing key pair: ${error instanceof Error ? error.message : "invalid keys"}`,
      { cause: error },
    );
  }
  const deployment = DeploymentSchema.parse(JSON.parse(readFileSync(DEPLOYMENT_PATH, "utf8")));
  return { env: parsed.data, deployment };
}

export const { env, deployment } = load();
export type Env = typeof env;
