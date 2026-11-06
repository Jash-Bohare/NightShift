// Owner lookups. The owner is always derived from a verified Privy user id, never from input.
import { UpstreamError } from "../errors.js";
import { db } from "./client.js";
import type { AgentRow } from "./types.js";

export interface OwnerRecord {
  id: string;
  evm_address: string;
  hedera_payout_account: string | null;
  created_at: string;
}

export async function ownerForUser(privyUserId: string): Promise<OwnerRecord | null> {
  const r = await db
    .from("owners")
    .select("id,evm_address,hedera_payout_account,created_at")
    .eq("privy_user_id", privyUserId)
    .maybeSingle();
  if (r.error) throw new UpstreamError("db", `owner lookup: ${r.error.message}`);
  return (r.data as OwnerRecord | null) ?? null;
}

/** One agent, only if it belongs to `ownerId` (ownership is part of the query). */
export async function ownedAgent(ownerId: string, agentId: string): Promise<AgentRow | null> {
  const r = await db
    .from("agents")
    .select("*")
    .eq("id", agentId)
    .eq("owner_id", ownerId)
    .maybeSingle();
  if (r.error) throw new UpstreamError("db", `owned agent ${agentId}: ${r.error.message}`);
  const agent = (r.data as AgentRow | null) ?? null;
  // Defence in depth against a query layer that ignored the owner filter.
  if (agent && agent.owner_id !== ownerId) throw new UpstreamError("db", "owner scope violated");
  return agent;
}
