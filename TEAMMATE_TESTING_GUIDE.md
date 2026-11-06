# NightShift — Teammate Testing Guide

**Status as of 2026-11-06:**

| Level | What it covers | Status |
|---|---|---|
| A | UI and basic functional QA (frontend only) | **READY WITH RESTRICTIONS**: start today |
| B | Integration QA (frontend + backend + DB + auth + testnets) | **READY on the simulated local stack** (no secrets); see `TEAMMATE_INTEGRATION_TESTING_GUIDE.md`. **Not ready** against a real staging DB or real 0G/Hedera (§4) |
| C | Full end-to-end QA (paid buyer → worker → settlement → payout) | **NOT READY**: prerequisites in §5 |

Read §7 (prohibited actions) before you start.

---

## 1. Before you start: get the right code

The latest work is **not on GitHub yet**: the remote `main` is missing migrations 0004/0005, signed quotes, buyer verification and all new web pages. Wait until the project owner confirms the work has been pushed. Then:

```bash
git clone --recurse-submodules https://github.com/krisha-9/NightShift.git
cd NightShift
git checkout <branch name the owner gives you>
git submodule update --init --recursive
```

If `git log -1` shows `8f2ea10 docs(design): approved web mockup…` and there is no `supabase/migrations/0005_operations_payouts.sql`, you have the **old** code. Stop and ask.

## 2. Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | ≥ 20 (tested on 24.11.1) | |
| pnpm | 10.34.7 | `corepack enable && corepack prepare pnpm@10.34.7 --activate`, or prefix every command with `corepack pnpm` |
| Git | any | Needed for submodules |
| Browser | Chrome or Firefox, current | Use DevTools device mode for mobile widths |
| Foundry | latest | Only for contract tests (Level B). On Windows, use WSL or Git Bash |
| Docker Desktop | latest | Only for the local Supabase database (Level B) |

```bash
pnpm install
```

---

## 3. Level A: UI and basic functional QA (READY WITH RESTRICTIONS)

**Restrictions:**

- You test the frontend only. Without a backend, every data view shows its "server unavailable" or error state; that is expected.
- Sign-in stays disabled unless the owner gives you a public Privy app ID.
- You need **no secrets**. Do not ask for any for Level A.

### 3.1 Setup

Optionally create `web/.env.local` with **public** values only:

```
NEXT_PUBLIC_SERVER_URL=http://localhost:8787
NEXT_PUBLIC_PRIVY_APP_ID=            # leave blank unless the owner gives you the public app id
NEXT_PUBLIC_SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
NEXT_PUBLIC_ENS_PARENT_NAME=nightshift.eth
NEXT_PUBLIC_NIGHTSHIFT_REGISTRAR_ADDRESS=0x9564fFd96FBaA1bF10836966990aCc88a9865705
NEXT_PUBLIC_HEDERA_HCS_TOPIC_ID=0.0.11129931
```

### 3.2 Automated checks you can run

```bash
pnpm -C web test        # expect: 7 files, 25 tests passed
pnpm -C buyer test      # expect: 12 files, 48 tests passed
pnpm -C server test     # expect: 28 files, 140 tests passed (mocked, simulated E2E, embedded Postgres; no external network)
pnpm typecheck          # expect: no errors
pnpm lint               # expect: no errors
pnpm -C web build       # expect: build succeeds, 7 routes
pnpm -C scripts demo    # expect: every line starts with [SIMULATED]; no network
```

`pnpm format:check` currently **fails** (59 files). This is a known issue; do not report it.

### 3.3 Start the web app

```bash
pnpm -C web dev         # http://localhost:3000 (must be port 3000 for Privy)
```

### 3.4 Test scenarios (Level A)

For each page, check three widths: **1280 px**, **768 px** and **390 px**.

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| A1 | Landing page loads | Open `/` | Page renders and nav links work. The stats area shows an error panel with a **Retry** button (no backend). No blank page, no crash, no console errors other than the failed fetch. |
| A2 | Navigation | Click every nav and footer link | Each reaches the right route; browser back/forward works |
| A3 | Directory, no backend | Open `/directory` | Filter controls render; the results area shows an error panel with **Retry**; Retry shows a loading state, then the error again |
| A4 | Directory filters | Change skill, price and sort controls | Controls accept input and do not crash; the URL/query state is sensible |
| A5 | Agent profile | Open `/agents/tamil-scribe` and `/agents/does-not-exist` | Page shell renders; profile, quote and jobs sections each show their own error state; no raw stack traces |
| A6 | Console without auth | Open `/console` | Explains that sign-in is required or unavailable; **no "Run" action is possible without sign-in** |
| A7 | Dashboard without auth | Open `/dashboard` | Shows "Privy is not configured…" or a sign-in prompt; **no owner data or invented statistics** |
| A8 | Launch wizard | Open `/launch`, step through all 4 steps | Validation messages on invalid labels and caps; the final step clearly says launch is **unavailable**; nothing is submitted |
| A9 | 404 | Open `/nope` | Not-found page |
| A10 | Responsive | All pages at 390 px | No horizontal scroll; text readable; buttons tappable |
| A11 | Accessibility basics | Tab through each page | Visible focus; buttons reachable by keyboard; images and icons have labels |
| A12 | Console label | `/console` | The tape header shows `POST /buyer-console/run` (fixed) |

---

## 4. Level B: Integration QA

**Start with the simulated stack now:** follow `TEAMMATE_INTEGRATION_TESTING_GUIDE.md`. The rest of this section is about a **real staging** environment, which is not ready.

**Do not start real-staging testing until the owner confirms all of the following:**

1. The code is pushed (see §1).
2. A **separate staging** database (local `supabase start` or a new Supabase project) has migrations 0001–0005 applied.
3. Your staging `.env` has `CRONS_ENABLED=false` (implemented; it is the default) and `HCS_SUBMIT_ENABLED=false`.
4. You have received **QA-only** credentials over a private channel.

### Required environment variables (names only; values come privately)

Server (`.env` at the repo root):

- `NODE_ENV`, `PORT`, `PUBLIC_SERVER_URL`, `PUBLIC_WEB_URL`, `WEB_ORIGIN`
- `SECRETS_MASTER_KEY` (QA key, not production)
- `NIGHTSHIFT_QUOTE_SIGNING_PRIVATE_KEY`, `NIGHTSHIFT_QUOTE_VERIFY_PUBLIC_KEY` (QA pair)
- `ZG_ROUTER_URL`, `ZG_TEAM_SK_KEY`, `ZG_WHISPER_MODEL`, `ZG_CHAT_MODEL` (`ZG_TEAM_MK_KEY` optional)
- `HEDERA_OPERATOR_ID`, `HEDERA_OPERATOR_KEY`, `HEDERA_USDC_TOKEN_ID`, `HEDERA_HCS_TOPIC_ID`, `HEDERA_MIRROR_URL`, `TREASURY_ACCOUNT_ID`, `X402_FACILITATOR_URL`
- `SEPOLIA_RPC_URL`, `ENS_OPERATOR_PRIVATE_KEY` (`SEPOLIA_LOGS_RPC_URL` optional)
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (**staging project only**)
- `PAYOUTS_ENABLED=false`, `BUYER_CONSOLE_ENABLED=false`
- `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `BUYER_CONSOLE_ALLOWED_PRIVY_USER_IDS` (only for auth tests)
- `CRONS_ENABLED=false`, `HCS_SUBMIT_ENABLED=false`

Buyer preflight: `BUYER_SERVER_URL`, `SEPOLIA_RPC_URL`, `HEDERA_MIRROR_URL`, `NIGHTSHIFT_QUOTE_VERIFY_PUBLIC_KEY`.

Web: the `NEXT_PUBLIC_*` values from §3.1.

### Test accounts / prerequisites

- A Privy user ID (`did:privy:…`) added to the staging allow-list, plus one user **not** on it.
- The staging DB seeded with at least one owner and agent (by the owner, using `scripts/seed-agents.ts --dry-run` first).
- Foundry plus restored submodules for contract tests.

### Level B scenarios (once unblocked)

| # | Scenario | Command / steps | Expected |
|---|---|---|---|
| B1 | Server boots | `pnpm -C server dev` | Logs `listening on :8787`; no cron logs when `CRONS_ENABLED=false` |
| B2 | Liveness/readiness | `curl localhost:8787/live` and `/ready` | `{"ok":true}`; `/ready` lists 4 checks; details are generic (no secrets) |
| B3 | Directory | `curl "localhost:8787/directory?skill=transcribe:ta"` | JSON `{agents,total,page,limit}` |
| B4 | Signed quote | `curl "localhost:8787/a/<label>/quote?units=2"` | `signedQuote`, `nonce`, `expiresAt` about 120 s after `issuedAt`; `Cache-Control: no-store` |
| B5 | Unpaid run is refused before payment | `curl -X POST localhost:8787/a/<label>/run` with no headers; then with `-H "X-Nightshift-Units: 2"` only | First: 422 `invalid_input` (units header required). Second: 422 "signed quote is required". **No 402, nothing charged** |
| B6 | Job status requires capability | `curl localhost:8787/jobs/<uuid>/status` | 401 |
| B7 | Buyer preflight | `pnpm -C buyer start -- --preflight` | PASS lines; never says a payment was made |
| B8 | Privy auth | Sign in on web with the allow-listed user → `/dashboard`; then with the non-listed user → `/console` | Allow-listed: dashboard shows only that owner's agents. Non-listed: 403 on console. No token: 401 |
| B9 | Buyer console disabled | `curl -X POST localhost:8787/buyer-console/run` | 503 `feature_disabled` |
| B10 | Web against API | `pnpm -C web dev` with the server running | Directory, profile and landing show real staging data |
| B11 | RLS | With the staging **anon** key, try to `select` from `jobs`, `payouts`, `buyer_events`, `agents`, `quote_redemptions` | All denied |
| B12 | Contract tests | `pnpm -C contracts test:unit` (WSL/Git Bash) | All pass |

---

## 5. Level C: Full end-to-end QA (NOT READY)

Prerequisites (REMAINING_WORK P0-2, P0-3, P2-1): the 0G billing field is confirmed, the quote/status bug is fixed, the target DB is migrated, and the project owner gives **explicit written approval for each paid run**.

When approved, the owner (not the teammate) runs one paid job and shares evidence. The teammate then verifies:

| # | Check | Expected |
|---|---|---|
| C1 | HashScan tx | 0.06 USDC from the buyer account to the agent's pay-to |
| C2 | Job status (with capability) | `settled`, `output_sha256` present, `hedera_tx_id` matches |
| C3 | HCS topic `0.0.11129931` | New message containing the same `output_sha256` |
| C4 | Buyer output | `settlementVerified: true`; no `.buyer-run.lock` left behind |
| C5 | Refusal fallback | `kural` refused with 503 and **no charge**; buyer moves to the next agent |
| C6 | Replay | Re-sending the same signed quote is rejected; no second settlement |

---

## 6. Bug report template

```
Title: [Area] Short description
Level: A / B / C
Commit: <git rev-parse --short HEAD>
Environment: OS, browser + version, viewport width, Node version
Route / command: e.g. /directory  or  pnpm -C buyer start -- --preflight
Steps to reproduce:
  1.
  2.
Expected:
Actual:
Severity: Blocker / Major / Minor / Cosmetic
Evidence: screenshot, console log, HTTP status, response body
          (REDACT any keys, tokens, account private data)
Money involved?: No / Yes (if yes, include tx id; never re-run)
```

---

## 7. Prohibited actions (all levels)

Do **not**:

1. Run `scripts/pay-run.ts`, `pnpm -C buyer start` (without `--preflight`), or `POST /buyer-console/run` with the console enabled. These spend real testnet USDC and 0G credits.
2. Set `PAYOUTS_ENABLED=true` or `BUYER_CONSOLE_ENABLED=true`.
3. Run `pnpm db:push`, `supabase db push`, `supabase link` or any migration against the shared or production Supabase project (`bklxturxluiennzmrfxw`).
4. Start the server with production credentials, or against the shared DB, while crons are enabled. It sends Sepolia transactions with the operator key and mutates shared rows.
5. Run any `contracts` `deploy:*` or `smoke:*` script, or `forge script … --broadcast`.
6. Run `scripts/create-agent-cli.ts` or `seed-agents.ts` without `--dry-run`. ENS labels cannot be reused.
7. Call `release_agent_budget`, edit `payouts`, or delete `.buyer-run.lock` to "unblock" something. Report it instead.
8. Retry any request whose payment outcome is unknown.
9. Paste keys, tokens, `.env` contents or service-role keys into issues, chat or screenshots.
10. Put any non-`NEXT_PUBLIC_` value into `web/.env.local`.

---

## 8. Practical checklist

- [ ] Code pulled from the branch the owner named; `supabase/migrations/0005_operations_payouts.sql` exists
- [ ] `pnpm install` succeeded
- [ ] Automated checks in §3.2 run and results recorded
- [ ] A1–A12 executed at 1280 / 768 / 390 px
- [ ] Bugs filed with the §6 template
- [ ] Level B started only after the owner confirmed §4 items 1–4
- [ ] No prohibited action from §7 performed
