// Spending rules (rules.json) and the daily spend tracker (.state.json, reset per UTC date).
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { formatUsdc, type BuyerRules, type BuyerSpendingState } from "@nightshift/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
export const RULES_PATH = join(ROOT, "rules.json");
export const STATE_PATH = join(ROOT, ".state.json");
const Atomic = z.string().regex(/^\d+$/);
const RulesSchema = z.object({
  maxPerJobAtomic: Atomic,
  dailyBudgetAtomic: Atomic,
  allowedAssets: z.array(z.string().regex(/^0\.0\.\d+$/)).min(1),
  allowedNetworks: z.array(z.string().min(1)).min(1),
  allowParentNames: z.array(z.string().min(1)).min(1),
  minSuccess: z.number().min(0).max(1),
  humanApprovalAboveAtomic: Atomic,
});
const StateSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((value) => new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value),
  dailySpentAtomic: Atomic,
  totalSpentAtomic: Atomic,
  jobsCompleted: z.number().int().safe().nonnegative(),
  lastUpdated: z.string().datetime({ offset: true }),
});

export function utcTodayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function loadRules(): BuyerRules {
  if (!existsSync(RULES_PATH)) {
    throw new Error(`Rules file not found at ${RULES_PATH}`);
  }
  return validateRules(JSON.parse(readFileSync(RULES_PATH, "utf8")));
}

export function validateRules(rules: unknown): BuyerRules {
  const parsed = RulesSchema.safeParse(rules);
  if (!parsed.success) throw new Error("Buyer rules are invalid");
  return parsed.data;
}

export function loadState(statePath = STATE_PATH): BuyerSpendingState {
  const today = utcTodayDate();
  if (!existsSync(statePath)) {
    const fresh: BuyerSpendingState = {
      date: today,
      dailySpentAtomic: "0",
      totalSpentAtomic: "0",
      jobsCompleted: 0,
      lastUpdated: new Date().toISOString(),
    };
    saveState(fresh, statePath);
    return fresh;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    throw new Error(
      `Buyer spending state at ${statePath} is unreadable; refusing to reset the budget`,
    );
  }
  const parsed = StateSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      `Buyer spending state at ${statePath} is invalid; refusing to reset the budget`,
    );
  const state = parsed.data;
  if (state.date > today)
    throw new Error(
      `Buyer spending state at ${statePath} has a future date; refusing to reset the budget`,
    );
  if (state.date !== today) {
    state.date = today;
    state.dailySpentAtomic = "0";
    state.lastUpdated = new Date().toISOString();
    saveState(state, statePath);
  }
  return state;
}

export function saveState(state: BuyerSpendingState, statePath = STATE_PATH): void {
  const temporary = `${statePath}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx",
    });
    renameSync(temporary, statePath);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
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
      reason: `amount ${amountAtomic} exceeds max per job ${maxPerJob} (${formatUsdc(maxPerJob)} USDC)`,
      maxPerJob,
      dailyBudget,
      dailySpent,
      remainingDaily,
    };
  }

  if (amountAtomic > remainingDaily) {
    return {
      allowed: false,
      reason: `amount ${amountAtomic} exceeds remaining daily budget ${remainingDaily} (${formatUsdc(remainingDaily)} USDC)`,
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

/** Record a settled payment in .state.json. */
export function recordSpend(
  amountAtomic: bigint,
  options: { statePath?: string; jobCompleted?: boolean } = {},
): BuyerSpendingState {
  if (amountAtomic <= 0n) throw new Error("recorded spend must be positive");
  const state = loadState(options.statePath);
  const daily = BigInt(state.dailySpentAtomic) + amountAtomic;
  const total = BigInt(state.totalSpentAtomic) + amountAtomic;

  state.dailySpentAtomic = daily.toString();
  state.totalSpentAtomic = total.toString();
  if (options.jobCompleted !== false) state.jobsCompleted += 1;
  state.lastUpdated = new Date().toISOString();

  saveState(state, options.statePath);
  return state;
}

export function recordCompletedJob(statePath = STATE_PATH): BuyerSpendingState {
  const state = loadState(statePath);
  state.jobsCompleted += 1;
  state.lastUpdated = new Date().toISOString();
  saveState(state, statePath);
  return state;
}
