// Pure reputation math (docs/04): {"jobs","success","p50_ms","updated"}.
// success = settled / (settled + our failures); failed_upstream (0G down, buyer not charged),
// refused_budget and in-flight jobs are excluded.
import type { JobStatus } from "../db/types.js";

export interface Reputation {
  jobs: number;
  success: number;
  p50_ms: number;
  updated: string;
}

const OUR_FAILURES: ReadonlySet<JobStatus> = new Set(["failed_internal", "settle_failed"]);

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

export function computeReputation(
  jobs: { status: JobStatus; latency_ms: number | null }[],
  now: Date,
): Reputation {
  const settled = jobs.filter((j) => j.status === "settled");
  const failed = jobs.filter((j) => OUR_FAILURES.has(j.status)).length;
  const denom = settled.length + failed;
  return {
    jobs: settled.length,
    success: denom === 0 ? 1 : Math.round((settled.length / denom) * 100) / 100,
    p50_ms: median(settled.flatMap((j) => (j.latency_ms === null ? [] : [j.latency_ms]))),
    updated: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
}

/** True when the on-chain record is missing, unparsable, or differs in any stat besides `updated`. */
export function needsUpdate(onChain: string | null | undefined, next: Reputation): boolean {
  if (!onChain) return true;
  try {
    const cur = JSON.parse(onChain) as Partial<Reputation>;
    return cur.jobs !== next.jobs || cur.success !== next.success || cur.p50_ms !== next.p50_ms;
  } catch {
    return true;
  }
}
