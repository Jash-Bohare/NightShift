// Buyer CLI (docs/05): pnpm -C buyer start -- --skill transcribe:ta --file ./samples/tamil-90s.mp3
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { formatUsdc, type BuyerEvent } from "@nightshift/shared";
import { runBuyer } from "./agent.js";
import { DEFAULT_SAMPLE_FILE } from "./config.js";
import { loadRules, loadState } from "./spending.js";

// WSL: Node's 250 ms per-address connect budget is too short for Alchemy (see docs/07).
setDefaultAutoSelectFamilyAttemptTimeout(5_000);
try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  // Env vars may come from the shell instead.
}

const { values: args } = parseArgs({
  options: {
    skill: { type: "string", default: "transcribe:ta" },
    file: { type: "string", default: DEFAULT_SAMPLE_FILE },
    units: { type: "string" },
  },
});

const units = args.units === undefined ? undefined : Number(args.units);
if (units !== undefined && (!Number.isInteger(units) || units < 1)) {
  console.error("--units must be a positive integer (minutes)");
  process.exit(1);
}

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
};
const usd = (atomic: string | bigint) => `${formatUsdc(atomic)} USDC`;

function format(e: BuyerEvent): string {
  const ts = `${c.dim}[${e.timestamp.slice(11, 19)}]${c.reset}`;
  switch (e.kind) {
    case "plan":
      return `${ts} ${c.blue}PLAN${c.reset}     ${e.task.skill} on ${e.task.file} (${e.task.units} min), max ${usd(e.rules.maxPerJobAtomic)} per job`;
    case "discover":
      return `${ts} ${c.cyan}DISCOVER${c.reset} ${e.candidates.length} candidate(s): ${e.candidates.map((x) => `${x.ensName} (${usd(x.priceAtomic)}/min)`).join(", ")}`;
    case "verify":
      return e.ok
        ? `${ts} ${c.green}VERIFY${c.reset}   ${e.ensName} ✅ resolver authentic, payTo ${e.payTo}`
        : `${ts} ${c.yellow}VERIFY${c.reset}   ${e.ensName} ❌ ${e.reason}`;
    case "decide":
      return `${ts} ${c.magenta}DECIDE${c.reset}   ${c.bold}${e.chosen.ensName}${c.reset}: "${e.rationale}"${e.rejected.length ? `\n           skipped: ${e.rejected.map((r) => `${r.label} (${r.reason})`).join(", ")}` : ""}`;
    case "quote":
      return `${ts} ${c.cyan}QUOTE${c.reset}    ${e.label}: ${e.units} min = ${usd(e.amount)} to ${e.payTo} (matches ENS)`;
    case "refused":
      return `${ts} ${c.yellow}REFUSED${c.reset}  ${e.label} → HTTP ${e.status} ${e.reason} (not charged, trying next)`;
    case "payment_failed":
      return `${ts} ${c.red}FAILED${c.reset}   ${e.label}: ${e.error} (trying next)`;
    case "paid":
      return `${ts} ${c.green}PAID${c.reset}     ${usd(e.amount)} to ${e.label}\n           ${e.hashscanUrl}`;
    case "result":
      return `${ts} ${c.green}${c.bold}RESULT${c.reset}   job ${e.jobId ?? "?"}, 0G request ${e.zgRequestId ?? "?"}, ${e.latencyMs ?? 0} ms\n${c.dim}${"-".repeat(60)}${c.reset}\n${e.text.trim()}\n${c.dim}${"-".repeat(60)}${c.reset}`;
    case "error":
      return `${ts} ${c.red}ERROR${c.reset}    (${e.step ?? "run"}) ${e.message}`;
  }
}

const state = loadState();
const rules = loadRules();
console.log(`${c.bold}🤖 Podcast Assistant — Nightshift buyer agent${c.reset}`);
console.log(
  `${c.dim}spent today ${usd(state.dailySpentAtomic)} of ${usd(rules.dailyBudgetAtomic)} (${state.jobsCompleted} job(s) total)${c.reset}\n`,
);

const res = await runBuyer(
  { skill: args.skill!, file: args.file!, ...(units !== undefined ? { units } : {}) },
  { rules, onEvent: (e) => console.log(format(e)) },
);
if (!res.success) {
  console.error(`\n${c.red}Buyer run failed: ${res.error}${c.reset}`);
  process.exit(1);
}
console.log(`\n${c.green}✨ Done: ${res.chosenAgent} delivered the transcript.${c.reset}`);
process.exit(0);
