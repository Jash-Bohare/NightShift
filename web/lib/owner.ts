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
      nullable(j.hcsSequence, (v) => isString(v) && DIGITS.test(v)) &&
      nullable(j.outputSha256, (v) => isString(v) && /^[0-9a-f]{64}$/.test(v)) &&
      nullable(j.latencyMs, (v) => Number.isSafeInteger(v)) &&
      isString(j.createdAt);
    if (!ok) throw new Error("Owner job history contains a malformed record.");
    return j as unknown as OwnerJob;
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
