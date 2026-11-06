// Budget guard: pure decision logic (unit-tested in budget-logic.test.ts). All amounts micro-USD.

export type BudgetDecision =
  | { ok: true; estimateUsdMicro: bigint; remainingUsdMicro: bigint }
  | {
      ok: false;
      reason: "over_budget";
      resetsAt: Date;
      estimateUsdMicro: bigint;
      remainingUsdMicro: bigint;
    }
  | { ok: false; reason: "no_credits"; estimateUsdMicro: bigint; balanceUsdMicro: bigint };

export interface RecordedJobCost {
  id: string;
  status: string;
  zg_cost_usd_micro: string | number | null;
}

export function sumRecordedCosts(rows: RecordedJobCost[]): bigint {
  return rows.reduce((sum, row) => {
    if (row.status === "refused_budget") return sum;
    const cost = row.zg_cost_usd_micro;
    if (cost === null) throw new Error(`job ${row.id} has no recorded 0G cost`);
    if (typeof cost === "number" && (!Number.isSafeInteger(cost) || cost < 0))
      throw new Error(`job ${row.id} has an unsafe 0G cost`);
    if (typeof cost === "string" && !/^\d+$/.test(cost))
      throw new Error(`job ${row.id} has a malformed 0G cost`);
    return sum + BigInt(cost);
  }, 0n);
}

/** 00:00:00.000 UTC of the day containing `now`. */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** The next 00:00 UTC strictly after `now`. */
export function nextUtcMidnight(now: Date): Date {
  return new Date(utcDayStart(now).getTime() + 86_400_000);
}

export function decide(args: {
  now: Date;
  capUsdMicro: bigint;
  /** 0G spend already recorded today (settled + done + failed jobs with a cost). */
  spentUsdMicro: bigint;
  /** Estimates of jobs currently running for this agent (not yet in spent). */
  reservedUsdMicro: bigint;
  estimateUsdMicro: bigint;
  /** 0G account total_balance if the owner gave an mk- key; undefined skips the check. */
  balanceUsdMicro?: bigint;
}): BudgetDecision {
  const used = args.spentUsdMicro + args.reservedUsdMicro;
  const remaining = args.capUsdMicro > used ? args.capUsdMicro - used : 0n;
  if (used + args.estimateUsdMicro > args.capUsdMicro)
    return {
      ok: false,
      reason: "over_budget",
      resetsAt: nextUtcMidnight(args.now),
      estimateUsdMicro: args.estimateUsdMicro,
      remainingUsdMicro: remaining,
    };
  if (args.balanceUsdMicro !== undefined && args.balanceUsdMicro < args.estimateUsdMicro)
    return {
      ok: false,
      reason: "no_credits",
      estimateUsdMicro: args.estimateUsdMicro,
      balanceUsdMicro: args.balanceUsdMicro,
    };
  return {
    ok: true,
    estimateUsdMicro: args.estimateUsdMicro,
    remainingUsdMicro: remaining - args.estimateUsdMicro,
  };
}

/** In-flight reservations per agent, so concurrent jobs cannot jointly exceed the cap. */
export class Reservations {
  private byAgent = new Map<string, Map<symbol, bigint>>();

  total(agentId: string): bigint {
    let sum = 0n;
    for (const v of this.byAgent.get(agentId)?.values() ?? []) sum += v;
    return sum;
  }

  /** Reserve and return a release function (idempotent). */
  hold(agentId: string, amount: bigint): () => void {
    const token = Symbol(agentId);
    const m = this.byAgent.get(agentId) ?? new Map<symbol, bigint>();
    m.set(token, amount);
    this.byAgent.set(agentId, m);
    return () => {
      m.delete(token);
      if (m.size === 0) this.byAgent.delete(agentId);
    };
  }
}
