// Spending rules manager and persistent state tracker (docs/05-buyer-agent.md).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BuyerRules, BuyerSpendingState } from "@nightshift/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
export const RULES_PATH = join(ROOT, "rules.json");
export const STATE_PATH = join(ROOT, ".state.json");

export function utcTodayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function loadRules(): BuyerRules {
  if (!existsSync(RULES_PATH)) {
    throw new Error(`Rules file not found at ${RULES_PATH}`);
  }
  return JSON.parse(readFileSync(RULES_PATH, "utf8")) as BuyerRules;
}

export function loadState(): BuyerSpendingState {
  const today = utcTodayDate();
  if (!existsSync(STATE_PATH)) {
    const fresh: BuyerSpendingState = {
      date: today,
      dailySpentAtomic: "0",
      totalSpentAtomic: "0",
      jobsCompleted: 0,
      lastUpdated: new Date().toISOString(),
    };
    saveState(fresh);
    return fresh;
  }

  try {
    const state = JSON.parse(readFileSync(STATE_PATH, "utf8")) as BuyerSpendingState;
    // Handle UTC day rollover
    if (state.date !== today) {
      state.date = today;
      state.dailySpentAtomic = "0";
      state.lastUpdated = new Date().toISOString();
      saveState(state);
    }
    return state;
  } catch {
    const fallback: BuyerSpendingState = {
      date: today,
      dailySpentAtomic: "0",
      totalSpentAtomic: "0",
      jobsCompleted: 0,
      lastUpdated: new Date().toISOString(),
    };
    saveState(fallback);
    return fallback;
  }
}

export function saveState(state: BuyerSpendingState): void {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
}

export interface SpendValidation {
  allowed: boolean;
  reason?: string;
  maxPerJob: bigint;
  dailyBudget: bigint;
  dailySpent: bigint;
  remainingDaily: bigint;
}

/** Check if a job price is allowed by spending rules and remaining daily budget. */
export function validateSpend(amountAtomic: bigint, rules?: BuyerRules): SpendValidation {
  const r = rules ?? loadRules();
  const state = loadState();

  const maxPerJob = BigInt(r.maxPerJobAtomic);
  const dailyBudget = BigInt(r.dailyBudgetAtomic);
  const dailySpent = BigInt(state.dailySpentAtomic);
  const remainingDaily = dailyBudget > dailySpent ? dailyBudget - dailySpent : 0n;

  if (amountAtomic > maxPerJob) {
    return {
      allowed: false,
      reason: `amount ${amountAtomic} exceeds max per job ${maxPerJob} ($${(Number(maxPerJob) / 1e6).toFixed(2)})`,
      maxPerJob,
      dailyBudget,
      dailySpent,
      remainingDaily,
    };
  }

  if (amountAtomic > remainingDaily) {
    return {
      allowed: false,
      reason: `amount ${amountAtomic} exceeds remaining daily budget ${remainingDaily} ($${(Number(remainingDaily) / 1e6).toFixed(2)})`,
      maxPerJob,
      dailyBudget,
      dailySpent,
      remainingDaily,
    };
  }

  return {
    allowed: true,
    maxPerJob,
    dailyBudget,
    dailySpent,
    remainingDaily,
  };
}

/** Record a completed payment in .state.json atomically. */
export function recordSpend(amountAtomic: bigint): BuyerSpendingState {
  const state = loadState();
  const daily = BigInt(state.dailySpentAtomic) + amountAtomic;
  const total = BigInt(state.totalSpentAtomic) + amountAtomic;

  state.dailySpentAtomic = daily.toString();
  state.totalSpentAtomic = total.toString();
  state.jobsCompleted += 1;
  state.lastUpdated = new Date().toISOString();

  saveState(state);
  return state;
}
