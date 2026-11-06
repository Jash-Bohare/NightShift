# NightShift: Environments, Local Development and Staging Setup

All paths are relative to the repository root `NightShift/`. Commands run in Git Bash, WSL, macOS or Linux shells. On PowerShell, prefix pnpm commands with `corepack`.

## 1. Environment matrix

Production and staging **never share** keys, databases or HCS topics.

| | Unit tests | Simulated local stack | Staging (integration) | Production |
|---|---|---|---|---|
| How | `pnpm test:all` | `pnpm dev:simulated` | `pnpm -C server start` with a staging `.env` | hosted server + web |
| Database | none / in-memory fake / embedded Postgres (PGlite) | in-memory (`NIGHTSHIFT_SIMULATION=true`) | **dedicated staging Supabase project** (or local `supabase start`) | production Supabase |
| x402 facilitator | local stand-in | local stand-in (loopback, enforced) | `https://x402.org/facilitator` (testnet) | testnet/mainnet facilitator |
| 0G | mocked | local stand-in (loopback, enforced) | real Router with a **QA** `sk-` key and small cap | real Router |
| Sepolia | mocked | **live, read-only** (public RPC) | live (read); writes only with a QA operator, if ever | live |
| HCS | mocked | off (`HCS_SUBMIT_ENABLED=false`, enforced) | off, or a **separate QA topic** | production topic |
| Scheduled jobs | n/a | off (enforced) | `CRONS_ENABLED=false` unless testing a cron | `CRONS_ENABLED=true` |
| Payouts | mocked sender | off (enforced) | `PAYOUTS_ENABLED=false` | only after explicit approval |
| Secrets needed | none | **none** | QA-only set (§4) | production secret manager |

The server refuses these configurations at startup:

- `NIGHTSHIFT_SIMULATION=true` together with `NODE_ENV=production`.
- Simulation with a non-loopback facilitator or 0G URL.
- Simulation with HCS, crons, payouts or the paid console enabled.
- `PAYOUTS_ENABLED=true` without `CRONS_ENABLED=true`.

## 2. Prerequisites

```bash
corepack enable && corepack prepare pnpm@10.34.7 --activate   # Node >= 20
git submodule update --init --recursive                        # contracts only
pnpm install
```

## 3. Simulated local stack (no secrets): full frontend + backend

```bash
# terminal 1: real server on :8787 + simulated facilitator, 0G and database
pnpm dev:simulated
# optional: let your own Privy dev account see the dashboard
#   SIMULATED_OWNER_PRIVY_USER_ID=did:privy:<you> PRIVY_APP_ID=<dev app> PRIVY_APP_SECRET=<dev secret> pnpm dev:simulated

# terminal 2: web app on :3000
pnpm -C web dev            # web/.env.local only needs NEXT_PUBLIC_* (see .env.example)

# terminal 3: a complete SIMULATED buyer run (real ENS verification, simulated payment)
pnpm simulate:buyer
```

**What is real:**

- The Express server, route order, x402 middleware and hooks.
- Signed quotes, nonce redemption, budget logic, job and settlement code.
- Live Sepolia ENS and registry reads, by both the server and the buyer.
- All buyer verification logic.

**What is simulated, and labelled so:**

- Payments. Settlement ids start with `SIMULATED-NOT-A-HEDERA-TX`, and no HashScan link is shown.
- 0G transcripts. Request ids start with `SIMULATED-0G-`.
- The database. It is in memory and resets on restart.
- Mirror Node confirmation.

The stack **forces** all safety variables and overrides any `.env` on disk. Port 8787 is required because the agents' on-chain `agent-endpoint[x402]` records point at `http://localhost:8787`.

## 4. Staging (integration) environment

### 4.1 Database: choose one

**A. Local Supabase (Docker Desktop required).** This is the recommended option.

```bash
pnpm exec supabase start          # Postgres + PostgREST + Auth on localhost
pnpm exec supabase db reset       # applies supabase/migrations/0001..0006
pnpm exec supabase db lint
pnpm exec supabase status         # prints the local API URL and service_role key (local only)
```

**B. A new, dedicated Supabase project** (never `bklxturxluiennzmrfxw`).

```bash
pnpm exec supabase link --project-ref <STAGING_REF>
pnpm exec supabase db push --dry-run   # review: 0001..0006
pnpm exec supabase db push
pnpm exec supabase migration list
```

Docker Compose is intentionally not provided. A plain Postgres container lacks PostgREST, which the server talks to; `supabase start` is the supported local stack.

**Migration validation without Docker.** This command applies 0001–0006 to embedded Postgres and checks the schema, RLS for anon / authenticated / service_role, the RPC grants, reservation TTLs and payout idempotency:

```bash
pnpm -C server test:db
```

**RLS check on a staging project.** Run this with the **anon** key. Every call must fail or return an empty array:

```bash
for t in jobs payouts buyer_events agents owners agent_secrets quote_redemptions settlement_recoveries agent_budget_reservations; do
  curl -s "$STAGING_SUPABASE_URL/rest/v1/$t?select=*&limit=1" -H "apikey: $STAGING_ANON_KEY" -H "Authorization: Bearer $STAGING_ANON_KEY"; echo " <- $t"
done
```

### 4.2 Staging server `.env`

Create it at the repository root and never commit it. All values are **QA-only**.

```
NODE_ENV=development
CRONS_ENABLED=false
PAYOUTS_ENABLED=false
BUYER_CONSOLE_ENABLED=false
HCS_SUBMIT_ENABLED=false
NIGHTSHIFT_SIMULATION=false
SUPABASE_URL=<staging/local>          SUPABASE_SERVICE_ROLE_KEY=<staging/local>
SECRETS_MASTER_KEY=<new: openssl rand -hex 32>
NIGHTSHIFT_QUOTE_SIGNING_PRIVATE_KEY=<new QA pair>  NIGHTSHIFT_QUOTE_VERIFY_PUBLIC_KEY=<matching>
ZG_ROUTER_URL=https://router-api.0g.ai/v1  ZG_TEAM_SK_KEY=<QA key, low credit>
HEDERA_OPERATOR_ID / HEDERA_OPERATOR_KEY=<QA testnet account, low balance>
ENS_OPERATOR_PRIVATE_KEY=<QA key with no registrar role>   # writes are not needed with crons off
PRIVY_APP_ID / PRIVY_APP_SECRET=<Privy dev app>
… remaining variables from .env.example
```

Generate a QA quote key pair. The private key never leaves the staging server:

```bash
node -e "const {generateKeyPairSync}=require('crypto');const k=generateKeyPairSync('ed25519');console.log('NIGHTSHIFT_QUOTE_SIGNING_PRIVATE_KEY='+k.privateKey.export({format:'der',type:'pkcs8'}).toString('base64'));console.log('NIGHTSHIFT_QUOTE_VERIFY_PUBLIC_KEY='+k.publicKey.export({format:'der',type:'spki'}).toString('base64'))"
```

Seed staging agents with `pnpm -C scripts exec tsx seed-agents.ts --dry-run`, and review the output before running it for real. Note that creating agents registers ENS names (real Sepolia transactions with the operator key), so this requires the owner's explicit approval. For read-only staging, insert rows that mirror the existing live agents instead; `server/src/dev/simulated-stack.ts` `seedFromSepolia` shows exactly which fields to use.

### 4.3 Startup and checks

```bash
pnpm -C server start
curl localhost:8787/live
curl localhost:8787/ready                     # 4 checks; 503 names the failing dependency generically
curl "localhost:8787/a/<label>/quote?units=2"
pnpm -C buyer start -- --preflight            # read-only; needs BUYER_SERVER_URL, SEPOLIA_RPC_URL, HEDERA_MIRROR_URL, NIGHTSHIFT_QUOTE_VERIFY_PUBLIC_KEY
```

## 5. Test commands

| Scope | Command |
|---|---|
| Everything (unit + simulated E2E + DB) | `pnpm test:all` |
| Simulated end-to-end only | `pnpm -C server test:e2e` |
| Migrations / RLS on Postgres | `pnpm -C server test:db` |
| Types / lint / format | `pnpm typecheck`, `pnpm lint`, `pnpm format:check` (fails on 59 pre-existing files) |
| Web production build | `pnpm -C web build` |
| Contracts | `pnpm -C contracts test:unit` from WSL or Git Bash, once Foundry is installed and the submodules are restored |

## 6. Reconciliation runbook (operators)

These states are never resolved automatically.

| State | How to resolve |
|---|---|
| `jobs.status = 'needs_reconciliation'` with `error = 'zg_billing_unavailable'` | 0G executed but its cost was not established. The buyer was **not** charged. Look up `zg_request_id` in 0G `GET /v1/account/usage/history`, then set `zg_cost_usd_micro`. Release the retained reservation with `select release_agent_budget('<reservation id>')` (service role). |
| `jobs.status = 'needs_reconciliation'` with a settlement-outcome-unknown error | Search the Hedera Mirror Node for a transfer from the buyer to the worker's pay-to for the job amount. If one exists, set the job to `settled` with `hedera_tx_id`; otherwise set `settle_failed`. **Never** re-run the paid request. |
| `payouts.status = 'uncertain'` | Query the Mirror Node for the exact transfer before changing state; never resend. |
| Buyer `.buyer-run.lock` left behind | The buyer could not confirm a payment outcome. Resolve the transaction as above, then delete the lock file. |
| Normal reservations | These expire automatically after 15 minutes (migration 0006). |
