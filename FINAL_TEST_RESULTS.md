# NightShift: Final Test Results

**Run date:** 2026-11-06 · **Machine:** Windows 11, Node v24.11.1, pnpm 10.34.7 (corepack)
**Code state:** branch `main` @ `8f2ea10` plus a **large uncommitted working tree**, which includes the integration work below. Nothing has been committed or pushed.
**Safety:** no real payment, USDC transfer, payout, 0G inference, HCS message, contract deployment, migration of any hosted database, or production deployment was performed. Live network access was limited to **read-only** Sepolia RPC calls, Hedera Mirror Node reads, the public 0G `/models` list and the public facilitator `/supported` list.

## 1. Summary

| Category | Passed | Failed | Blocked |
|---|---|---|---|
| Buyer tests | 48 / 48 (12 files) | 0 | 0 |
| Server tests | 140 / 140 (28 files) | 0 | 0 |
| ↳ simulated end-to-end + API-contract scenarios | 16 | 0 | 0 |
| ↳ Postgres migration / RLS / RPC scenarios (PGlite) | 10 | 0 | 0 |
| Web tests | 25 / 25 (7 files) | 0 | 0 |
| Typecheck (5 packages) | ✔ | — | — |
| ESLint | ✔ | — | — |
| Prettier (repo-wide) | — | ✘ 56 files (pre-existing; was 59) | — |
| Web production build | ✔ (7 routes) | — | — |
| Running simulated stack + simulated buyer (live HTTP) | ✔ | — | — |
| Web pages served against the running backend (7 routes) | ✔ 200 | — | — |
| Deterministic demo (`scripts demo`) | ✔ | — | — |
| Buyer preflight (needs a real or staging server config) | — | — | NOT CONFIGURED |
| Production `server start` without `.env` | — | ✘ (expected: config validation lists missing vars) | — |
| Contract tests (Foundry) | — | — | BLOCKED |
| Hosted Supabase migration / RLS | — | — | BLOCKED (no credentials; must not touch production) |
| Real paid end-to-end | — | — | BLOCKED (approval required) |

## 2. Commands executed (from `NightShift/`)

| Command | Exit | Result |
|---|---|---|
| `corepack pnpm -C buyer test` | 0 | 48 passed |
| `corepack pnpm -C server test` | 0 | 140 passed |
| `corepack pnpm -C web test` | 0 | 25 passed |
| `corepack pnpm -r --if-present typecheck` | 0 | shared, buyer, web, server, scripts |
| `corepack pnpm lint` | 0 | no findings |
| `corepack pnpm format:check` | 1 | 56 files unformatted (pre-existing files; every file changed in this work was formatted) |
| `corepack pnpm -C web build` | 0 | Next.js 16.4.2, 7 routes |
| `corepack pnpm -C scripts demo` | 0 | all lines `[SIMULATED]` |
| `corepack pnpm -C buyer start -- --preflight` | 2 | NOT CONFIGURED: `BUYER_SERVER_URL`, `SEPOLIA_RPC_URL`, `HEDERA_MIRROR_URL`, `NIGHTSHIFT_QUOTE_VERIFY_PUBLIC_KEY` |
| `corepack pnpm -C server start` (no `.env`) | 1 | `[config] invalid environment`, names only, no values |
| `corepack pnpm -C server dev:simulated` | running | real server on :8787; 3 workers seeded from **live Sepolia** (tamil-scribe, kural, chennai-ears; expiry 2026-12-05); log: `scheduled jobs disabled (CRONS_ENABLED=false)` |
| `corepack pnpm -C server simulate:buyer` | 0 | `plan → discover(3) → verify×3 (live ENS ok) → decide kural → quote → refused (503 over_budget) → decide tamil-scribe → quote 60000 → result`; `success:true, jobVerified:true, settlementVerified:true`, settlement id `SIMULATED-NOT-A-HEDERA-TX-1` |
| `curl` probes of 13 endpoints on the simulated stack | — | public 200; `/me`, `/me/jobs`, `/buyer-console/budget`, `/jobs/:id/status` → 401 without a token; quote `Cache-Control: no-store`; CORS allows `http://localhost:3000`; `/ready` 503 when the Mirror Node URL was a dead loopback (honest), fixed by pointing to the public mirror |
| `next start` + `curl` of `/`, `/directory`, `/agents/tamil-scribe`, `/agents/kural`, `/console`, `/dashboard`, `/launch` | — | all 200 against the running backend (the shell only; data renders client-side, and its contracts are covered by the API-contract tests) |

## 3. New automated coverage (this work)

| File | Tests | What it proves |
|---|---|---|
| `server/src/e2e/simulated-flow.test.ts` | 16 | Real app, real x402 middleware and hooks, real buyer, against a local facilitator, simulated 0G, simulated DB and simulated chain reads: full happy path with refusal → fallback; paused worker unchanged by unpaid requests and its quote survives the paid retry; expired or revoked worker refused before payment; expired, tampered, cheaper and other-payee quotes rejected; replay rejected (1 execution, 1 settlement); concurrent duplicates → exactly one execution and settlement; uncertain settlement → `needs_reconciliation`, no retry; definite refusal → `settle_failed`; missing 0G billing → output withheld, not charged, reservation retained; owner isolation with **real ES256 Privy verification** (expired, forged signature, wrong audience, wrong issuer, malformed → 401); buyer-console allow-list (401, 403, 200); API contracts for landing, directory, profile and dashboard pages (parsed with the web's own validator) |
| `server/src/db/migrations.test.ts` | 10 | 0001→0006 apply on real Postgres; anon/authenticated cannot read or write the 9 private tables; directory public-read only; service_role bypass; RPCs not executable by anon/authenticated; digest CHECK; nonce uniqueness 23505; reservation cap, 15-minute TTL, release; uncertain retention 365 days at the remaining cap; payout claim idempotent per day; **pre-0005 databases expose `buyer_events` transcripts to anon** |
| `server/src/zg/router.test.ts` | 9 | 0G billing adapter: `total_cost_usd_micro`; documented `currency:"usd"` `total_cost` fallback with component check; zero accepted only when explicit; wei never converted; malformed, negative, non-finite or unsafe rejected; request id preserved |
| `server/src/cron/schedule.test.ts` | 3 | nothing scheduled or run when `CRONS_ENABLED=false`; payouts only with both flags; UTC; errors contained |
| `server/src/config.test.ts` | 5 | safe defaults; `PAYOUTS_ENABLED` without `CRONS_ENABLED` refused; ambiguous flags refused; console allow-list required; secret values not echoed in errors |
| `server/src/lifecycle.test.ts` | 6 | quote ↔ worker binding; settlement failure classification; rate limiter |
| `web/lib/owner.test.ts` | 3 | `/me/jobs` contract validation; reconciliation labels |

## 4. Infrastructure and contract checks (read-only)

| Check | Result |
|---|---|
| Sepolia chain id / block | 11155111 / ~12.075M |
| Registrar `0x9564…5705`, UserRegistry `0x6817…2425` | code present; `operator`, `admin`, `paused=false`; `REGISTRY()` = configured UserRegistry |
| **ABI compatibility** | `shared/abi/NightshiftRegistrar.json` covers every public function in `contracts/src/NightshiftRegistrar.sol`; 15 view calls through the shared ABI decode correctly against the deployed contract |
| Agents | `tamil-scribe`, `kural`, `chennai-ears`: REGISTERED, expire **2026-12-05**; ENS records readable; endpoints `http://localhost:8787/a/<label>/run` |
| HCS topic `0.0.11129931` | exists; newest messages (seq 10–12) lack `output_sha256`, so the current code has never run live |
| x402.org facilitator | supports `exact` on `hedera:testnet` |
| 0G Router | `/models` reachable; official docs confirm the `x_0g_trace.billing` fields used by the adapter |

## 5. Blocked items and exact unblock steps

| Item | Requirement |
|---|---|
| Contract tests | Install Foundry (WSL: `curl -L https://foundry.paradigm.xyz \| bash && foundryup`). The submodule working trees are incomplete: `contracts/lib/forge-std` has deleted files, and nested `contracts-v2` libs show local `+` divergence and empty trees. I did **not** reset them, to avoid overwriting existing work. The owner should run `git -C contracts/lib/forge-std checkout -- .` and `git submodule update --init --recursive`, then `pnpm -C contracts test:unit`. |
| Hosted DB validation | A **new** staging Supabase project or `supabase start` (Docker). See `STAGING_SETUP.md` §4. |
| Buyer preflight | A staging server plus `BUYER_SERVER_URL`, `SEPOLIA_RPC_URL`, `HEDERA_MIRROR_URL`, `NIGHTSHIFT_QUOTE_VERIFY_PUBLIC_KEY`. |
| Real paid E2E | `REMAINING_WORK.md` P2. Needs explicit approval for ~0.06 test USDC + ~$0.0125 of 0G credits. |
