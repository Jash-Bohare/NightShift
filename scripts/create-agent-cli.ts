// P2.5: launch an agent without the UI (same code path as POST /me/agents).
// Creates the Hedera account, encrypts keys, registers <label>.nightshift.eth via NightshiftRegistrar,
// inserts owners/agents/agent_secrets rows. Keys are read from env var NAMES, never from argv.
//
//   pnpm -C scripts exec tsx create-agent-cli.ts --label tamil-scribe --skill transcribe:ta \
//     --price 30000 --cap 500000 --owner-privy did:privy:… --owner-evm 0x… \
//     --zg-key-env ZG_TEAM_SK_KEY --zg-mgmt-env ZG_TEAM_MK_KEY [--dry-run]
import { parseArgs } from "node:util";
import { SKILL_IDS, type SkillId } from "@nightshift/shared";
import { isAddress } from "viem";

const { values: a } = parseArgs({
  options: {
    label: { type: "string" },
    skill: { type: "string" },
    price: { type: "string" }, // USDC atomic per unit
    cap: { type: "string" }, // 0G daily cap, micro-USD
    "owner-privy": { type: "string" },
    "owner-evm": { type: "string" },
    "payout-account": { type: "string" },
    "zg-key-env": { type: "string", default: "ZG_TEAM_SK_KEY" },
    "zg-mgmt-env": { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});

function fail(msg: string): never {
  console.error(`[cli] ${msg}`);
  process.exit(1);
}

const label = a.label ?? fail("--label is required");
const skill = (a.skill ?? fail("--skill is required")) as SkillId;
if (!SKILL_IDS.includes(skill)) fail(`--skill must be one of ${SKILL_IDS.join(", ")}`);
if (!/^\d+$/.test(a.price ?? ""))
  fail("--price must be integer USDC atomic units (30000 = 0.03 USDC)");
if (!/^\d+$/.test(a.cap ?? "")) fail("--cap must be integer micro-USD (500000 = $0.50/day)");
const privy = a["owner-privy"] ?? fail("--owner-privy is required");
const evm = a["owner-evm"] ?? fail("--owner-evm is required");
if (!isAddress(evm)) fail("--owner-evm is not an address");

// Importing the server loads and validates the repo .env.
const { launchAgent } = await import("@nightshift/server/launch");
const { available } = await import("@nightshift/server/ens");

const zgApiKey = process.env[a["zg-key-env"]!] ?? fail(`env ${a["zg-key-env"]} is empty`);
const zgMgmtKey = a["zg-mgmt-env"]
  ? (process.env[a["zg-mgmt-env"]] ?? fail(`env ${a["zg-mgmt-env"]} is empty`))
  : undefined;

if (a["dry-run"]) {
  console.log(
    `[cli] dry run: ${label}.nightshift.eth available=${await available(label)} skill=${skill} price=${a.price} cap=${a.cap} owner=${evm}`,
  );
  process.exit(0);
}

const res = await launchAgent({
  owner: {
    privyUserId: privy,
    evmAddress: evm,
    ...(a["payout-account"] ? { hederaPayoutAccount: a["payout-account"] } : {}),
  },
  label,
  skill,
  priceAtomic: BigInt(a.price!),
  dailyCapUsdMicro: BigInt(a.cap!),
  zgApiKey,
  ...(zgMgmtKey ? { zgMgmtKey } : {}),
});
console.log(`[cli] launched ${res.ensName}`);
console.log(`[cli]   agent id   ${res.agentId}`);
console.log(`[cli]   register   https://sepolia.etherscan.io/tx/${res.registerTx}`);
console.log(`[cli]   resolver   ${res.resolver}`);
console.log(`[cli]   hedera     https://hashscan.io/testnet/account/${res.hederaAccount}`);
process.exit(0);
