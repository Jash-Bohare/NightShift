// Row shapes for supabase/migrations 0001 + 0002. bigint/numeric columns may arrive as
// number or string from PostgREST; convert with big() before arithmetic.
export type AgentStatus =
  "pending" | "active" | "paused_owner" | "paused_budget" | "expired" | "revoked" | "failed";

export type JobStatus =
  | "running"
  | "done"
  | "settled"
  | "failed_upstream"
  | "failed_internal"
  | "settle_failed"
  | "refused_budget";

type Num = number | string;

export interface AgentRow {
  id: string;
  owner_id: string;
  label: string;
  ens_name: string;
  skill: string;
  model: string;
  price_atomic: Num;
  price_unit: string;
  daily_cap_usd_micro: Num;
  status: AgentStatus;
  hedera_account_id: string | null;
  resolver_address: string | null;
  register_tx: string | null;
  expiry: string | null;
  created_at: string;
}

export interface AgentSecretsRow {
  agent_id: string;
  zg_api_key_enc: string;
  zg_mgmt_key_enc: string | null;
  hedera_private_key_enc: string;
}

export interface JobRow {
  id: string;
  agent_id: string;
  buyer_account: string | null;
  status: JobStatus;
  units: Num;
  price_atomic: Num;
  zg_request_id: string | null;
  zg_provider: string | null;
  zg_cost_usd_micro: Num | null;
  hedera_tx_id: string | null;
  hcs_sequence: Num | null;
  latency_ms: number | null;
  error: string | null;
  created_at: string;
}

export interface UsageTodayRow {
  agent_id: string;
  spent_usd_micro: Num;
  jobs_settled: Num;
  earned_atomic: Num;
}
