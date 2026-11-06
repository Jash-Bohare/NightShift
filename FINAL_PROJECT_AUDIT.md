# NightShift: Final Project Audit (post-integration)

**Date:** 2026-11-06. This supersedes the earlier audit from the same day.
**Scope:** the full repository, including the uncommitted working tree.
**Method:** source changes with regression tests, real-Postgres migration tests, a simulated end-to-end harness around the real app and buyer, a running simulated stack, and read-only live chain and Mirror Node checks. No real payment, payout, 0G inference, HCS message, deployment or hosted-database change was made.

Related documents: `FINAL_TEST_RESULTS.md` (commands and counts), `BACKEND_API_CONTRACT.md`, `STAGING_SETUP.md`, `TEAMMATE_INTEGRATION_TESTING_GUIDE.md`, `TEAMMATE_TESTING_GUIDE.md`, `REMAINING_WORK.md`.

## 1. Executive summary

- **Integrated and working, in simulation:** frontend and backend now run together, and the full buyer → worker journey passes end to end on the real server code. That includes x402, quotes, nonce replay protection, budget, jobs, settlement, the digest, job-status verification and owner-scoped APIs. Database migrations are validated on real Postgres, including RLS.
- **Simulated pieces:** payment, 0G and the database are simulated in this mode. ENS and registry verification run against **live Sepolia**.
- **Teammate integration testing:** ready **today** on the simulated stack. It needs no secrets.
- **Not done:**
  - Nothing has been committed or pushed.
  - The live database still lacks 0005/0006, so it currently exposes transcripts to the public anon key.
  - No live paid run exists on the current code.
  - Contract tests are blocked.
  - Owner mutation APIs (launch, pause, pricing, payout account) do not exist.

## 2. Bugs fixed (with regression tests)

| # | Bug | Root cause | Fix (files) | Regression evidence |
|---|---|---|---|---|
| 1 | A quote issued while `paused_budget` was rejected (409) on the paid retry, and the buyer then locked itself | Quote binding required `quote.status === agent.status`, while the **unpaid** challenge request un-paused the worker | Status removed from the equality check (both runnable states accepted; the budget gate decides). Unpaid requests never mutate state. `paused_budget→active` happens only after verified payment, via an atomic compare-and-set. (`server/src/routes/run.ts`, `server/src/db/queries.ts`) | E2E "paused_budget worker stays paused…", `lifecycle.test.ts` |
| 2 | Anonymous unpaid requests wrote `refused_budget` rows and flipped worker status | Side effects ran before any payment | Writes only on payment attempts (`run.ts`) | E2E happy path asserts zero writes for the refused worker |
| 3 | 0G cost parsing was not tied to the documented contract; missing billing had no reconciliation path | — | Adapter per the official Router docs: `total_cost_usd_micro`, else `currency:"usd"` `total_cost` with an `input+output` check. Wei is never converted and zero is never substituted. `BillingUnavailableError` keeps `request_id`. The job becomes `needs_reconciliation`, output is withheld, the buyer is not charged and the reservation is retained. (`server/src/zg/router.ts`, `run.ts`) | `router.test.ts` (9), E2E "missing 0G billing" |
| 4 | An unknown settlement outcome was recorded as a plain `settle_failed` | No classification | Definite (structured refusal without a tx) → `settle_failed`. Anything else → `needs_reconciliation` (new enum value, migration 0006). Never retried. (`server/src/x402/server.ts`, `cron/settlements.ts`) | E2E uncertain/definite; `lifecycle.test.ts` |
| 5 | A crashed request leaked a 365-day budget reservation | Every reservation had the 365-day expiry | 15-minute TTL for normal reservations; 365 days only for uncertain-billing retention (`0006`) | `migrations.test.ts` |
| 6 | Starting the server ran crons (Sepolia writes with the operator key) | Unconditional scheduling | `CRONS_ENABLED` (default `false`); `PAYOUTS_ENABLED` requires it (`cron/schedule.ts`, `config.ts`, `index.ts`) | `schedule.test.ts`, `config.test.ts`, live log |
| 7 | A buyer HCS mirror outage discarded the payment and job verification results | `verifyHcsJob` let network errors propagate | Caught; HCS is reported `unverified` (`buyer/src/settlement.ts`) | Found and verified by the E2E harness |
| 8 | `/buyer-console/budget` was public | — | Requires an allow-listed Privy user | E2E 401/403/200 |
| 9 | `/health` amplification; CORS allowed localhost in production; no API rate limits | — | Health cached 15 s; CORS conditional on `NODE_ENV`; per-group limits; `TRUST_PROXY_HOPS`; configurable upload limits (`app.ts`, `rate-limit.ts`, `health.ts`) | `lifecycle.test.ts` |
| 10 | Web console label said GET; budget fetched without auth | — | POST label, authenticated budget, explicit acknowledgement checkbox before paid runs (`web/app/console/page.tsx`) | Typecheck, build |
| 11 | Buyer rationale said "0.04 atomic USDC" for a formatted amount | Wording | Fixed (`buyer/src/agent.ts`) | Live simulated buyer output |

## 3. Features: implementation and evidence

Column key:

- **Auto:** automated tests.
- **Integ.:** integration on the simulated stack or harness.
- **Live:** verified against real external services.

| Feature | Implemented | Auto | Integ. | Live | Remaining blocker | Evidence / files |
|---|---|---|---|---|---|---|
| Registrar contract, registration, permissions | yes | not run | n/a | read-only ✔ (state, ABI decode) | Foundry + submodules | `contracts/src/NightshiftRegistrar.sol`; FINAL_TEST_RESULTS §4 |
| Renewal / expiry | partial (no automation) | not run | expiry enforced ✔ | expiry read ✔ (2026-12-05) | renewal before 2026-12-05 | `worker-lifecycle.ts`, E2E expired-worker test |
| ENS identity verification (buyer) | yes | ✔ | ✔ live Sepolia | ✔ read-only | — | `buyer/src/discovery.ts`; `simulate:buyer` run |
| Directory / search / pagination | yes | ✔ | ✔ | historical | live indexer needs `CRONS_ENABLED` on staging | `routes/directory*.ts`; contract tests |
| Agent profile + live ENS records | yes | ✔ | ✔ (live ENS through the server) | ✔ read | — | `routes/public.ts` |
| Signed quotes (Ed25519, 120 s) | yes | ✔ | ✔ | no | P2-1 | `quote-signing.ts` |
| Quote replay / duplicate protection | yes | ✔ | ✔ (sequential + concurrent) | no | P2-3 | `quote-redemptions.ts`, `x402/server.ts` |
| Paused/active lifecycle | yes (fixed) | ✔ | ✔ | no | — | `run.ts`, `queries.ts` |
| Budget reservation (atomic RPC) | yes | ✔ | ✔ (fake) + ✔ Postgres | no | P1-1 | `0005`, `0006`, `zg/budget.ts` |
| x402 payment verification + settlement | yes | ✔ | ✔ (local facilitator, real middleware) | historical (old code) | P2-1 | `x402/server.ts` |
| 0G execution + billing | yes | ✔ | ✔ (simulated 0G) | historical; billing fields per docs only | P2-2 | `zg/router.ts` |
| Job persistence + SHA-256 digest | yes | ✔ | ✔ | no (live HCS lacks digest) | P2-1 | `run.ts` |
| Job status capability | yes | ✔ | ✔ | no | P2-1 | `routes/jobs.ts` |
| Settlement recovery / reconciliation state | yes | ✔ | ✔ | no | — | `cron/settlements.ts`, `0006` |
| HCS evidence | yes (toggle) | ✔ | ✔ (simulated topic) | legacy format only | P2-1 | `x402/server.ts` |
| Reputation cron | yes | ✔ | off by design | ✔ (historical tx) | — | `cron/reputation.ts` |
| Daily payouts | yes (disabled) | ✔ mocked + ✔ Postgres claim | no | no | P2-4 | `cron/payouts.ts`, `0005` |
| Privy auth (server) | yes | ✔ real ES256 verification | ✔ | not with a real Privy app | P1-2 | `buyer-console-auth.ts` |
| Owner dashboard + `/me/jobs` | yes | ✔ | ✔ contract | no | Privy dev app | `routes/me.ts`, `web/app/dashboard` |
| Buyer console (paid) | yes (disabled) | ✔ | gating ✔ | historical | approval | `routes/buyerConsole.ts`, `web/app/console` |
| Launch / owner mutations | **no** (UI blocked honestly) | — | — | — | P4-1 | `web/app/launch` |
| DB schema, RLS, grants | yes | ✔ Postgres | — | hosted unknown | P0-2 | `migrations.test.ts` |
| Cron safety | yes | ✔ | ✔ | — | — | `cron/schedule.ts` |
| Rate limits | yes (process-local) | ✔ | ✔ | — | P4-2 | `rate-limit.ts` |
| Web pages (6) | yes | ✔ unit + contract | ✔ 200 against the backend | — | P1-5 browser tests | `web/` |

## 4. Security status

| Finding | Status |
|---|---|
| Quote replay | Mitigated and tested (unique nonce after verification) |
| Unauthorized paid execution | Payment is verified before execution; eligibility is checked on the paid path |
| Owner isolation | `/me*` identity comes from the verified token only; ownership is enforced in the query and re-checked; private fields are never returned |
| Payment amount, network or payee tampering | The quote is bound to the requirements on both server and buyer; tested |
| Double payment / duplicate payouts | Buyer never retries uncertain outcomes; payout claim is idempotent (Postgres-tested) |
| Live anon data exposure | **Open (P0-2).** Present on any database without 0005, proven on Postgres. |
| Secret handling | No secrets in `web/`; simulated stack forces dummy keys; config errors list variable names only (tested) |
| Key concentration (buyer key in server for console); per-process limits | Open (P4) |

## 5. Final GO / NO-GO

| Area | Decision | Basis |
|---|---|---|
| Backend implementation | **GO WITH RESTRICTIONS** | Public, paid and owner-read APIs complete and tested; owner mutation APIs absent |
| Frontend/backend integration | **GO WITH RESTRICTIONS** | Contracts tested, pages served against the running backend; no browser-level DOM tests yet |
| Authentication | **GO WITH RESTRICTIONS** | Real ES256 verification tested (signature, expiry, issuer, audience); not exercised with a real Privy app |
| Database integration | **GO WITH RESTRICTIONS** | 0001–0006 validated on Postgres; hosted DB not migrated; live exposure open |
| Buyer/payment integration | **GO WITH RESTRICTIONS** | Full simulated flow with real x402 middleware and buyer policy; no live payment on current code |
| 0G integration | **NO-GO (live)** / GO in simulation | Adapter follows the documented contract; no live response inspected |
| Hedera/HCS integration | **NO-GO (live)** | Historical evidence only; current digest-bearing HCS never run live |
| Contract validation | **GO WITH RESTRICTIONS** | Deployed state and ABI verified read-only; Foundry tests not run |
| Teammate UI testing | **GO** (after push) | No secrets needed |
| Teammate integration testing | **GO WITH RESTRICTIONS** | On the simulated stack today, after the code is pushed; real staging not ready |
| Real-payment testing | **NO-GO** | Needs P0-2 or P1, plus explicit approval |
| Production deployment | **NO-GO** | Uncommitted code, unmigrated DB, no live verification |
| ETHGlobal demo readiness | **GO WITH RESTRICTIONS** | Simulated localhost demo works now (must be labelled simulated). A live demo needs P2-1 + P3-1..P3-3 |
