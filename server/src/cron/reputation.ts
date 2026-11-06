// Reputation batch (every 10 min + manual script): for each active agent, compute stats from
// jobs and call registrar.setReputation only when they differ from the live ENS record.
import { REPUTATION_KEY } from "@nightshift/shared";
import { normalize } from "viem/ens";
import { db } from "../db/client.js";
import type { JobStatus } from "../db/types.js";
import { UpstreamError } from "../errors.js";
import { syncAgentToDirectory } from "../ens/indexer.js";
import { sepoliaClient, setReputation, etherscanTx } from "../ens/registrar.js";
import { log, logError } from "../log.js";
import { computeReputation, needsUpdate } from "./reputation-logic.js";

export interface ReputationOutcome {
  label: string;
  written: boolean;
  json: string;
  tx?: string;
}

let running = false;

/** Same reputation content, ignoring key order (Postgres jsonb reorders keys). */
export function sameReputation(onChain: string | null | undefined, cached: unknown): boolean {
  let chain: unknown;
  try {
    chain = JSON.parse(onChain ?? "");
  } catch {
    return cached === null || cached === undefined;
  }
  const canon = (v: unknown): string =>
    v && typeof v === "object" && !Array.isArray(v)
      ? JSON.stringify(
          Object.keys(v as Record<string, unknown>)
            .sort()
            .map((k) => [k, (v as Record<string, unknown>)[k]]),
        )
      : JSON.stringify(v ?? null);
  return canon(chain) === canon(cached);
}

/** The directory is a cache of ENS; keep its reputation in step even when crons are off. */
async function refreshDirectory(label: string): Promise<void> {
  try {
    await syncAgentToDirectory(label);
  } catch (err) {
    logError("ens", `directory refresh for ${label} failed (indexer retries later)`, err);
  }
}

export async function loadAgentReputationJobs(
  agentId: string,
  pageSize = 1000,
): Promise<{ status: JobStatus; latency_ms: number | null }[]> {
  const all: { status: JobStatus; latency_ms: number | null }[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const result = await db
      .from("jobs")
      .select("status,latency_ms")
      .eq("agent_id", agentId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (result.error)
      throw new UpstreamError("db", `reputation jobs for ${agentId}: ${result.error.message}`);
    const page = (result.data ?? []) as { status: JobStatus; latency_ms: number | null }[];
    all.push(...page);
    if (page.length < pageSize) return all;
  }
}

export async function runReputationBatch(now = new Date()): Promise<ReputationOutcome[]> {
  if (running) {
    log("cron", "reputation batch already running, skipping");
    return [];
  }
  running = true;
  try {
    const agents = await db
      .from("agents")
      .select("id,label,ens_name")
      .in("status", ["active", "paused_budget", "paused_owner"]);
    if (agents.error) throw new UpstreamError("db", agents.error.message);
    const dir = await db.from("directory").select("label,reputation");
    if (dir.error) throw new UpstreamError("db", dir.error.message);
    const cached = new Map(
      ((dir.data ?? []) as { label: string; reputation: unknown }[]).map((r) => [
        r.label,
        r.reputation,
      ]),
    );
    const out: ReputationOutcome[] = [];
    for (const a of agents.data as { id: string; label: string; ens_name: string }[]) {
      try {
        const jobs = await loadAgentReputationJobs(a.id);
        const rep = computeReputation(jobs, now);
        const json = JSON.stringify(rep);
        const onChain = await sepoliaClient.getEnsText({
          name: normalize(a.ens_name),
          key: REPUTATION_KEY,
        });
        if (!needsUpdate(onChain, rep)) {
          if (!sameReputation(onChain, cached.get(a.label))) await refreshDirectory(a.label);
          out.push({ label: a.label, written: false, json: onChain ?? "" });
          continue;
        }
        const tx = await setReputation(a.label, json);
        await refreshDirectory(a.label);
        out.push({ label: a.label, written: true, json, tx: etherscanTx(tx) });
      } catch (err) {
        logError("cron", `reputation for ${a.label} failed`, err);
      }
    }
    log("cron", "reputation batch done", {
      agents: out.length,
      written: out.filter((o) => o.written).length,
    });
    return out;
  } finally {
    running = false;
  }
}
