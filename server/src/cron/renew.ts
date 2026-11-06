// Renew cron (docs/04 § Crons, 01:00 UTC; docs/02 F6): renew names that expire within 7 days and
// earned in the last 30 days; mark lapsed names `expired` (agents + directory). Renewals spend
// operator Sepolia gas, so this only runs when CRONS_ENABLED=true (or via the manual script).
import { UpstreamError } from "../errors.js";
import { db } from "../db/client.js";
import { transitionAgentStatus, forgetAgent } from "../db/queries.js";
import type { AgentRow, AgentStatus } from "../db/types.js";
import { syncAgentToDirectory } from "../ens/indexer.js";
import { renewAgent } from "../ens/registrar.js";
import { log, logError } from "../log.js";

const DAY_MS = 24 * 60 * 60 * 1000;
export const RENEW_WINDOW_MS = 7 * DAY_MS;
export const ACTIVITY_WINDOW_MS = 30 * DAY_MS;

/** Statuses of live workers: renewable, and flipped to `expired` once their name lapses. */
const LIVE: readonly AgentStatus[] = ["active", "paused_budget", "paused_owner"];

type Candidate = Pick<AgentRow, "id" | "label" | "status" | "expiry">;

/** Live workers whose name expires within 7 days (and has not yet) and that earned recently. */
export function selectRenewals(
  agents: readonly Candidate[],
  recentlyActive: ReadonlySet<string>,
  now: number,
): Candidate[] {
  return agents.filter((a) => {
    if (!LIVE.includes(a.status) || !a.expiry || !recentlyActive.has(a.id)) return false;
    const at = Date.parse(a.expiry);
    return Number.isFinite(at) && at > now && at - now <= RENEW_WINDOW_MS;
  });
}

/** Live workers whose name has already lapsed. */
export function selectLapsed(agents: readonly Candidate[], now: number): Candidate[] {
  return agents.filter((a) => {
    if (!LIVE.includes(a.status) || !a.expiry) return false;
    const at = Date.parse(a.expiry);
    return Number.isFinite(at) && at <= now;
  });
}

export interface RenewResult {
  renewed: string[];
  failed: string[];
  expired: string[];
}

export async function runRenewals(now = new Date()): Promise<RenewResult> {
  const agentsResult = await db
    .from("agents")
    .select("*")
    .in("status", [...LIVE]);
  if (agentsResult.error)
    throw new UpstreamError("db", `renew candidates: ${agentsResult.error.message}`);
  const agents = (agentsResult.data ?? []) as AgentRow[];

  const since = new Date(now.getTime() - ACTIVITY_WINDOW_MS).toISOString();
  const jobsResult = await db
    .from("jobs")
    .select("agent_id")
    .eq("status", "settled")
    .gte("created_at", since);
  if (jobsResult.error)
    throw new UpstreamError("db", `renew activity: ${jobsResult.error.message}`);
  const active = new Set(
    ((jobsResult.data ?? []) as { agent_id: string }[]).map((j) => j.agent_id),
  );

  const result: RenewResult = { renewed: [], failed: [], expired: [] };
  const byId = new Map(agents.map((a) => [a.id, a]));

  // One at a time: every renewal is signed by the same operator key.
  for (const candidate of selectRenewals(agents, active, now.getTime())) {
    try {
      const renewal = await renewAgent(candidate.label);
      const upd = await db
        .from("agents")
        .update({ expiry: renewal.expiry.toISOString() })
        .eq("id", candidate.id)
        .select("id")
        .maybeSingle();
      if (upd.error || !upd.data)
        throw new UpstreamError(
          "db",
          `record renewal of ${candidate.label}: ${upd.error?.message ?? "agent missing"}`,
        );
      forgetAgent(candidate.label);
      await syncAgentToDirectory(candidate.label).catch((e: unknown) =>
        logError("ens", `directory sync after renewing ${candidate.label}`, e),
      );
      result.renewed.push(candidate.label);
    } catch (error) {
      result.failed.push(candidate.label);
      logError("ens", `renew ${candidate.label} failed (retried next run)`, error);
    }
  }

  for (const lapsed of selectLapsed(agents, now.getTime())) {
    const agent = byId.get(lapsed.id)!;
    // Compare-and-set: a concurrent owner pause or revoke wins; the next run retries.
    if (await transitionAgentStatus(agent, agent.status, "expired"))
      result.expired.push(agent.label);
  }

  if (result.renewed.length || result.failed.length || result.expired.length)
    log("cron", "renew run", { ...result });
  return result;
}
