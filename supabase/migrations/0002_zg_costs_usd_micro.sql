-- 0G Router bills and reports balances in micro-USD (1_000_000 = $1), not neuron
-- (verified in the P0.2 spike, see docs/07). Rename the cost columns to match.
alter table agents rename column daily_cap_neuron to daily_cap_usd_micro;
alter table jobs rename column zg_cost_neuron to zg_cost_usd_micro;
alter view agent_usage_today rename column spent_neuron to spent_usd_micro;
