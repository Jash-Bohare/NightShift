-- Nightshift initial schema (docs/04-backend.md).
create extension if not exists pgcrypto;

create table owners (
  id uuid primary key default gen_random_uuid(),
  privy_user_id text unique not null,
  evm_address text not null,
  hedera_payout_account text,            -- e.g. 0.0.12345, nullable
  created_at timestamptz default now()
);

create type agent_status as enum ('pending','active','paused_owner','paused_budget','expired','revoked','failed');

create table agents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references owners(id) not null,
  label text unique not null,
  ens_name text unique not null,
  skill text not null,                   -- e.g. 'transcribe:ta'
  model text not null,                   -- 0G model id
  price_atomic bigint not null,          -- USDC smallest unit per unit
  price_unit text not null,              -- 'minute' | 'page' | 'request'
  daily_cap_neuron numeric(78,0) not null,
  status agent_status not null default 'pending',
  hedera_account_id text,
  resolver_address text,
  register_tx text,
  expiry timestamptz,
  created_at timestamptz default now()
);

create table agent_secrets (            -- NO anon policies. Service role only.
  agent_id uuid primary key references agents(id) on delete cascade,
  zg_api_key_enc text not null,
  zg_mgmt_key_enc text,
  hedera_private_key_enc text not null
);

create type job_status as enum ('running','done','settled','failed_upstream','failed_internal','settle_failed','refused_budget');

create table jobs (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references agents(id) not null,
  buyer_account text,                    -- Hedera payer from settle response
  status job_status not null,
  units numeric not null,
  price_atomic bigint not null,          -- total charged
  zg_request_id text,
  zg_provider text,
  zg_cost_neuron numeric(78,0),
  hedera_tx_id text,
  hcs_sequence bigint,
  latency_ms int,
  error text,
  created_at timestamptz default now()
);
create index on jobs (agent_id, created_at desc);

create table payouts (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references agents(id) not null,
  payout_date date not null,
  gross_atomic bigint not null,
  owner_atomic bigint not null,
  fee_atomic bigint not null,
  hedera_tx_id text,
  schedule_id text,
  created_at timestamptz default now(),
  unique (agent_id, payout_date)
);

create table directory (                -- indexer cache, rebuilt from chain events
  label text primary key,
  ens_name text not null,
  owner text not null,
  resolver text not null,
  skill text, price_atomic bigint, price_unit text, payto text,
  endpoint text, reputation jsonb, expiry timestamptz,
  last_block bigint, updated_at timestamptz default now()
);

-- today's spend per agent (UTC day). security_invoker so the view honours the
-- caller's RLS instead of running with the owner's rights.
create view agent_usage_today with (security_invoker = true) as
  select agent_id,
         coalesce(sum(zg_cost_neuron),0) as spent_neuron,
         count(*) filter (where status='settled') as jobs_settled,
         coalesce(sum(price_atomic) filter (where status='settled'),0) as earned_atomic
  from jobs
  where created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'
  group by agent_id;

-- RLS: public read on non-secret tables (data is public on-chain anyway), no anon writes.
alter table owners enable row level security;
alter table agents enable row level security;
alter table agent_secrets enable row level security;
alter table jobs enable row level security;
alter table payouts enable row level security;
alter table directory enable row level security;
create policy "public read agents"    on agents    for select using (true);
create policy "public read jobs"      on jobs      for select using (true);
create policy "public read payouts"   on payouts   for select using (true);
create policy "public read directory" on directory for select using (true);
-- owners: no anon read (has privy ids). agent_secrets: no policies at all.

alter publication supabase_realtime add table jobs, payouts, agents;
