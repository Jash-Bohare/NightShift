# NightShift: Teammate Integration Testing Guide

**For:** a teammate testing the frontend and backend together, safely, on their own machine.
**Status (2026-11-06):** frontend ↔ backend integration testing is **ready on the simulated local stack**. It needs **no secrets and no money**. Testing against a real staging database and real 0G/Hedera is **not ready yet** (§9).

---

## 1. Get the right code

The integration work is **not on GitHub until the project owner commits and pushes it**. Ask the owner for the branch name, then:

```bash
git clone --recurse-submodules https://github.com/krisha-9/NightShift.git
cd NightShift
git checkout <branch from the owner>
git log -1 --oneline            # note the commit id for bug reports
ls supabase/migrations/0006_reconciliation_and_reservation_ttl.sql server/src/dev/simulated-stack.ts
```

If either file is missing, you have old code. Stop and ask the owner.

## 2. Prerequisites

- Node.js 20 or newer.
- pnpm 10.34.7: `corepack enable && corepack prepare pnpm@10.34.7 --activate`. On PowerShell, prefix commands with `corepack`.
- Internet access. The stack reads live Sepolia through a public RPC; these reads are read-only.
- Ports **8787**, **8403** and **3000** free.

```bash
pnpm install
```

## 3. Environment configuration

- **Backend:** nothing to configure. `pnpm dev:simulated` forces safe values (in-memory database, local simulated facilitator and 0G, no HCS, no crons, no payouts, paid console disabled), even if a `.env` file exists.
- **Optional, dashboard sign-in:** if the owner gives you a Privy **development** app, set these before `pnpm dev:simulated`:
  - `PRIVY_APP_ID`
  - `PRIVY_APP_SECRET`
  - `SIMULATED_OWNER_PRIVY_USER_ID=did:privy:<your id>` (makes you the owner of `tamil-scribe`)

  Receive these over a private channel only.
- **Frontend:** create `web/.env.local` with **public** values only:

  ```
  NEXT_PUBLIC_SERVER_URL=http://localhost:8787
  NEXT_PUBLIC_PRIVY_APP_ID=             # same dev app id, or blank (sign-in then shows "unavailable")
  NEXT_PUBLIC_SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
  NEXT_PUBLIC_ENS_PARENT_NAME=nightshift.eth
  NEXT_PUBLIC_NIGHTSHIFT_REGISTRAR_ADDRESS=0x9564fFd96FBaA1bF10836966990aCc88a9865705
  NEXT_PUBLIC_HEDERA_HCS_TOPIC_ID=0.0.11129931
  ```

## 4. Start the services

```bash
pnpm dev:simulated     # terminal 1. Wait for "listening on :8787"; it lists 3 workers seeded from Sepolia
pnpm -C web dev        # terminal 2. http://localhost:3000
```

Restarting `dev:simulated` clears all data (the database is in memory).

## 5. Automated tests (run first and record the counts)

```bash
pnpm test:all          # buyer 48, server 140 (incl. 16 simulated end-to-end + 10 Postgres/RLS), web 25
pnpm typecheck
pnpm lint
pnpm -C web build
```

## 6. Backend API scenarios (stack running)

Use `curl -i`. Expected results are taken from verified runs. The full contract is in `BACKEND_API_CONTRACT.md`.

| # | Request | Expected |
|---|---|---|
| B1 | `GET /live` | 200 `{"ok":true}` |
| B2 | `GET /ready` | 200 with zg, hedera, sepolia and supabase all `ok:true` (503 if your internet blocks the public RPC or Mirror Node) |
| B3 | `GET /directory?skill=transcribe:ta` | 200, `total: 3` (kural, tamil-scribe, chennai-ears), cheapest first |
| B4 | `GET /directory?skill=transcribe:hi` | 200, `total: 0` |
| B5 | `GET /directory?limit=500` | 422 `invalid_input` |
| B6 | `GET /directory/kural.nightshift.eth` | 200, `payTo: 0.0.11325237`, price 20000 |
| B7 | `GET /agents/tamil-scribe` | 200; `ens` holds live Sepolia records (`nightshift.price`, `nightshift.payto`, …) |
| B8 | `GET /a/tamil-scribe/quote?units=2` | 200 `amount "60000"`, `expiresAt` 120 s after `issuedAt`, header `Cache-Control: no-store` |
| B9 | `GET /a/nobody-here/quote` and `GET /a/BAD_LABEL/quote` | 404, 422 |
| B10 | `POST /a/tamil-scribe/run` with no headers | 422 (units header required); **no 402, nothing written** |
| B11 | `GET /me`, `GET /me/jobs`, `GET /buyer-console/budget` without a token | 401 each |
| B12 | `GET /jobs/<any uuid>/status` without a token | 401 |
| B13 | `POST /buyer-console/run` | 401 without a token. With an allow-listed token it is still 503 `feature_disabled` (paid console is off) |
| B14 | `GET /stats` before and after §8 | `jobsToday` 0 → 1, `usdcToday` "0" → "60000", `reconciliationRequiredToday` 0 |
| B15 | 61 quote requests within a minute from one shell | The 61st gets 429 with a `Retry-After` header |

## 7. Frontend ↔ backend scenarios

Check at **1280 px, 768 px and 390 px**.

| # | Page | Steps | Expected |
|---|---|---|---|
| F1 | `/` | Load; repeat after §8 | Stats come from `/stats` (compare with B14). Every number shown must match the API; anything unavailable is shown as unavailable, never invented. |
| F2 | `/directory` | Load; filter by skill and price; sort; page | 3 workers with correct price, skill and status; filters change results; empty filter shows the empty state |
| F3 | `/directory` with the backend stopped | Stop terminal 1 and reload | Error panel with **Retry**; no fabricated data; Retry works after restart |
| F4 | `/agents/tamil-scribe` | Load | Profile, live ENS records, a fresh quote (0.06 USDC for 2 min) and job history (empty, then 1 settled job after §8) |
| F5 | `/agents/kural` | Load | Price 0.02 USDC/min |
| F6 | `/console` (not signed in) | Load | "Buyer budget is private"; the Run button asks you to sign in; **nothing is paid by opening the page** |
| F7 | `/console` (signed in, not allow-listed) | Load | The budget area shows the server's 403 ("not permitted to use the buyer console"). Run stays disabled. Even an allow-listed user gets 503 `feature_disabled`, because the paid console is off. |
| F8 | `/dashboard` (Privy configured, your id seeded) | Sign in | Owner address, **only** `tamil-scribe`, registration expiry 2026-12-05, and job history (after §8: 1 job, "Paid · settled"). No outputs or buyer accounts. |
| F9 | `/dashboard` (other Privy user) | Sign in | "No workers are registered to this account." |
| F10 | `/launch` | Walk through all steps | Validation works; final step says launch is unavailable; nothing is submitted; no private key fields |

## 8. Mock payment workflow (SIMULATED)

```bash
pnpm simulate:buyer    # terminal 3, stack running
```

**Expected output, in order:** `plan` → `discover` (3) → `verify` ×3 (**live Sepolia ENS**, ok=true) → `decide kural` → `quote` → `refused` (503 over_budget, **not charged**) → `decide tamil-scribe` → `quote` 60000 → `result` (`[SIMULATED 0G transcript …]`).

The final JSON shows:

- `success: true`
- `jobVerified: true`
- `settlementVerified: true`
- `simulatedSettlementId: SIMULATED-NOT-A-HEDERA-TX-1`

There is no `paid` event or HashScan link, because a simulated settlement has none. That is intended.

Then re-check B14, F1, F4 and F8. Running `simulate:buyer` again succeeds again with a new quote. Each signed quote can only be paid once; replay rejection is covered by the automated suite.

**Automated failure scenarios** (`pnpm -C server test:e2e`, 16 tests):

- Refusal → fallback.
- A `paused_budget` worker stays paused on unpaid requests, and its quote survives the paid retry.
- Expired or revoked workers are refused.
- Expired, tampered and mismatched quotes are rejected.
- Replay and concurrent duplicates are rejected.
- An uncertain settlement leads to `needs_reconciliation` with no retry.
- A definite refusal leads to `settle_failed`.
- Missing 0G billing: output withheld, buyer not charged, reservation retained.
- Owner isolation through real ES256 token checks (expired, forged, wrong audience, wrong issuer).
- API contracts for every page.

## 9. Not ready yet

- **Real staging database, real 0G or Hedera:** the owner must first create a dedicated staging Supabase project and QA keys (`STAGING_SETUP.md` §4).
- **Real paid runs:** blocked until owner approval (`REMAINING_WORK.md`).

## 10. Prohibited actions

1. Do not run `pnpm -C buyer start` (without `--preflight`), `scripts/pay-run.ts`, or the paid console with real credentials. These spend real test USDC and 0G credits.
2. Do not set `PAYOUTS_ENABLED`, `CRONS_ENABLED`, `BUYER_CONSOLE_ENABLED` or `HCS_SUBMIT_ENABLED` to `true` anywhere.
3. Do not run `supabase link`, `db push` or `db:push` against any shared project, especially `bklxturxluiennzmrfxw`.
4. Do not run any `contracts` `deploy:*` or `smoke:*` script, `forge script --broadcast`, `create-agent-cli.ts`, or `seed-agents.ts` without `--dry-run`.
5. Do not edit the database or delete lock files to "unblock" something. Report it instead.
6. Do not paste keys, tokens or `.env` contents into issues, chat or screenshots. Do not put non-`NEXT_PUBLIC_` values in `web/.env.local`.
7. Do not present `SIMULATED` ids or transcripts as real payments or inference.

## 11. Bug report template

```
Title: [API|Web|Buyer|DB] short description
Commit: <git log -1 --oneline>          Stack: simulated / staging
Environment: OS, Node, browser + version, viewport width
Request or page: e.g. GET /directory?skill=…  or  /dashboard
Steps:
  1.
Expected (cite the guide row, e.g. "F4"):
Actual (HTTP status + body, console errors, screenshot):
Severity: Blocker / Major / Minor / Cosmetic
Secrets redacted?: yes
```
