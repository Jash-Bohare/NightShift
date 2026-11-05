// Pure directory logic (unit-tested): query validation, row mapping, filter/sort/paginate.
// The directory is small (one row per agent), so filtering happens in memory after one select;
// no user input ever reaches a PostgREST filter string.
import { z } from "zod";
import { ENS_PARENT_NAME } from "@nightshift/shared";

/** Statuses the run route accepts (paused_budget is re-checked per request and auto-resumes). */
export const AVAILABLE_STATUSES = ["active", "paused_budget"] as const;
const STATUSES = [
  "active",
  "paused_owner",
  "paused_budget",
  "expired",
  "revoked",
  "failed",
  "unmanaged",
] as const;

export const LABEL_RE = /^[a-z0-9-]{3,32}$/;

export const DirectoryQuery = z.object({
  skill: z
    .string()
    .regex(/^[a-z]+(:[a-z]{2}(-[a-z]{2})?)?$/, "skill like transcribe or transcribe:ta")
    .optional(),
  maxPrice: z.string().regex(/^\d+$/, "atomic USDC per unit").optional(),
  minSuccess: z.coerce.number().min(0).max(1).optional(),
  search: z
    .string()
    .regex(/^[a-z0-9 .-]{1,64}$/i, "letters, digits, space, dot, dash")
    .optional(),
  status: z.enum(["available", "all", ...STATUSES]).default("available"),
  sort: z.enum(["price", "reputation", "recent"]).default("price"),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});
export type DirectoryQuery = z.infer<typeof DirectoryQuery>;

/** `/directory/:name` accepts `kural` or `kural.nightshift.eth`; returns the label or null. */
export function labelFromIdentifier(raw: string): string | null {
  const id = raw.trim().toLowerCase();
  const label = id.endsWith(`.${ENS_PARENT_NAME}`)
    ? id.slice(0, -(ENS_PARENT_NAME.length + 1))
    : id;
  return LABEL_RE.test(label) ? label : null;
}

export interface DirectoryRow {
  label: string;
  ens_name: string;
  owner: string;
  resolver: string;
  skill: string | null;
  price_atomic: number | string | null;
  price_unit: string | null;
  payto: string | null;
  endpoint: string | null;
  model: string | null;
  description: string | null;
  reputation: { jobs?: number; success?: number; p50_ms?: number; updated?: string } | null;
  status: string;
  expiry: string | null;
  updated_at: string;
}

export interface DirectoryAgent {
  label: string;
  ensName: string;
  owner: string;
  resolver: string;
  skill: string | null;
  price: { amount: string | null; asset: string; unit: string | null };
  payTo: string | null;
  endpoint: string | null;
  model: string | null;
  description: string | null;
  reputation: DirectoryRow["reputation"];
  status: string;
  expiry: string | null;
  updatedAt: string;
}

const toBig = (v: number | string | null): bigint | null =>
  v === null ? null : typeof v === "number" ? BigInt(Math.trunc(v)) : BigInt(v);

export function toDirectoryAgent(r: DirectoryRow, asset: string): DirectoryAgent {
  const amount = toBig(r.price_atomic);
  return {
    label: r.label,
    ensName: r.ens_name,
    owner: r.owner,
    resolver: r.resolver,
    skill: r.skill,
    price: { amount: amount === null ? null : amount.toString(), asset, unit: r.price_unit },
    payTo: r.payto,
    endpoint: r.endpoint,
    model: r.model,
    description: r.description,
    reputation: r.reputation,
    status: r.status,
    expiry: r.expiry,
    updatedAt: r.updated_at,
  };
}

const success = (a: DirectoryAgent) => a.reputation?.success ?? 0;
const jobs = (a: DirectoryAgent) => a.reputation?.jobs ?? 0;
const price = (a: DirectoryAgent) => (a.price.amount === null ? null : BigInt(a.price.amount));

export function queryDirectory(
  agents: DirectoryAgent[],
  q: DirectoryQuery,
): { agents: DirectoryAgent[]; total: number; page: number; limit: number } {
  const statusOk = (s: string) =>
    q.status === "all" ||
    (q.status === "available"
      ? (AVAILABLE_STATUSES as readonly string[]).includes(s)
      : s === q.status);
  const max = q.maxPrice === undefined ? null : BigInt(q.maxPrice);
  const needle = q.search?.toLowerCase();

  const hits = agents.filter((a) => {
    if (!statusOk(a.status)) return false;
    if (
      q.skill &&
      !(q.skill.includes(":") ? a.skill === q.skill : a.skill?.startsWith(`${q.skill}:`))
    )
      return false;
    if (max !== null) {
      const p = price(a);
      if (p === null || p > max) return false;
    }
    if (q.minSuccess !== undefined && success(a) < q.minSuccess) return false;
    if (
      needle &&
      ![a.label, a.ensName, a.description ?? ""].some((t) => t.toLowerCase().includes(needle))
    )
      return false;
    return true;
  });

  hits.sort((x, y) => {
    if (q.sort === "recent") return y.updatedAt.localeCompare(x.updatedAt);
    if (q.sort === "reputation") {
      if (success(y) !== success(x)) return success(y) - success(x);
      if (jobs(y) !== jobs(x)) return jobs(y) - jobs(x);
    } else {
      const px = price(x);
      const py = price(y);
      if (px !== py) {
        if (px === null) return 1;
        if (py === null) return -1;
        return px < py ? -1 : 1;
      }
    }
    return x.label.localeCompare(y.label);
  });

  const start = (q.page - 1) * q.limit;
  return {
    agents: hits.slice(start, start + q.limit),
    total: hits.length,
    page: q.page,
    limit: q.limit,
  };
}
