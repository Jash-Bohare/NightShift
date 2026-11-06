# NightShift: Remaining Work

Updated 2026-11-06 after the integration pass. Items completed in this pass are listed at the end with their evidence.

## P0: critical blockers

| Priority | Remaining task | Why required | Exact files/modules | Dependencies | Verification criteria |
|---|---|---|---|---|---|
| P0-1 | **Commit the working tree to a branch and push** | All integration work, migrations 0004–0006 and new web routes exist only on this machine. A teammate cannot get them. | whole repo (≈130 changed or new files) | Owner approval to commit/push | A fresh `git clone` + `pnpm install && pnpm test:all` gives 48 / 140 / 25 passing |
| P0-2 | Apply 0005 + 0006 to the **live** database (or remove anon policies) | Until 0005, anon can read `jobs`, `payouts`, `agents` and `buyer_events` (transcripts). Proven on Postgres by `migrations.test.ts` "pre-0005 exposure". | `supabase/migrations/0004–0006` | Backup, `db push --dry-run` review, explicit owner authorization | `migration list` shows 0006; the anon `curl` loop in `STAGING_SETUP.md` §4.1 returns nothing |

## P1: real staging integration

| Priority | Remaining task | Why required | Exact files/modules | Dependencies | Verification criteria |
|---|---|---|---|---|---|
| P1-1 | Create a dedicated staging Supabase project (or `supabase start`) and apply 0001–0006 | Integration testing beyond the simulated stack | `supabase/` | Docker or a new project | `migration list`; RLS `curl` loop returns nothing |
| P1-2 | Issue QA-only credentials (quote key pair, QA 0G key with low credit, QA Hedera account, Privy dev app) | Staging must not reuse production keys | out-of-band secret channel | P1-1 | Staging `/ready` 200; buyer preflight PASS |
| P1-3 | Run contract tests | Never executed in this environment | `contracts/` | Foundry; restore `forge-std` and the nested submodules (owner decision: local `+` divergence exists) | `pnpm -C contracts test:unit` passes; fork tests pass with an RPC |
| P1-4 | Repo-wide Prettier | 56 pre-existing files fail `format:check` | repo | P0-1 (separate commit) | `pnpm format:check` exits 0 |
| P1-5 | Browser-level UI tests | Pages are verified for HTTP 200 and API contracts, not rendered DOM | `web/` (add Playwright) | — | Scripted checks of F1–F10 in the integration guide at 3 widths |

## P2: real paid end-to-end (approval-gated)

| Priority | Remaining task | Why required | Exact files/modules | Dependencies | Verification criteria |
|---|---|---|---|---|---|
| P2-1 | One authorized paid run on staging/testnet | No live evidence for the current code (HCS digest, nonce claim, status capability) | `scripts/pay-run.ts` or `pnpm -C buyer start` | P0-1, P0-2 or P1-1, P1-2, **explicit approval** (~0.06 test USDC + ~$0.0125 0G) | HashScan tx; job `settled` with `output_sha256`; `quote_redemptions.state=settled`; HCS message containing the digest; buyer `settlementVerified:true` |
| P2-2 | Confirm 0G billing fields on a live response | The adapter follows the official docs (`total_cost_usd_micro`, or `currency:"usd"` + `total_cost`), but no live response has been inspected | `server/src/zg/router.ts` | P2-1 | Logged `cost_usd_micro` equals the 0G usage-history entry for that `request_id` |
| P2-3 | Live replay probe | Replay is proven in simulation only | — | P2-1 | Re-sending the same signed quote with a new payment gets aborted, with no second settlement |
| P2-4 | Payout run on staging | The sender has never run against Hedera | `server/src/cron/payouts.ts` | P1-1; staging only; approval for a 0.01 USDC transfer | One `confirmed` payout; second run creates none |

## P3: deployment and ETHGlobal demo

| Priority | Remaining task | Why required | Exact files/modules | Dependencies | Verification criteria |
|---|---|---|---|---|---|
| P3-1 | Decide demo topology | Agents' on-chain endpoints are `http://localhost:8787`; the buyer pins this origin | ENS records (owner wallet `0x0ABE…30ed8` signs) or a localhost demo | Owner wallet | `agent-endpoint[x402]` matches the demo server |
| P3-2 | Renew agent names before 2026-12-05 | All agents expire then | `NightshiftRegistrar.renew` | Operator key, approval | `getExpiry` later than the judging date |
| P3-3 | Rehearse the live demo twice | Simulated success ≠ live success | `buyer/`, `web/app/console` | P2-1 | Two clean live runs; no leftover buyer lock |
| P3-4 | Deploy server and web (if hosted) | Nothing hosted exists | `server/`, `web/` | P3-1, P0-2 | `/ready` 200 on the public URL |
| P3-5 | Verify PROOFS.md links | 2 of 3 sampled tx hashes not found via public RPC | `PROOFS.md` | — | All links resolve |

## P4: can wait

| Priority | Remaining task | Why required | Exact files/modules | Dependencies | Verification criteria |
|---|---|---|---|---|---|
| P4-1 | Owner launch, pause/resume, pricing and payout-account APIs | Launch wizard is deliberately blocked | new `server/src/routes/owner*.ts`, `web/app/launch` | Secure key-handling design | Owner-scoped mutation tests |
| P4-2 | Shared (multi-instance) rate limiting | Limits are per process | `server/src/rate-limit.ts`, `upload-limits.ts` | Redis or DB | Load test across 2 instances |
| P4-3 | Separate the paid buyer console process from the server | Key concentration | `routes/buyerConsole.ts` | — | Server env has no buyer key |
| P4-4 | Classify payout `ReceiptStatusError` as `failed`; validate payout destination association | Operator burden | `cron/payouts.ts`, `create-agent-cli.ts` | — | Unit tests |
| P4-5 | Anchor the quote verification key in ENS | Trust assumption | parent ENS text record, `buyer/src/config.ts` | Admin key | Buyer reads the key from ENS |

## Completed in this pass (with evidence)

| Was | Fix | Evidence |
|---|---|---|
| Paused/active quote bug: a quote issued while `paused_budget` failed on the paid retry | Lifecycle status removed from quote equality; unpaid requests never mutate state; `paused_budget→active` only after verified payment, via atomic compare-and-set (`transitionAgentStatus`) | E2E "paused_budget worker stays paused…"; `lifecycle.test.ts` |
| Anonymous pre-payment side effects (job rows, status flips) | Writes only on payment attempts | E2E happy path asserts no `refused_budget` rows and kural unchanged |
| 0G billing unverified | Adapter per the official Router docs; `BillingUnavailableError` keeps the request id; job set to `needs_reconciliation`; output withheld; buyer not charged; reservation retained | `router.test.ts` (9); E2E "missing 0G billing" |
| Uncertain settlement recorded as a plain failure | Definite vs uncertain classification; `needs_reconciliation` status (migration 0006) | E2E uncertain/definite; `lifecycle.test.ts` |
| Crash-leaked 365-day reservations | 15-minute TTL for normal reservations (0006) | `migrations.test.ts` |
| Crons ran on any server start | `CRONS_ENABLED` (default false); payouts require it | `schedule.test.ts`, `config.test.ts`, live log |
| No local mode | `pnpm dev:simulated` + `pnpm simulate:buyer` with forced safe env and production refusal | live run in `FINAL_TEST_RESULTS.md` |
| Migrations never run on Postgres | PGlite suite | `migrations.test.ts` (10) |
| `/buyer-console/budget` unauthenticated; no owner job history; `/health` amplification; CORS localhost in prod; no API rate limits | Fixed; `/me/jobs` added; health cached 15 s; CORS conditional; per-group limits | E2E + contract tests |
| Buyer discarded payment and job verification when the HCS mirror was unreachable | `verifyHcsJob` catches network errors | E2E (found by the harness) |
| Web: console budget public, stale GET label, no owner job history | Auth-scoped budget, explicit acknowledgement before paid run, POST label, `/me/jobs` table | `web/lib/owner.test.ts`, contract test |
