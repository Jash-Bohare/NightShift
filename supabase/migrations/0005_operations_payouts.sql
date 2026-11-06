create table if not exists agent_budget_reservations (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id) on delete cascade,
  amount_usd_micro numeric(78, 0) not null check (amount_usd_micro > 0),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists agent_budget_reservations_agent_expiry_idx
  on agent_budget_reservations (agent_id, expires_at);

alter table agent_budget_reservations enable row level security;
revoke all on agent_budget_reservations from anon, authenticated;
grant all on agent_budget_reservations to service_role;

create or replace function reserve_agent_budget(
  p_agent_id uuid,
  p_amount_usd_micro numeric
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cap numeric(78, 0);
  v_spent numeric(78, 0);
  v_reserved numeric(78, 0);
  v_id uuid;
begin
  if p_amount_usd_micro is null or p_amount_usd_micro <= 0 then
    raise exception 'reservation amount must be positive';
  end if;

  select daily_cap_usd_micro into v_cap
  from agents
  where id = p_agent_id
  for update;
  if not found then
    raise exception 'agent not found';
  end if;

  delete from agent_budget_reservations where expires_at <= now();

  select coalesce(sum(zg_cost_usd_micro), 0) into v_spent
  from jobs
  where agent_id = p_agent_id
    and created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc';

  select coalesce(sum(amount_usd_micro), 0) into v_reserved
  from agent_budget_reservations
  where agent_id = p_agent_id and expires_at > now();

  if v_spent + v_reserved + p_amount_usd_micro > v_cap then
    return null;
  end if;

  insert into agent_budget_reservations (agent_id, amount_usd_micro, expires_at)
  values (p_agent_id, p_amount_usd_micro, now() + interval '365 days')
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function reserve_agent_budget(uuid, numeric) from public, anon, authenticated;
grant execute on function reserve_agent_budget(uuid, numeric) to service_role;

create or replace function release_agent_budget(p_reservation_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  delete from agent_budget_reservations where id = p_reservation_id;
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

revoke all on function release_agent_budget(uuid) from public, anon, authenticated;
grant execute on function release_agent_budget(uuid) to service_role;

create or replace function retain_uncertain_agent_budget(p_reservation_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_agent_id uuid;
  v_cap numeric(78, 0);
  v_spent numeric(78, 0);
  v_amount numeric(78, 0);
begin
  select agent_id into v_agent_id
  from agent_budget_reservations
  where id = p_reservation_id;
  if not found then
    return false;
  end if;

  select daily_cap_usd_micro into v_cap
  from agents
  where id = v_agent_id
  for update;
  if not found then
    raise exception 'agent not found for reservation';
  end if;

  select amount_usd_micro into v_amount
  from agent_budget_reservations
  where id = p_reservation_id
  for update;
  if not found then
    return false;
  end if;

  select coalesce(sum(zg_cost_usd_micro), 0) into v_spent
  from jobs
  where agent_id = v_agent_id
    and created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc';

  update agent_budget_reservations
  set amount_usd_micro = greatest(v_amount, v_cap - v_spent),
      expires_at = now() + interval '365 days'
  where id = p_reservation_id;
  return true;
end;
$$;

revoke all on function retain_uncertain_agent_budget(uuid) from public, anon, authenticated;
grant execute on function retain_uncertain_agent_budget(uuid) to service_role;

alter table jobs
  add column if not exists payout_id uuid references payouts(id);

alter table payouts
  add column if not exists status text,
  add column if not exists destination_account text,
  add column if not exists asset text,
  add column if not exists error_code text,
  add column if not exists updated_at timestamptz not null default now();

update payouts
set status = case when hedera_tx_id is not null then 'confirmed' else 'uncertain' end
where status is null;

alter table payouts alter column status set default 'pending';
alter table payouts alter column status set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.payouts'::regclass
      and conname = 'payouts_status_check'
  ) then
    alter table payouts
      add constraint payouts_status_check
      check (status in ('pending', 'submitted', 'confirmed', 'failed', 'uncertain'));
  end if;
end;
$$;

-- Payout records include private destination and accounting information. The API
-- exposes a separately allow-listed response instead of direct table reads.
drop policy if exists "public read agents" on agents;
drop policy if exists "public read jobs" on jobs;
drop policy if exists "public read payouts" on payouts;
drop policy if exists "public read buyer_events" on buyer_events;
revoke all on agents, jobs, payouts, buyer_events from anon, authenticated;

create index if not exists payouts_status_created_idx on payouts (status, created_at);
create index if not exists jobs_unpaid_settled_idx
  on jobs (created_at, agent_id)
  where status = 'settled' and payout_id is null;

create or replace function claim_daily_payouts(
  p_payout_date date,
  p_minimum_atomic bigint,
  p_fee_bps integer,
  p_asset text
) returns setof payouts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a record;
  v_gross bigint;
  v_gross_total numeric;
  v_fee bigint;
  v_owner bigint;
  v_payout_id uuid;
begin
  if p_minimum_atomic < 1 or p_fee_bps < 0 or p_fee_bps > 10000
      or p_asset is null or p_asset !~ '^0\.0\.[0-9]+$' then
    raise exception 'invalid payout policy';
  end if;

  for a in
    select ag.id as agent_id, ag.hedera_account_id, ow.hedera_payout_account
    from agents ag
    join owners ow on ow.id = ag.owner_id
    where ag.hedera_account_id is not null
      and ow.hedera_payout_account is not null
    order by ag.id
    for update of ag skip locked
  loop
    select coalesce(sum(price_atomic), 0) into v_gross_total
    from jobs
    where agent_id = a.agent_id
      and status = 'settled'
      and payout_id is null
      and created_at < (p_payout_date::timestamp at time zone 'utc');

    if v_gross_total < p_minimum_atomic then
      continue;
    end if;

    -- PostgREST decodes bigint JSON values as JavaScript numbers. Bound payout
    -- records to the exact-integer range so the transfer layer cannot round them.
    if v_gross_total > 9007199254740991 then
      raise exception 'payout total exceeds exact atomic-unit range for agent %', a.agent_id;
    end if;
    v_gross := v_gross_total::bigint;
    v_fee := floor((v_gross_total * p_fee_bps + 5000) / 10000)::bigint;
    v_owner := v_gross_total - v_fee;
    insert into payouts (
      agent_id, payout_date, gross_atomic, owner_atomic, fee_atomic,
      status, destination_account, asset, updated_at
    ) values (
      a.agent_id, p_payout_date, v_gross, v_owner, v_fee,
      'pending', a.hedera_payout_account, p_asset, now()
    )
    on conflict (agent_id, payout_date) do nothing
    returning id into v_payout_id;

    if v_payout_id is null then
      continue;
    end if;

    update jobs
    set payout_id = v_payout_id
    where agent_id = a.agent_id
      and status = 'settled'
      and payout_id is null
      and created_at < (p_payout_date::timestamp at time zone 'utc');

    return query select * from payouts where id = v_payout_id;
  end loop;
end;
$$;

create table if not exists settlement_recoveries (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique references jobs(id),
  desired_status text not null check (desired_status in ('settled', 'settle_failed')),
  transaction_id text,
  payer_account text,
  amount_atomic bigint,
  asset text,
  status text not null default 'pending' check (status in ('pending', 'resolved')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists settlement_recoveries_due_idx
  on settlement_recoveries (next_attempt_at, created_at)
  where status = 'pending';
alter table settlement_recoveries enable row level security;
revoke all on settlement_recoveries from anon, authenticated;
grant all on settlement_recoveries to service_role;

revoke all on function claim_daily_payouts(date, bigint, integer, text) from public, anon, authenticated;
grant execute on function claim_daily_payouts(date, bigint, integer, text) to service_role;

comment on table agent_budget_reservations is
  'Service-role only, expiring atomic budget reservations used to serialize concurrent 0G jobs.';
comment on column jobs.payout_id is
  'Idempotent association to a payout batch; never clear for uncertain transfers.';
comment on column payouts.status is
  'uncertain means a transfer may have been submitted; automatic retries must not resend it.';
comment on table settlement_recoveries is
  'Service-role only retry queue for database settlement-state updates after Hedera payment callbacks.';
