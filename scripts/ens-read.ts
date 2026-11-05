// Reads an agent's ENS records through viem's Universal Resolver path (same as buyers will).
// Run: pnpm -C scripts exec tsx ens-read.ts hello2.nightshift.eth
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import { normalize } from "viem/ens";
import { OWNER_KEYS, REPUTATION_KEY } from "@nightshift/shared";
import { need } from "./env.js";

const name = normalize(process.argv[2] ?? "hello2.nightshift.eth");
const client = createPublicClient({
  chain: sepolia,
  transport: http(need("SEPOLIA_RPC_URL"), { timeout: 30_000 }),
});

async function main() {
  console.log(`[ens] ${name} resolver = ${await client.getEnsResolver({ name })}`);
  for (const key of [...OWNER_KEYS, REPUTATION_KEY]) {
    const value = await client.getEnsText({ name, key });
    if (value) console.log(`[ens] ${key} = ${value}`);
  }
}

main().catch((err) => {
  console.error("[ens] read failed:", err);
  process.exit(1);
});
