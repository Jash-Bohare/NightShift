// P3.4: seed the 3 demo agents the buyer compares (docs/05 § Demo data). Idempotent:
//   - a free label is launched for real (Sepolia name + resolver, Hedera account, encrypted keys);
//   - an existing agent gets its daily cap reset to the spec (so test edits never linger);
//   - finally every agent is (re)indexed into the directory from ENS.
//   tamil-scribe  0.03 USDC/min, cap $0.50/day   the expected winner
//   kural         0.02 USDC/min, cap 1 micro-USD cheapest, but its budget guard always refuses (503)
//   chennai-ears  0.05 USDC/min, cap $0.50/day   premium fallback
// Run: pnpm -C scripts exec tsx seed-agents.ts [--dry-run]
import { parseArgs } from "node:util";
import { ENS_PARENT_NAME, type SkillId } from "@nightshift/shared";

const { values: args } = parseArgs({ options: { "dry-run": { type: "boolean", default: false } } });
const dryRun = args["dry-run"] ?? false;

// Importing the server loads and validates the repo .env.
const { env } = await import("@nightshift/server/config");
const { db } = await import("@nightshift/server/db/client");
const { launchAgent } = await import("@nightshift/server/launch");
const { available } = await import("@nightshift/server/ens");
const { syncAgentToDirectory } = await import("@nightshift/server/ens/indexer");

// Seed data, not product data: the demo owner is Jash's Privy user and embedded wallet.
const OWNER = {
  privyUserId: "did:privy:cmvjrmi8302yr0gjn5m2uvvh2",
  evmAddress: "0x0ABE807747De2ed487e4c56a945B8F5215530ed8",
} as const;

interface SeedSpec {
  label: string;
  skill: SkillId;
  priceAtomic: bigint;
  dailyCapUsdMicro: bigint;
}

const SEEDS: SeedSpec[] = [
  {
    label: "tamil-scribe",
    skill: "transcribe:ta",
    priceAtomic: 30_000n,
    dailyCapUsdMicro: 500_000n,
  },
  { label: "kural", skill: "transcribe:ta", priceAtomic: 20_000n, dailyCapUsdMicro: 1n },
  {
    label: "chennai-ears",
    skill: "transcribe:ta",
    priceAtomic: 50_000n,
    dailyCapUsdMicro: 500_000n,
  },
];

for (const s of SEEDS) {
  const name = `${s.label}.${ENS_PARENT_NAME}`;
  const row = await db
    .from("agents")
    .select("id,status,daily_cap_usd_micro")
    .eq("label", s.label)
    .maybeSingle();
  if (row.error) throw new Error(`[db] ${row.error.message}`);

  if (row.data) {
    const cap = String(row.data.daily_cap_usd_micro);
    console.log(`[seed] ${name}: exists (${row.data.status}), cap ${cap}`);
    if (cap !== s.dailyCapUsdMicro.toString()) {
      console.log(`[seed]   cap ${cap} -> ${s.dailyCapUsdMicro}${dryRun ? " (dry run)" : ""}`);
      if (!dryRun) {
        const up = await db
          .from("agents")
          .update({ daily_cap_usd_micro: s.dailyCapUsdMicro.toString() })
          .eq("id", row.data.id);
        if (up.error) throw new Error(`[db] ${up.error.message}`);
      }
    }
  } else if (!(await available(s.label))) {
    console.log(`[seed] ${name}: taken on-chain but not in our database; skipping`);
    continue;
  } else if (dryRun) {
    console.log(`[seed] ${name}: would launch (price ${s.priceAtomic}, cap ${s.dailyCapUsdMicro})`);
    continue;
  } else {
    console.log(`[seed] ${name}: launching on Sepolia + Hedera testnet...`);
    const res = await launchAgent({
      owner: OWNER,
      label: s.label,
      skill: s.skill,
      priceAtomic: s.priceAtomic,
      dailyCapUsdMicro: s.dailyCapUsdMicro,
      zgApiKey: env.ZG_TEAM_SK_KEY,
      ...(env.ZG_TEAM_MK_KEY ? { zgMgmtKey: env.ZG_TEAM_MK_KEY } : {}),
    });
    console.log(`[seed]   https://sepolia.etherscan.io/tx/${res.registerTx}`);
    console.log(`[seed]   https://hashscan.io/testnet/account/${res.hederaAccount}`);
  }

  if (!dryRun) console.log(`[seed]   directory: ${await syncAgentToDirectory(s.label)}`);
}

const dir = await db
  .from("directory")
  .select("label,status,price_atomic,payto")
  .order("price_atomic");
console.table(dir.data);
process.exit(0);
