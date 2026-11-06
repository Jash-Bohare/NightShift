// Owner-scoped API contracts (GET /me/jobs). Responses are validated before rendering; any
// mismatch is shown as an error rather than partially rendered.

export interface OwnerJob {
  id: string;
  label: string;
  status: string;
  units: string;
  priceAtomic: string;
  zgCostUsdMicro: string | null;
  hederaTxId: string | null;
  zgRequestId: string | null;
  hcsSequence: string | null;
  outputSha256: string | null;
  latencyMs: number | null;
  createdAt: string;
}

export interface OwnerJobsPage {
  items: OwnerJob[];
  page: number;
  limit: number;
  nextPage?: number;
}

const DIGITS = /^\d+$/;
const nullable = (value: unknown, check: (v: unknown) => boolean) => value === null || check(value);
const isString = (v: unknown): v is string => typeof v === "string";

export function parseOwnerJobs(value: unknown): OwnerJobsPage {
  if (typeof value !== "object" || value === null)
    throw new Error("Owner job history is malformed.");
  const page = value as Record<string, unknown>;
  if (
    !Array.isArray(page.items) ||
    !Number.isSafeInteger(page.page) ||
    !Number.isSafeInteger(page.limit) ||
    (page.nextPage !== undefined && !Number.isSafeInteger(page.nextPage))
  )
    throw new Error("Owner job history is malformed.");
  const items = page.items.map((raw: unknown): OwnerJob => {
    const j = raw as Record<string, unknown>;
    const ok =
      typeof j === "object" &&
      j !== null &&
      isString(j.id) &&
      isString(j.label) &&
      isString(j.status) &&
      isString(j.units) &&
      /^\d+(\.\d+)?$/.test(j.units) &&
      isString(j.priceAtomic) &&
      DIGITS.test(j.priceAtomic) &&
      nullable(j.zgCostUsdMicro, (v) => isString(v) && DIGITS.test(v)) &&
      nullable(j.hederaTxId, isString) &&
      (j.zgRequestId === undefined || nullable(j.zgRequestId, isString)) &&
      nullable(j.hcsSequence, (v) => isString(v) && DIGITS.test(v)) &&
      nullable(j.outputSha256, (v) => isString(v) && /^[0-9a-f]{64}$/.test(v)) &&
      nullable(j.latencyMs, (v) => Number.isSafeInteger(v)) &&
      isString(j.createdAt);
    if (!ok) throw new Error("Owner job history contains a malformed record.");
    return { ...(j as unknown as OwnerJob), zgRequestId: (j.zgRequestId as string | null) ?? null };
  });
  return {
    items,
    page: page.page as number,
    limit: page.limit as number,
    ...(page.nextPage !== undefined ? { nextPage: page.nextPage as number } : {}),
  };
}

/** Human status for owner views; reconciliation states are called out, never hidden. */
export function ownerJobStatusLabel(status: string): string {
  switch (status) {
    case "settled":
      return "Paid · settled";
    case "needs_reconciliation":
      return "Needs reconciliation (outcome unknown)";
    case "settle_failed":
      return "Payment failed · buyer not charged";
    case "refused_budget":
      return "Refused · over 0G budget";
    case "failed_upstream":
    case "failed_internal":
      return "Failed · buyer not charged";
    case "running":
    case "done":
      return "In progress";
    default:
      return status;
  }
}

// ---- GET /me (dashboard roster) -------------------------------------------------------------

export interface TodayUsage {
  spentUsdMicro: string;
  earnedAtomic: string;
  jobsSettled: number;
  jobsRefused: number;
}

export interface OwnerAgent {
  id: string;
  label: string;
  ensName: string;
  skill: string;
  model: string;
  priceAtomic: string;
  priceUnit: string;
  dailyCapUsdMicro: string;
  status: string;
  expiry: string | null;
  createdAt: string;
  hederaAccountId: string | null;
  resolverAddress: string | null;
  registerTx: string | null;
  today: TodayUsage;
}

export interface OwnerDashboard {
  owner: { evmAddress: string; hederaPayoutAccount: string | null; createdAt: string } | null;
  agents: OwnerAgent[];
}

const nullableString = (v: unknown) => v === null || v === undefined || isString(v);

export function parseOwnerDashboard(value: unknown): OwnerDashboard {
  const bad = () => new Error("The owner API returned an invalid response.");
  if (typeof value !== "object" || value === null) throw bad();
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.agents)) throw bad();
  let owner: OwnerDashboard["owner"] = null;
  if (v.owner !== null) {
    const o = v.owner as Record<string, unknown> | undefined;
    if (
      !o ||
      !isString(o.evmAddress) ||
      !isString(o.createdAt) ||
      !nullableString(o.hederaPayoutAccount)
    )
      throw bad();
    owner = {
      evmAddress: o.evmAddress,
      createdAt: o.createdAt,
      hederaPayoutAccount: (o.hederaPayoutAccount as string | null | undefined) ?? null,
    };
  }
  const agents = v.agents.map((raw: unknown): OwnerAgent => {
    const a = raw as Record<string, unknown>;
    const t = (a?.today ?? {}) as Record<string, unknown>;
    const ok =
      typeof a === "object" &&
      a !== null &&
      ["id", "label", "ensName", "skill", "model", "priceUnit", "status", "createdAt"].every((k) =>
        isString(a[k]),
      ) &&
      isString(a.priceAtomic) &&
      DIGITS.test(a.priceAtomic) &&
      isString(a.dailyCapUsdMicro) &&
      DIGITS.test(a.dailyCapUsdMicro) &&
      nullableString(a.expiry) &&
      nullableString(a.hederaAccountId) &&
      nullableString(a.resolverAddress) &&
      nullableString(a.registerTx) &&
      isString(t.spentUsdMicro) &&
      DIGITS.test(t.spentUsdMicro) &&
      isString(t.earnedAtomic) &&
      DIGITS.test(t.earnedAtomic) &&
      Number.isSafeInteger(t.jobsSettled) &&
      (t.jobsRefused === undefined || Number.isSafeInteger(t.jobsRefused));
    if (!ok) throw bad();
    return {
      ...(a as unknown as OwnerAgent),
      expiry: (a.expiry as string | null | undefined) ?? null,
      hederaAccountId: (a.hederaAccountId as string | null | undefined) ?? null,
      resolverAddress: (a.resolverAddress as string | null | undefined) ?? null,
      registerTx: (a.registerTx as string | null | undefined) ?? null,
      today: {
        spentUsdMicro: t.spentUsdMicro as string,
        earnedAtomic: t.earnedAtomic as string,
        jobsSettled: t.jobsSettled as number,
        jobsRefused: (t.jobsRefused as number | undefined) ?? 0,
      },
    };
  });
  return { owner, agents };
}

/** Status stamp per docs/design: ON SHIFT (green), OUT OF CREDITS (red), PAUSED (orange). */
export function agentStatusStamp(status: string): {
  text: string;
  tone: "green" | "red" | "orange" | "blue";
} {
  switch (status) {
    case "active":
      return { text: "ON SHIFT", tone: "green" };
    case "paused_budget":
      return { text: "OUT OF CREDITS", tone: "red" };
    case "paused_owner":
      return { text: "PAUSED", tone: "orange" };
    case "pending":
      return { text: "REGISTERING", tone: "blue" };
    case "expired":
      return { text: "EXPIRED", tone: "red" };
    case "revoked":
      return { text: "REVOKED", tone: "red" };
    case "failed":
      return { text: "LAUNCH FAILED", tone: "red" };
    default:
      return { text: status.toUpperCase(), tone: "blue" };
  }
}

/** Whole percent of the cap used today, 0–100 (bigint math; an over-cap day shows 100). */
export function capUsedPercent(spentUsdMicro: string, capUsdMicro: string): number {
  const cap = BigInt(capUsdMicro);
  if (cap <= 0n) return 100;
  const pct = (BigInt(spentUsdMicro) * 100n) / cap;
  return Number(pct > 100n ? 100n : pct);
}

// ---- GET /me/payouts ------------------------------------------------------------------------

export interface OwnerPayout {
  id: string;
  label: string;
  payoutDate: string;
  grossAtomic: string;
  ownerAtomic: string;
  feeAtomic: string;
  status: "pending" | "submitted" | "confirmed" | "failed" | "uncertain";
  transactionId: string | null;
  destinationAccount: string | null;
  createdAt: string;
}

export function parseOwnerPayouts(value: unknown): { items: OwnerPayout[]; nextPage?: number } {
  const bad = () => new Error("Owner payouts are malformed.");
  if (typeof value !== "object" || value === null) throw bad();
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.items)) throw bad();
  const items = v.items.map((raw: unknown) => {
    const p = raw as Record<string, unknown>;
    const ok =
      typeof p === "object" &&
      p !== null &&
      ["id", "label", "payoutDate", "createdAt"].every((k) => isString(p[k])) &&
      ["grossAtomic", "ownerAtomic", "feeAtomic"].every(
        (k) => isString(p[k]) && DIGITS.test(p[k] as string),
      ) &&
      ["pending", "submitted", "confirmed", "failed", "uncertain"].includes(p.status as string) &&
      nullable(p.transactionId, isString) &&
      nullable(p.destinationAccount, isString);
    if (!ok) throw bad();
    return p as unknown as OwnerPayout;
  });
  return {
    items,
    ...(Number.isSafeInteger(v.nextPage) ? { nextPage: v.nextPage as number } : {}),
  };
}

/** micro-USD integer string -> "0.012480" style dollars (exact). */
export function formatUsdMicro(value: string): string {
  const amount = BigInt(value);
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${fraction}`;
}

/** Owner wording for payout states; `uncertain` is called out because it is never resent. */
export function payoutStatusLabel(status: OwnerPayout["status"]): string {
  switch (status) {
    case "confirmed":
      return "Paid";
    case "pending":
    case "submitted":
      return "In progress";
    case "failed":
      return "Failed · retried next payday";
    case "uncertain":
      return "Needs reconciliation (outcome unknown)";
  }
}
