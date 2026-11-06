-- 0006: explicit reconciliation state and bounded budget reservations.
--
-- 1. jobs.status 'needs_reconciliation': 0G executed without establishable billing, or the x402
--    settlement outcome is unknown. Never retried automatically; an operator reconciles it
--    (0G GET /v1/account/usage/history by zg_request_id; Hedera Mirror Node by transaction).
-- 2. settlement_recoveries may target that state.
-- 3. Normal budget reservations expire after 15 minutes, so a crashed request cannot block a
--    worker indefinitely. Reservations retained because 0G billing is uncertain keep the
--    long expiry set by retain_uncertain_agent_budget (0005).

alter type job_status add value if not exists 'needs_reconciliation';

alter table settlement_recoveries
  drop constraint if exists settlement_recoveries_desired_status_check;
alter table settlement_recoveries
  add constraint settlement_recoveries_desired_status_check
  check (desired_status in ('settled', 'settle_failed', 'needs_reconciliation'));

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
  values (p_agent_id, p_amount_usd_micro, now() + interval '15 minutes')
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function reserve_agent_budget(uuid, numeric) from public, anon, authenticated;
grant execute on function reserve_agent_budget(uuid, numeric) to service_role;

comment on table agent_budget_reservations is
  'Service-role only budget reservations: 15-minute expiry for in-flight jobs; long expiry only when 0G billing is uncertain (retain_uncertain_agent_budget).';
