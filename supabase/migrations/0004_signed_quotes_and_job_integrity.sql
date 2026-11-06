alter table jobs
  add column if not exists output_sha256 text
    check (output_sha256 is null or output_sha256 ~ '^[0-9a-f]{64}$');

create table if not exists quote_redemptions (
  nonce uuid primary key,
  quote_digest text not null check (quote_digest ~ '^[0-9a-f]{64}$'),
  agent_id uuid not null references agents(id),
  job_id uuid unique references jobs(id),
  state text not null check (state in ('verified', 'executing', 'settled', 'failed')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists quote_redemptions_expiry_idx
  on quote_redemptions (expires_at)
  where state in ('verified', 'executing');

alter table quote_redemptions enable row level security;
revoke all on quote_redemptions from anon, authenticated;
grant all on quote_redemptions to service_role;

comment on table quote_redemptions is
  'Service-role only one-time claims for signed x402 quotes; inserted after facilitator verification.';
comment on column jobs.output_sha256 is
  'SHA-256 of UTF-8 output; integrity link only, not provider authenticity.';
