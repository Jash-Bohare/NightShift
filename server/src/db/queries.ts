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

export async function setAgentStatus(agent: AgentRow, status: AgentStatus): Promise<void> {
  must(
    "set agent status",
    await db.from("agents").update({ status }).eq("id", agent.id).select("id"),
  );
  agentCache.delete(agent.label);
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
