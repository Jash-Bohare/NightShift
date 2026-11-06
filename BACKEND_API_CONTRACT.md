# NightShift Backend API Contract

**Source of truth:** `server/src/app.ts` (route order) and `server/src/routes/*.ts`. Verified by the automated suite (`server/src/e2e/simulated-flow.test.ts` "frontend ↔ backend API contracts", and the route tests in `server/src/routes/*.test.ts`) and by live HTTP probes.

## Conventions

- **Base URL:** `PUBLIC_SERVER_URL`, default `http://localhost:8787`.
- **Money:** always integer strings. USDC is in atomic units (6 decimals, so `60000` = 0.06 USDC). 0G costs are in micro-USD. No floats.
- **Errors:** the body is `{"error": <code>, "message": <text>, "details"?: …}`. Codes: `unauthorized` (401), `forbidden` (403), `not_found` (404), `agent_paused` (409), `invalid_input` / `invalid_label` / `units_mismatch` (422), `rate_limited` (429, with `Retry-After`), `internal` (500), `zg_unavailable` (502), `over_budget` / `no_credits` / `feature_disabled` (503).
- **Rate limits:** fixed one-minute windows per client IP. They are process-local, so they do not cover multiple instances. Client IPs are only trusted behind `TRUST_PROXY_HOPS`.

| Group | Paths | Limit / min / client |
|---|---|---|
| worker | `/a/:label/quote`, `/a/:label/run` | `WORKER_REQUESTS_PER_MINUTE` (60) |
| run uploads | `/a/:label/run` multipart | `UPLOAD_MAX_PER_MINUTE` (8); concurrency `UPLOAD_MAX_CONCURRENT_PER_CLIENT` (2) / `UPLOAD_MAX_CONCURRENT_TOTAL` (8) |
| health | `/health`, `/ready` | 30 (results also cached 15 s) |
| public | `/directory*`, `/agents*`, `/jobs*`, `/stats` | 240 |
| private | `/me*`, `/buyer-console*` | 120; paid console run: 1 at a time, 1 per 20 s |

- **Authentication types:**
  - *Privy*: `Authorization: Bearer <Privy access token>`. The server verifies the ES256 signature, issuer `privy.io`, audience `PRIVY_APP_ID` and expiry. It uses the Privy JWKS, or the pinned `PRIVY_JWT_VERIFICATION_KEY` if set. The user identity comes **only** from the verified token `sub`; request bodies and wallet addresses are never trusted.
  - *Job capability*: an Ed25519 token the server issues per job (30-minute TTL).
  - *x402*: `PAYMENT-SIGNATURE` payment header, verified by the facilitator.
- **Private responses** set `Cache-Control: no-store`. These are `/me*`, `/buyer-console/*`, `/jobs/:id/status` and `/a/:label/quote`.

---

## Public

| Method | Path | Request | 200 response | Errors |
|---|---|---|---|---|
| GET | `/live` | — | `{"ok":true}` | — |
| GET | `/ready`, `/health` | — | `{ok, zg, hedera, sepolia, supabase}`; each check is `{ok, ms, detail?}` with details redacted to `"unavailable"` | 503 when any check fails |
| GET | `/directory` | `skill`, `maxPrice` (atomic), `minSuccess` (0–1), `search`, `status` (`available` default · `all` · a status), `sort` (`price`·`reputation`·`recent`), `page` ≥1, `limit` ≤100 | `{agents: DirectoryAgent[], total, page, limit}` | 422 |
| GET | `/directory/:name` | `name` = `label` or `label.nightshift.eth` | `DirectoryAgent` | 404, 422 |
| GET | `/agents/:label` | — | `{label, ensName, skill, model, price:{amount, asset, unit}, payTo, status, resolver, registerTx, expiry, today:{jobsSettled, earnedAtomic}, ens, ensError?}` (`ens` is read live from Sepolia) | 404, 422 |
| GET | `/agents/:label/jobs` | `limit` 1–1000 (100) | `PublicJob[]`: `{id, status, price_atomic, zg_cost_usd_micro, hedera_tx_id, zg_request_id, hcs_sequence, latency_ms, created_at, agents:{label, ens_name}}`. **Never** includes outputs, buyer accounts or error text | 404, 422 |
| GET | `/agents/:label/payouts` | `page` (1), `limit` ≤100 (20) | `{items:[{id, payoutDate, grossAtomic, ownerAtomic, feeAtomic, status, transactionId, createdAt}], nextPage?}`. The destination account is omitted | 404, 422 |
| GET | `/jobs/latest` | — | `PublicJob` or `null` | — |
| GET | `/jobs/activity` | `limit` ≤1000 | `{jobs:[{status, created_at, agents:{label}}]}` (today, UTC) | 422 |
| GET | `/stats` | — | `{agents, workers:{active, paused, unavailable}, jobsToday, failedJobsToday, settlementFailuresToday, reconciliationRequiredToday, payouts:{pending, failed, uncertain}, usdcToday, creditsUsedToday \| null}`. `creditsUsedToday` is `null` when any billing record is incomplete | — |
| GET | `/skills` | — | `{skills:[{id, model, unit, costUsdMicroPerUnit, suggestedPriceAtomic}]}`: 0G cost of one billed unit (Whisper: 60 s × `pricing_usd.prompt` from `/v1/models`, cached 1 h) and 4× that as the suggested price | 5xx if 0G pricing is unavailable |
| GET | `/a/:label/quote` | `units` (1–10000, rounded up) | `{amount, asset, network, payTo, unit, units, status, issuedAt, expiresAt (120 s), nonce, signedQuote}` | 404, 409 (no pay-to / not runnable), 422 |

`DirectoryAgent` is `{label, ensName, owner, resolver, skill, price:{amount, asset, unit}, payTo, endpoint, model, description, reputation, status, expiry, updatedAt}`.

## Paid execution (x402)

**`POST /a/:label/run`**

- **Headers:** `X-Nightshift-Units`, `X-Nightshift-Quote` (signed quote).
- **Body:** multipart, field `file` (audio, ≤ 25 MB).
- **Pre-payment checks** (no charge):
  - The worker exists, is runnable (`active` or `paused_budget`), and is registered and unexpired **on Sepolia**.
  - The quote signature, expiry and binding all match: worker id, label, ENS name, units, amount, asset, network, pay-to and unit. The quote `status` may be either runnable status.
  - The measured audio duration is no more than the declared units.
  - The 0G budget fits.
- **Unpaid challenge:** returns `402` with `PAYMENT-REQUIRED`. It **never mutates state**: no job row, no status change, no reservation.
- **Paid attempt:** the server reserves budget atomically, then the facilitator verifies the payment. The quote nonce is then claimed **once**; a replay or concurrent duplicate is aborted. Next the job row is created and a `paused_budget` worker moves to `active` (compare-and-set). Finally 0G executes, the output digest is computed, and the payment settles.
- **200:** `{job_id, output, output_sha256, status_token, zg:{request_id, provider}}`, plus the `PAYMENT-RESPONSE` and `X-Nightshift-Job` headers.
- **Failures** (buyer **not charged**; settlement cancelled):

| Status | Meaning |
|---|---|
| 502 `zg_unavailable` | 0G failed, or 0G billing could not be established. The job is `needs_reconciliation`, the request id is kept, and the reservation is retained. |
| 500 | Internal error. |
| 409 | Quote or worker no longer matches. |
| 402 | Invalid or expired quote. |
| 503 | `over_budget` or `no_credits`. |

- **Settlement outcome:**
  - A definite facilitator refusal sets the job to `settle_failed`.
  - A timeout, network error or pending result sets it to **`needs_reconciliation`**. It is never retried automatically.

**`GET /jobs/:id/status`**

- **Auth:** `Authorization: Bearer <status_token>`.
- **200:** `{id, status, units, price_atomic, hedera_tx_id, hcs_sequence, output_sha256, created_at, agent:{label, ensName}, asset, network}`, with `no-store`.
- **Errors:** 401 (missing, invalid, or for another job), 404, 422.

Job statuses are `running`, `done`, `settled`, `failed_upstream`, `failed_internal`, `settle_failed`, `refused_budget` and `needs_reconciliation`.

## Authenticated (Privy)

| Method | Path | Auth | Request | 200 response | Errors |
|---|---|---|---|---|---|
| GET | `/me` | Privy | — | `{owner:{evmAddress, hederaPayoutAccount, createdAt} \| null, agents:[{id, label, ensName, skill, model, priceAtomic, priceUnit, dailyCapUsdMicro, status, expiry, createdAt, hederaAccountId, resolverAddress, registerTx, today:{spentUsdMicro, earnedAtomic, jobsSettled, jobsRefused}}]}`. `today` is the current UTC day; 0G spend counts every job's recorded cost, earnings only settled jobs | 401; 503 if Privy is not configured |
| PATCH | `/me` | Privy | `{hederaPayoutAccount: "0.0.x" \| null}` | `{hederaPayoutAccount}`. The account must exist on the Mirror Node, not be deleted, and hold a USDC association or unlimited auto-association | 401, 404 (no owner yet), 422 |
| POST | `/me/zg-balance` | Privy | `{zgMgmtKey: "mk-…"}` | `{creditBalanceUsdMicro, totalBalanceUsdMicro}` from 0G `GET /v1/account/balance`. The key is used once; never stored or logged | 401, 422 (`invalid_input`, `invalid_zg_key`) |
| POST | `/me/agents` | Privy + linked wallet | `{label, skill, priceAtomic, dailyCapUsdMicro, zgApiKey: "sk-…", zgMgmtKey?, hederaPayoutAccount?, description?, ownerAddress}`; price ≤ 10 USDC, cap ≤ $1,000 | **NDJSON** (`application/x-ndjson`): `{"type":"progress","step":"validate\|zg_key\|hedera_account\|ens_register\|drip","status":"running\|done\|sent\|skipped\|failed", txHash?, account?, reason?, message?}` lines, then one `{"type":"done","result":{agentId, ensName, registerTx, hederaAccount, resolver}}` or `{"type":"error", error, message}`. A disconnect does not abort the launch | Before the stream: 401; 503 `feature_disabled` unless `OWNER_LAUNCH_ENABLED=true`; 403 (`ownerAddress` is not a wallet linked to the Privy user); 409 `invalid_state` (`OWNER_MAX_AGENTS` reached); 422; 429 (another launch in progress) |
| PATCH | `/me/agents/:id` | Privy | `{status?: "active" \| "paused_owner", dailyCapUsdMicro?}` (cap 1…1,000,000,000 micro-USD) | `{id, label, status, dailyCapUsdMicro}`. Pause from `active`/`paused_budget`; resume only from `paused_owner`; compare-and-set | 401, 404 (not this owner's), 409 `invalid_state`, 422 |
| POST | `/me/agents/:id/records/draft` | Privy | `{priceAtomic?, description?}` | `{ensName, dnsName, resolver, signer, records:[{key, value}]}`: the exact values for the owner's wallet to sign (a price edit rewrites `nightshift.price` and `agent-context`) | 401, 404, 409, 422 |
| POST | `/me/agents/:id/records/sync` | Privy | — | `{priceAtomic, description, directorySynced}` after re-reading ENS; the price record must name USDC on `hedera:testnet` with the worker's unit, through the registered resolver | 401, 404, 409, 5xx (ENS read failed) |
| GET | `/me/payouts` | Privy | `page` ≤1000, `limit` ≤100 | `{items:[{id, label, payoutDate, grossAtomic, ownerAtomic, feeAtomic, status, transactionId, destinationAccount, createdAt}], page, limit, nextPage?}` | 401, 422 |
| GET | `/me/jobs` | Privy | `label?`, `page` ≤1000, `limit` ≤100 | `{items:[{id, label, status, units, priceAtomic, zgCostUsdMicro, hederaTxId, zgRequestId, hcsSequence, outputSha256, latencyMs, createdAt}], page, limit, nextPage?}`. Ownership is enforced in the query (`agents.owner_id`). Outputs, buyer accounts and error text are never returned. | 401, 422, 503 |
| GET | `/buyer-console/budget` | Privy, allow-listed | — | `{rules, state, wallet: {accountId, usdcAtomic \| null, error?} \| null}`; the balance is read from the Mirror Node and reported as unavailable rather than hidden | 401, 403, 503 |
| GET | `/buyer-console/events/:runId` | Privy, allow-listed | `runId` = `run-<digits>` | `{events:[{event_type, payload, created_at}]}` (allow-listed fields per event kind) | 401, 403, 422 |
| POST | `/buyer-console/run` | Privy, allow-listed | `skill` (e.g. `transcribe:ta`) | SSE stream of buyer events, then `complete`. **Spends test funds.** | 503 `feature_disabled` unless `BUYER_CONSOLE_ENABLED=true`; 401, 403, 422, 429 |

## Operational (no HTTP surface by design)

Settlement recovery, reputation, the indexer, name renewal (01:00 UTC) and payouts (00:15 UTC) run as scheduled jobs (`server/src/cron/*`). They only run when `CRONS_ENABLED=true`, and payouts additionally need `PAYOUTS_ENABLED=true`. Operators can run payouts (`pnpm -C server payday [--through-now] --yes`) and renewals (`pnpm -C server renew --yes`) by hand; without `--yes` both only print the plan. Their state is visible through the following:

- **`/stats`:** `settlementFailuresToday`, `reconciliationRequiredToday` and payout counts.
- **`/agents/:label/payouts`:** payout batch status per agent.
- **Logs:** prefixed `[cron]`, `[x402]`, `[db]`, `[0g]` and `[hedera]`.

There is no operator HTTP API. Reconciliation is done in the database by an operator (`STAGING_SETUP.md` §6).

## Not implemented

| Gap | Current behaviour |
|---|---|
| Shared (multi-instance) rate limiting | Limits are per process only. |

## Required configuration per surface

| Surface | Variables |
|---|---|
| Every server start | `PUBLIC_SERVER_URL`, `PUBLIC_WEB_URL`, `WEB_ORIGIN`, `SECRETS_MASTER_KEY`, `NIGHTSHIFT_QUOTE_SIGNING_PRIVATE_KEY`, `NIGHTSHIFT_QUOTE_VERIFY_PUBLIC_KEY`, `ZG_ROUTER_URL`, `ZG_TEAM_SK_KEY`, `ZG_WHISPER_MODEL`, `ZG_CHAT_MODEL`, `HEDERA_OPERATOR_ID`, `HEDERA_OPERATOR_KEY`, `HEDERA_USDC_TOKEN_ID`, `HEDERA_HCS_TOPIC_ID`, `HEDERA_MIRROR_URL`, `TREASURY_ACCOUNT_ID`, `X402_FACILITATOR_URL`, `SEPOLIA_RPC_URL`, `ENS_OPERATOR_PRIVATE_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| Privy routes | `PRIVY_APP_ID`, `PRIVY_APP_SECRET` (optionally `PRIVY_JWT_VERIFICATION_KEY`) |
| Owner launch | the Privy routes' variables plus `OWNER_LAUNCH_ENABLED=true`; optional `OWNER_MAX_AGENTS` (3), `SEPOLIA_DRIP_WEI` (0.003 ETH, 0 disables) |
| Paid console | the Privy routes' variables plus `BUYER_CONSOLE_ENABLED=true`, `BUYER_CONSOLE_ALLOWED_PRIVY_USER_IDS`, `BUYER_HEDERA_ACCOUNT_ID`, `BUYER_HEDERA_PRIVATE_KEY`, `BUYER_SERVER_URL` |
| Scheduled jobs | `CRONS_ENABLED=true` (and `PAYOUTS_ENABLED=true` for payouts) |
| Simulated local stack | none; `pnpm -C server dev:simulated` forces safe values (see `STAGING_SETUP.md`) |
