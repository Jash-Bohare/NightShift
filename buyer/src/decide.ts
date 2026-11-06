// Pure buyer decision logic (unit-tested in decide.test.ts): parse ENS records, apply spending
// rules, rank candidates deterministically, check quotes, and build the x402 payment policy.
// "Code decides, the LLM only explains."
import type { AgentReputation, BuyerRules } from "@nightshift/shared";

export interface EnsPrice {
  amount: bigint;
  asset: string;
  network: string;
  unit: string;
}

/** A candidate whose records were read from ENS and whose resolver was authenticated. */
export interface VerifiedAgent {
  label: string;
  ensName: string;
  owner: string;
  resolver: string;
  expiry: string;
  skill: string;
  price: EnsPrice;
  payTo: string;
  endpoint: string;
  reputation: AgentReputation;
}

export interface RankedAgent extends VerifiedAgent {
  totalAtomic: bigint;
}

export interface Rejection {
  label: string;
  reason: string;
}

const HEDERA_ID = /^0\.0\.\d+$/;

/** `nightshift.price` JSON -> typed price, or null when missing/malformed. */
export function parseEnsPrice(text: string | null | undefined): EnsPrice | null {
  if (!text) return null;
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const { amount, asset, network, unit } = j;
    if (typeof amount !== "string" || !/^\d+$/.test(amount)) return null;
    if (typeof asset !== "string" || typeof network !== "string" || typeof unit !== "string")
      return null;
    return { amount: BigInt(amount), asset, network, unit };
  } catch {
    return null;
  }
}

/** `nightshift.reputation` JSON -> typed reputation, or null when missing/malformed. */
export function parseReputation(text: string | null | undefined): AgentReputation | null {
  if (!text) return null;
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const jobs = typeof j.jobs === "number" ? j.jobs : null;
    if (jobs === null || !Number.isSafeInteger(jobs) || jobs < 0) return null;
    // The registrar writes {"jobs":0} at registration: no history yet counts as success 1.
    const success = typeof j.success === "number" ? j.success : jobs === 0 ? 1 : null;
    if (success === null || success < 0 || success > 1) return null;
    const p50 = typeof j.p50_ms === "number" ? j.p50_ms : 0;
    if (!Number.isFinite(p50) || p50 < 0) return null;
    return {
      jobs,
      success,
      p50_ms: p50,
      ...(typeof j.updated === "string" ? { updated: j.updated } : {}),
    };
  } catch {
    return null;
  }
}

export function isValidPayTo(payTo: string | null | undefined): payTo is string {
  return !!payTo && HEDERA_ID.test(payTo) && BigInt(payTo.slice(4)) > 0n;
}

/** The ENS name must be exactly `<label>.<parent>` for an allowed parent namespace. */
export function nameAllowed(label: string, ensName: string, allowParentNames: string[]): boolean {
  return allowParentNames.some((parent) => ensName === `${label}.${parent}`);
}

/**
 * Apply the spending rules and order the survivors: total price asc, success desc,
 * p50 latency asc (no data last), then label for a stable order.
 */
export function rankCandidates(
  agents: VerifiedAgent[],
  units: number,
  rules: BuyerRules,
  remainingDailyAtomic: bigint,
): { queue: RankedAgent[]; rejected: Rejection[] } {
  const queue: RankedAgent[] = [];
  const rejected: Rejection[] = [];
  const maxPerJob = BigInt(rules.maxPerJobAtomic);
  const approvalAbove = BigInt(rules.humanApprovalAboveAtomic);

  for (const a of agents) {
    const totalAtomic = a.price.amount * BigInt(units);
    const reject = (reason: string) => rejected.push({ label: a.label, reason });
    if (!rules.allowedNetworks.includes(a.price.network))
      reject(`network ${a.price.network} not allowed`);
    else if (!rules.allowedAssets.includes(a.price.asset))
      reject(`asset ${a.price.asset} not allowed`);
    else if (totalAtomic > approvalAbove)
      reject(`total ${totalAtomic} needs human approval (> ${approvalAbove})`);
    else if (totalAtomic > maxPerJob)
      reject(`total ${totalAtomic} exceeds max per job ${maxPerJob}`);
    else if (totalAtomic > remainingDailyAtomic)
      reject(`total ${totalAtomic} exceeds remaining daily budget ${remainingDailyAtomic}`);
    else if (a.reputation.success < rules.minSuccess)
      reject(`success ${a.reputation.success} below minimum ${rules.minSuccess}`);
    else queue.push({ ...a, totalAtomic });
  }

  const p50 = (r: AgentReputation) => (r.p50_ms > 0 ? r.p50_ms : Number.MAX_SAFE_INTEGER);
  queue.sort((x, y) => {
    if (x.totalAtomic !== y.totalAtomic) return x.totalAtomic < y.totalAtomic ? -1 : 1;
    if (x.reputation.success !== y.reputation.success)
      return y.reputation.success - x.reputation.success;
    if (p50(x.reputation) !== p50(y.reputation)) return p50(x.reputation) - p50(y.reputation);
    return x.label.localeCompare(y.label);
  });
  return { queue, rejected };
}

export interface Quote {
  amount: string;
  asset: string;
  network: string;
  payTo: string;
}

/** The server's quote must match what ENS says, or the buyer skips the agent (docs/05 step 5). */
export function quoteMismatch(quote: Quote, agent: RankedAgent): string | null {
  if (quote.amount !== agent.totalAtomic.toString())
    return `quote ${quote.amount} != ENS price × units ${agent.totalAtomic}`;
  if (quote.payTo !== agent.payTo) return `quote payTo ${quote.payTo} != ENS payTo ${agent.payTo}`;
  if (quote.asset !== agent.price.asset) return `quote asset ${quote.asset} != ENS asset`;
  if (quote.network !== agent.price.network) return `quote network ${quote.network} != ENS network`;
  return null;
}

/** Requirement fields the policy checks (a subset of @x402/core PaymentRequirements). */
export interface RequirementLike {
  network: string;
  asset: string;
  amount: string;
  payTo: string;
}

/**
 * x402 PaymentPolicy body: keep only requirements that pay exactly the ENS payTo, in an allowed
 * asset/network, for exactly the expected amount. A server that redirects payment gets nothing.
 */
export function filterRequirements<R extends RequirementLike>(
  reqs: R[],
  expected: { payTo: string; asset: string; network: string; amount: bigint },
  rules: BuyerRules,
): R[] {
  return reqs.filter(
    (r) =>
      r.payTo === expected.payTo &&
      r.asset === expected.asset &&
      r.network === expected.network &&
      rules.allowedAssets.includes(r.asset) &&
      rules.allowedNetworks.includes(r.network) &&
      /^\d+$/.test(r.amount) &&
      BigInt(r.amount) === expected.amount,
  );
}
