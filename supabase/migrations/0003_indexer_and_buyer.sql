-- Migration 0003: Indexer state, directory search indexes, and buyer events

create table if not exists indexer_state (
  id text primary key,
  last_block bigint not null default 0,
  updated_at timestamptz default now()
);

alter table indexer_state enable row level security;
create policy "public read indexer_state" on indexer_state for select using (true);

-- Initialize sepolia checkpoint to 12068000 (before tamil-scribe registration at 12068986)
insert into indexer_state (id, last_block) values ('sepolia', 12068000)
on conflict (id) do nothing;

-- Add description, model and status to directory if not present
alter table directory add column if not exists description text;
alter table directory add column if not exists model text;
alter table directory add column if not exists status text not null default 'active';

-- Indexes for directory queries and filtering
create index if not exists idx_directory_skill on directory (skill);
create index if not exists idx_directory_ens_name on directory (ens_name);
create index if not exists idx_directory_updated_at on directory (updated_at desc);

-- Durable buyer events table for SSE recovery and audit
create table if not exists buyer_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  payload jsonb not null,
  created_at timestamptz default now()
);

alter table buyer_events enable row level security;
create policy "public read buyer_events" on buyer_events for select using (true);
