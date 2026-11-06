// Typed queries used by the run path. Service-role client; never expose rows from agent_secrets.
import { env } from "../config.js";
import { decrypt } from "../crypto.js";
import { UpstreamError } from "../errors.js";
import { db, must } from "./client.js";
import type { AgentRow, AgentStatus, JobRow, JobStatus } from "./types.js";

const agentCache = new Map<string, { at: number; agent: AgentRow | null }>();
const AGENT_TTL_MS = 5_000;

/** Agent by ENS label, cached for 5 s (the x402 price/payTo callbacks call this per request). */
export async function agentByLabel(label: string, fresh = false): Promise<AgentRow | null> {
  const hit = agentCache.get(label);
  if (!fresh && hit && performance.now() - hit.at < AGENT_TTL_MS) return hit.agent;
  const r = await db.from("agents").select("*").eq("label", label).maybeSingle();
  if (r.error) throw new UpstreamError("db", `agent ${label}: ${r.error.message}`);
  const agent = (r.data as AgentRow | null) ?? null;
  agentCache.set(label, { at: performance.now(), agent });
  return agent;
}

/** Test hook: forget cached agent rows (the simulated end-to-end suite reseeds its database). */
export function clearAgentCache(): void {
  agentCache.clear();
}

/** Drop one cached agent row so an owner change (cap, price) is read fresh on the next request. */
export function forgetAgent(label: string): void {
  agentCache.delete(label);
}

export async function setAgentStatus(agent: AgentRow, status: AgentStatus): Promise<void> {
  must(
    "set agent status",
    await db.from("agents").update({ status }).eq("id", agent.id).select("id"),
  );
  agentCache.delete(agent.label);
  // Keep the directory cache's status in step (the indexer also copies it on every sync).
  const dir = await db.from("directory").update({ status }).eq("label", agent.label);
  if (dir.error)
    throw new UpstreamError("db", `directory status ${agent.label}: ${dir.error.message}`);
}

/**
 * Compare-and-set lifecycle transition: updates only when the stored status still equals `from`,
 * so concurrent requests cannot overwrite a newer state (e.g. an owner pause or a revocation).
 * Returns whether this call performed the transition.
 */
export async function transitionAgentStatus(
  agent: AgentRow,
  from: AgentStatus,
  to: AgentStatus,
): Promise<boolean> {
  const r = await db
    .from("agents")
    .update({ status: to })
    .eq("id", agent.id)
    .eq("status", from)
    .select("id");
  if (r.error) throw new UpstreamError("db", `agent status ${from}->${to}: ${r.error.message}`);
  agentCache.delete(agent.label);
  const changed = ((r.data as unknown[] | null) ?? []).length > 0;
  if (!changed) return false;
  const dir = await db
    .from("directory")
    .update({ status: to })
    .eq("label", agent.label)
    .eq("status", from);
  if (dir.error)
    throw new UpstreamError("db", `directory status ${agent.label}: ${dir.error.message}`);
  return true;
}

export async function agentZgKey(agentId: string): Promise<string> {
  const r = await db
    .from("agent_secrets")
    .select("zg_api_key_enc")
    .eq("agent_id", agentId)
    .single();
  if (r.error) throw new UpstreamError("db", `agent secrets: ${r.error.message}`);
  return decrypt((r.data as { zg_api_key_enc: string }).zg_api_key_enc, env.SECRETS_MASTER_KEY);
}

export async function insertJob(row: {
  agent_id: string;
  status: JobStatus;
  units: number;
  price_atomic: string;
  error?: string;
}): Promise<string> {
  const r = await db.from("jobs").insert(row).select("id").single();
  if (r.error) throw new UpstreamError("db", `insert job: ${r.error.message}`);
  return (r.data as { id: string }).id;
}

export async function updateJob(
  id: string,
  patch: Partial<Omit<JobRow, "id" | "agent_id" | "created_at">>,
): Promise<void> {
  must("update job", await db.from("jobs").update(patch).eq("id", id).select("id"));
}

export async function jobById(id: string): Promise<JobRow | null> {
  const r = await db.from("jobs").select("*").eq("id", id).maybeSingle();
  if (r.error) throw new UpstreamError("db", `job ${id}: ${r.error.message}`);
  return (r.data as JobRow | null) ?? null;
}
