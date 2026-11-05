// CLI interface for the autonomous buyer agent (docs/05-buyer-agent.md).
import { existsSync } from "node:fs";
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { BuyerEvent } from "@nightshift/shared";
import { runBuyer } from "./agent.js";
import { loadRules, loadState } from "./spending.js";

// Ensure Node network timeouts work reliably on WSL
setDefaultAutoSelectFamilyAttemptTimeout(5_000);

// Load root .env
import { fileURLToPath } from "node:url";
const ENV_PATH = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(ENV_PATH)) {
  try {
    process.loadEnvFile(ENV_PATH);
  } catch {}
}

const { values: args } = parseArgs({
  options: {
    skill: { type: "string", default: "transcribe:ta" },
    file: { type: "string" },
    units: { type: "string" },
  },
  allowPositionals: true,
});

const defaultFile = resolve(import.meta.dirname, "../samples/tamil-90s.mp3");
const taskFile = args.file ?? (existsSync(defaultFile) ? defaultFile : undefined);
const taskSkill = args.skill ?? "transcribe:ta";
const taskUnits = args.units ? parseInt(args.units, 10) : undefined;

// Color helpers
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
};

function formatEvent(e: BuyerEvent): string {
  const ts = `${c.dim}[${e.timestamp.slice(11, 19)}]${c.reset}`;
  switch (e.kind) {
    case "plan":
      return `${ts} ${c.blue}PLAN${c.reset} task=${e.task.skill} ${e.task.file ? `file=${basename(e.task.file)}` : ""} maxPerJob=${(Number(e.rules.maxPerJobAtomic) / 1e6).toFixed(2)} USDC`;
    case "discover":
      return `${ts} ${c.cyan}DISCOVER${c.reset} found ${e.candidates.length} candidate(s): ${e.candidates.map((x) => `${x.ensName} ($${(Number(x.priceAtomic) / 1e6).toFixed(2)}/min)`).join(", ")}`;
    case "verify":
      if (e.ok) {
        return `${ts} ${c.green}VERIFY${c.reset} ${e.ensName} ✅ on-chain resolver authentic, payTo=${e.payTo}`;
      }
      return `${ts} ${c.yellow}VERIFY${c.reset} ${e.ensName} ❌ rejected: ${e.reason}`;
    case "decide":
      return `${ts} ${c.magenta}DECIDE${c.reset} winner: ${c.bold}${e.chosen.ensName}${c.reset}\n        Rationale: "${e.rationale}"${e.rejected.length > 0 ? `\n        Rejected: ${e.rejected.map((r) => `${r.label} (${r.reason})`).join(", ")}` : ""}`;
    case "quote":
      return `${ts} ${c.cyan}QUOTE${c.reset} ${e.label} for ${e.units} units = $${(Number(e.amount) / 1e6).toFixed(2)} USDC (payTo ${e.payTo})`;
    case "refused":
      return `${ts} ${c.yellow}REFUSED${c.reset} ${e.label} returned HTTP ${e.status}: ${e.reason} -> activating fallback`;
    case "payment_failed":
      return `${ts} ${c.red}PAYMENT FAILED${c.reset} ${e.label}: ${e.error} -> trying next candidate`;
    case "paid":
      return `${ts} ${c.green}PAID${c.reset} ${e.label} $${(Number(e.amount) / 1e6).toFixed(2)} USDC\n        Tx: ${e.txId}\n        HashScan: ${e.hashscanUrl}`;
    case "result":
      return `${ts} ${c.green}${c.bold}RESULT${c.reset} ${e.label} (job ${e.jobId ?? "n/a"}, ${e.latencyMs ?? 0} ms):\n${c.dim}------------------------------------------------------------${c.reset}\n${e.text}\n${c.dim}------------------------------------------------------------${c.reset}`;
    case "error":
      return `${ts} ${c.red}ERROR${c.reset} (${e.step ?? "runtime"}): ${e.message}`;
  }
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

async function main() {
  console.log(`${c.bold}🤖 Nightshift Buyer Agent — Podcast Assistant${c.reset}`);
  const state = loadState();
  const rules = loadRules();
  console.log(
    `${c.dim}Today's spend: $${(Number(state.dailySpentAtomic) / 1e6).toFixed(2)} / $${(Number(rules.dailyBudgetAtomic) / 1e6).toFixed(2)} USDC (${state.jobsCompleted} job(s))${c.reset}\n`,
  );

  const res = await runBuyer(
    {
      skill: taskSkill,
      file: taskFile,
      maxUnits: taskUnits,
    },
    {
      rules,
      onEvent: (event) => console.log(formatEvent(event)),
    },
  );

  if (!res.success) {
    console.error(`\n${c.red}Buyer run failed: ${res.error}${c.reset}`);
    process.exit(1);
  }

  console.log(`\n${c.green}✨ Job completed successfully by ${res.chosenAgent}!${c.reset}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal buyer error:", err);
  process.exit(1);
});
