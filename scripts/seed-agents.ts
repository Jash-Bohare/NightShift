// P3.4: Seed 3 real agents for discovery and comparison (docs/05-buyer-agent.md § Demo data):
// 1. tamil-scribe: 0.03 USDC/min, cap $0.50/day (primary worker)
// 2. kural: 0.02 USDC/min, tiny cap (1 micro-USD) -> triggers 503 over_budget refusal
// 3. chennai-ears: 0.05 USDC/min, cap $0.50/day (higher price alternative)
//
// Run: pnpm -C scripts exec tsx seed-agents.ts [--dry-run]

import { parseArgs } from "node:util";
import { ENS_PARENT_NAME } from "@nightshift/shared";
import { isAddress } from "viem";

const { values: args } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
  },
});

// Import server modules (loads .env)
const { env, deployment } = await import("@nightshift/server/config");
const { db } = await import("@nightshift/server/db/client");
const { launchAgent } = await import("@nightshift/server/launch");
const { available, sepoliaClient } = await import("@nightshift/server/ens");
const { runIndexer, syncAgentToDirectory } = await import("@nightshift/server/ens/indexer");

const OWNER_PRIVY = "did:privy:cmvjrmi8302yr0gjn5m2uvvh2";
const OWNER_EVM = "0x0ABE807747De2ed487e4c56a945B8F5215530ed8";

interface SeedSpec {
  label: string;
  skill: "transcribe:ta";
  priceAtomic: bigint;
  dailyCapUsdMicro: bigint;
  description: string;
}

const SEED_AGENTS: SeedSpec[] = [
  {
    label: "tamil-scribe",
    skill: "transcribe:ta",
    priceAtomic: 30000n, // 0.03 USDC/min
    dailyCapUsdMicro: 500000n, // $0.50/day
    description: "Transcribes Tamil audio to text. Runs whisper-large-v3 on 0G Compute.",
  },
  {
    label: "kural",
    skill: "transcribe:ta",
    priceAtomic: 20000n, // 0.02 USDC/min (cheaper!)
    dailyCapUsdMicro: 1n, // 1 micro-USD -> triggers 503 over_budget
    description: "Fast Tamil audio scribe with low rate. Runs whisper-large-v3 on 0G.",
  },
  {
    label: "chennai-ears",
    skill: "transcribe:ta",
    priceAtomic: 50000n, // 0.05 USDC/min (premium)
    dailyCapUsdMicro: 500000n, // $0.50/day
    description: "High accuracy Tamil transcription agent on 0G Compute.",
  },
];

async function main() {
  console.log("🌱 Nightshift Agent Seeder (Phase 3.4)");

  for (const spec of SEED_AGENTS) {
    const ensName = `${spec.label}.${ENS_PARENT_NAME}`;
    console.log(`\n--- Agent: ${spec.label} (${ensName}) ---`);

    // Check if agent row already exists
    const existing = await db
      .from("agents")
      .select("id,label,status,hedera_account_id,resolver_address")
      .eq("label", spec.label)
      .maybeSingle();

    if (existing.data && existing.data.status === "active") {
      console.log(`  Agent row exists and active (id ${existing.data.id}, Hedera ${existing.data.hedera_account_id})`);
      // Update daily_cap if spec requires (e.g. kural cap = 1)
      if (spec.label === "kural") {
        await db.from("agents").update({ daily_cap_usd_micro: spec.dailyCapUsdMicro.toString() }).eq("label", spec.label);
      }
      await syncAgentToDirectory(spec.label);
      continue;
    }

    const isAvail = await available(spec.label);
    console.log(`  On-chain availability on Sepolia: ${isAvail}`);

    if (args["dry-run"]) {
      console.log(`  [dry-run] Would launch ${spec.label}: price=${spec.priceAtomic}, cap=${spec.dailyCapUsdMicro}`);
      continue;
    }

    if (isAvail) {
      console.log(`  Launching ${spec.label} on Sepolia and Hedera testnet...`);
      try {
        const res = await launchAgent({
          owner: {
            privyUserId: OWNER_PRIVY,
            evmAddress: OWNER_EVM,
          },
          label: spec.label,
          skill: spec.skill,
          priceAtomic: spec.priceAtomic,
          dailyCapUsdMicro: spec.dailyCapUsdMicro,
          zgApiKey: env.ZG_TEAM_SK_KEY,
          zgMgmtKey: env.ZG_TEAM_MK_KEY,
        });

        console.log(`  ✅ Launched ${res.ensName}`);
        console.log(`     Register Tx: https://sepolia.etherscan.io/tx/${res.registerTx}`);
        console.log(`     Hedera: https://hashscan.io/testnet/account/${res.hederaAccount}`);
        console.log(`     Resolver: ${res.resolver}`);

        await syncAgentToDirectory(spec.label);
      } catch (err) {
        console.error(`  ❌ Failed to launch ${spec.label}:`, err);
      }
    } else {
      console.log(`  Name is already taken on-chain. Syncing directory.`);
      await syncAgentToDirectory(spec.label);
    }
  }

  console.log("\nRunning indexer to verify directory table...");
  const idx = await runIndexer();
  console.log(`Indexer finished: ${idx.indexed} agent(s) indexed.`);

  const dirRows = await db.from("directory").select("label, skill, price_atomic, status");
  console.log("\nCurrent Directory Agents:");
  console.table(dirRows.data);

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal seed error:", err);
  process.exit(1);
});
