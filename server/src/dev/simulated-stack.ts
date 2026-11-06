// SIMULATED LOCAL STACK — for teammate integration QA. Starts:
//   * a local SIMULATED x402 facilitator   (127.0.0.1, random port; never signs or submits)
//   * a local SIMULATED 0G Router           (127.0.0.1:8403; returns a labelled fake transcript)
//   * the REAL NightShift server on :8787 with NIGHTSHIFT_SIMULATION=true (in-memory database)
// Worker identities are seeded from LIVE Sepolia with READ-ONLY calls (no key, no transaction), so
// ENS/registry verification is real. Money, 0G, HCS and the database are simulated.
//
// Every safety-relevant variable is FORCED below, overriding any .env on disk, so production keys
// can never be used by this process. Only SEPOLIA_RPC_URL, PRIVY_APP_ID, PRIVY_APP_SECRET and
// SIMULATED_OWNER_PRIVY_USER_ID may be supplied by the caller.
import express from "express";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { SimulatedFacilitator } from "../e2e/harness.js";
import { STACK_INFO_PATH } from "./stack-info.js";

const ZG_PORT = 8403;
const SERVER_PORT = 8787; // must match the agents' on-chain agent-endpoint[x402] records
const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";

const WORKERS = [
  // label, daily 0G cap (micro-USD). kural's 1 micro-USD cap reproduces the refusal → fallback demo.
  { label: "tamil-scribe", capUsdMicro: 500_000 },
  { label: "kural", capUsdMicro: 1 },
  { label: "chennai-ears", capUsdMicro: 500_000 },
];

async function startSimulatedZg(): Promise<void> {
  const app = express();
  let requests = 0;
  app.get("/models", (_req, res) => {
    res.json({
      data: [{ id: "whisper-large-v3", pricing_usd: { prompt: "0.00013", completion: "0" } }],
    });
  });
  app.post("/audio/transcriptions", (req, res) => {
    req.resume();
    req.on("end", () => {
      requests++;
      res.json({
        text: "[SIMULATED 0G transcript — no inference was run] வணக்கம், இது ஒரு சோதனை.",
        x_0g_trace: {
          request_id: `SIMULATED-0G-${requests}`,
          provider: "simulated-provider",
          billing: { currency: "usd", input_cost: "12480", output_cost: "0", total_cost: "12480" },
        },
      });
    });
  });
  await new Promise<void>((resolve) => app.listen(ZG_PORT, "127.0.0.1", () => resolve()));
}

function forceSafeEnvironment(facilitatorUrl: string): string {
  const quote = generateKeyPairSync("ed25519");
  const publicKey = quote.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const forced: Record<string, string> = {
    NODE_ENV: "development",
    PORT: String(SERVER_PORT),
    NIGHTSHIFT_SIMULATION: "true",
    CRONS_ENABLED: "false",
    PAYOUTS_ENABLED: "false",
    HCS_SUBMIT_ENABLED: "false",
    BUYER_CONSOLE_ENABLED: "false",
    PUBLIC_SERVER_URL: `http://localhost:${SERVER_PORT}`,
    PUBLIC_WEB_URL: "http://localhost:3000",
    WEB_ORIGIN: "http://localhost:3000",
    SECRETS_MASTER_KEY: randomBytes(32).toString("hex"),
    NIGHTSHIFT_QUOTE_SIGNING_PRIVATE_KEY: quote.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
    NIGHTSHIFT_QUOTE_VERIFY_PUBLIC_KEY: publicKey,
    ZG_ROUTER_URL: `http://127.0.0.1:${ZG_PORT}`,
    ZG_TEAM_SK_KEY: "sk-simulated-not-a-key",
    ZG_WHISPER_MODEL: "whisper-large-v3",
    ZG_CHAT_MODEL: "simulated-chat",
    HEDERA_OPERATOR_ID: "0.0.7000099",
    HEDERA_OPERATOR_KEY: `0x${randomBytes(32).toString("hex")}`,
    HEDERA_USDC_TOKEN_ID: "0.0.429274",
    HEDERA_HCS_TOPIC_ID: "0.0.11129931",
    // Health checks only READ the public Mirror Node; the buyer never uses it in simulation.
    HEDERA_MIRROR_URL: "https://testnet.mirrornode.hedera.com",
    TREASURY_ACCOUNT_ID: "0.0.7000099",
    X402_FACILITATOR_URL: facilitatorUrl,
    SEPOLIA_RPC_URL: SEPOLIA_RPC,
    ENS_OPERATOR_PRIVATE_KEY: `0x${randomBytes(32).toString("hex")}`,
    SUPABASE_URL: "http://127.0.0.1:9/simulated-database",
    SUPABASE_SERVICE_ROLE_KEY: "simulated-not-a-service-role-key",
    UPLOAD_MAX_PER_MINUTE: "60",
  };
  for (const [key, value] of Object.entries(forced)) process.env[key] = value;
  for (const key of [
    "SEPOLIA_LOGS_RPC_URL",
    "ZG_TEAM_MK_KEY",
    "BUYER_CONSOLE_ALLOWED_PRIVY_USER_IDS",
  ])
    delete process.env[key];
  return publicKey;
}

async function seedFromSepolia(): Promise<string[]> {
  const { createEnsReader } = await import("@nightshift/buyer");
  const { deployment, env } = await import("../config.js");
  const { simulatedDatabase } = await import("../testing/fake-supabase.js");
  const { encrypt } = await import("../crypto.js");
  const db = simulatedDatabase();
  const ens = createEnsReader({
    serverUrl: env.PUBLIC_SERVER_URL,
    quoteVerifyPublicKey: env.NIGHTSHIFT_QUOTE_VERIFY_PUBLIC_KEY,
    sepoliaRpcUrl: SEPOLIA_RPC,
    registrarAddress: deployment.nightshiftRegistrar as `0x${string}`,
    userRegistryAddress: deployment.userRegistry as `0x${string}`,
    mirrorUrl: env.HEDERA_MIRROR_URL,
  });
  const ownerPrivyId = process.env.SIMULATED_OWNER_PRIVY_USER_ID ?? "did:privy:simulatedowner";
  const seeded: string[] = [];
  for (const [index, worker] of WORKERS.entries()) {
    const name = `${worker.label}.${deployment.parentName}`;
    const [owner, resolver, status, expiry, priceText, payTo, skill, endpoint, reputation] =
      await Promise.all([
        ens.registryOwner(worker.label),
        ens.registrarResolver(worker.label),
        ens.registryStatus(worker.label),
        ens.registryExpiry(worker.label),
        ens.text(name, "nightshift.price"),
        ens.text(name, "nightshift.payto"),
        ens.text(name, "nightshift.skill"),
        ens.text(name, "agent-endpoint[x402]"),
        ens.text(name, "nightshift.reputation"),
      ]);
    const price = JSON.parse(priceText ?? "{}") as { amount?: string; unit?: string };
    if (status !== 2 || !price.amount || !payTo || !skill) {
      console.warn(
        `[simulated-stack] skipping ${name}: not registered or records incomplete on Sepolia`,
      );
      continue;
    }
    const ownerId = `00000000-0000-4000-8000-00000000000${index + 1}`;
    const agentId = `10000000-0000-4000-8000-00000000000${index + 1}`;
    const expiryIso = new Date(Number(expiry) * 1000).toISOString();
    db.seed("owners", [
      {
        id: ownerId,
        privy_user_id: index === 0 ? ownerPrivyId : `did:privy:simulated${index}`,
        evm_address: owner,
      },
    ]);
    db.seed("agents", [
      {
        id: agentId,
        owner_id: ownerId,
        label: worker.label,
        ens_name: name,
        skill,
        model: "whisper-large-v3",
        price_atomic: Number(price.amount),
        price_unit: price.unit ?? "minute",
        daily_cap_usd_micro: worker.capUsdMicro,
        status: "active",
        hedera_account_id: payTo,
        resolver_address: resolver,
        expiry: expiryIso,
      },
    ]);
    db.seed("agent_secrets", [
      {
        agent_id: agentId,
        zg_api_key_enc: encrypt("sk-simulated-not-a-key", env.SECRETS_MASTER_KEY),
        zg_mgmt_key_enc: null,
        hedera_private_key_enc: encrypt("simulated", env.SECRETS_MASTER_KEY),
      },
    ]);
    db.seed("directory", [
      {
        label: worker.label,
        ens_name: name,
        owner,
        resolver,
        skill,
        price_atomic: Number(price.amount),
        price_unit: price.unit ?? "minute",
        payto: payTo,
        endpoint,
        model: "whisper-large-v3",
        description: "Seeded from live Sepolia records (simulated stack)",
        reputation: reputation ? JSON.parse(reputation) : null,
        status: "active",
        expiry: expiryIso,
        updated_at: new Date().toISOString(),
      },
    ]);
    seeded.push(
      `${name} (pay-to ${payTo}, ${price.amount} atomic/${price.unit}, expires ${expiryIso.slice(0, 10)})`,
    );
  }
  return seeded;
}

const facilitator = new SimulatedFacilitator();
await facilitator.start();
await startSimulatedZg();
const quotePublicKey = forceSafeEnvironment(facilitator.url);
const seeded = await seedFromSepolia();
writeFileSync(
  STACK_INFO_PATH,
  JSON.stringify(
    {
      serverUrl: `http://localhost:${SERVER_PORT}`,
      quoteVerifyPublicKey: quotePublicKey,
      sepoliaRpcUrl: SEPOLIA_RPC,
    },
    null,
    2,
  ),
);
console.log("\n=== NIGHTSHIFT SIMULATED STACK — NO REAL PAYMENTS, 0G CALLS OR HCS MESSAGES ===");
console.log(`facilitator (SIMULATED): ${facilitator.url}`);
console.log(`0G router   (SIMULATED): http://127.0.0.1:${ZG_PORT}`);
console.log(`database    (SIMULATED, in-memory, resets on restart)`);
console.log(`Sepolia     (LIVE, read-only): ${SEPOLIA_RPC}`);
console.log(
  `workers seeded from Sepolia:\n  ${seeded.join("\n  ") || "(none — check Sepolia connectivity)"}`,
);
console.log(
  `owner Privy id for /dashboard: ${process.env.SIMULATED_OWNER_PRIVY_USER_ID ?? "did:privy:simulatedowner"} (owns tamil-scribe)\n`,
);
await import("../index.js");
