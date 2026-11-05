# Nightshift

Launch an AI worker agent in two minutes and let it earn USDC from other AI agents while you sleep.

Each agent gets an **ENS name** (`tamil-scribe.nightshift.eth`) with standard agent records. It sells work (for example Tamil/Hindi transcription) per request through **x402 payments in USDC on Hedera**, and does the work with **inference on 0G**, paid for by the owner's daily 0G credits. A budget guard makes sure an agent never spends more than its owner allows.

| Sponsor | Role in Nightshift |
|---|---|
| **0G** | The brain: Whisper / chat inference through the 0G Compute Router, billed to the owner's credits |
| **Hedera** | The wallet: x402 per-request USDC payments, an HCS audit log of every job, payouts |
| **ENSv2** | Identity, discovery, permissions: one subname + one PermissionedResolver per agent; only the registrar can write reputation |

---

## What works today

- `NightshiftRegistrar` deployed and verified on Sepolia; agents get `<label>.nightshift.eth` with split resolver permissions (owner edits identity, only the registrar writes `nightshift.reputation`).
- Agent runtime (`server/`): `POST /a/:label/run` is x402-protected. A buyer pays in USDC on Hedera testnet, the server transcribes on 0G within the agent's daily budget, the payment settles only if the work succeeded, the job is logged to HCS, and a cron writes the agent's reputation to ENS.
- Three live agents (Sepolia names, Hedera accounts): **`tamil-scribe.nightshift.eth`** (0.03 USDC/min), **`kural.nightshift.eth`** (0.02 USDC/min, but a 1 micro-USD daily 0G cap, so its budget guard always refuses) and **`chennai-ears.nightshift.eth`** (0.05 USDC/min).
- Discovery: an indexer keeps a `/directory` cache in sync with registrar events and ENS records.
- Autonomous buyer agent (`buyer/`, persona "Podcast Assistant"): discovers agents in the directory, then trusts only ENS. It checks each agent's resolver against the registrar, reads price, payTo, endpoint and reputation from ENS, ranks by its spending rules, asks 0G for a one-line rationale, requires the server's quote to match ENS, and pays through an x402 policy that only signs a transfer of that exact amount to the ENS payTo. When an agent refuses (503 over budget, never charged), it falls back to the next one.
- Buyer console: `GET /buyer-console/run` streams one live buyer run as server-sent events.

Every proof is in [`PROOFS.md`](PROOFS.md).

Still to build: the web app (`web/` is a Privy login stub) and daily payouts.

---

## Architecture

```
 buyer agent ──(1) GET quote / read ENS records──────────────► Sepolia ENSv2
     │                                                           tamil-scribe.nightshift.eth
     │ (2) POST /a/tamil-scribe/run  + X-Nightshift-Units           ▲ registerAgent / setReputation
     ▼                                                              │
 ┌──────────────── server (Express :8787) ───────────────────────────┴───┐
 │ runPrecheck: agent exists? active? input size = declared units?        │
 │              budget guard: today's 0G spend + estimate <= daily cap?   │
 │ x402 middleware: 402 → buyer signs USDC transfer → facilitator verify  │
 │ runHandler: 0G Router (whisper-large-v3) → transcript                  │
 │ settle (only if handler succeeded) → onAfterSettle: job=settled, HCS   │
 │ cron (10 min): reputation → NightshiftRegistrar.setReputation          │
 └───────┬───────────────────────┬────────────────────────┬───────────────┘
         ▼                       ▼                        ▼
   Supabase (Postgres)     0G Compute Router        Hedera testnet
   agents, jobs, secrets   (credits, micro-USD)     USDC 0.0.429274, HCS topic
```

If 0G fails, the handler returns 502 and the payment is **not** settled: the buyer is never charged for failed work.

---

## Repo layout

```
contracts/   Foundry: NightshiftRegistrar.sol, unit/fuzz/invariant/fork tests, deploy scripts
server/      Express + TypeScript agent runtime (x402, 0G, Hedera, ENS, Supabase, crons)
scripts/     CLIs: create an agent, pay an agent, reputation trigger, ENS read; spikes/ = first proofs
shared/      Shared TS constants, ENS record keys, registrar ABI
supabase/    SQL migrations
buyer/       Demo buyer agent (in progress) + samples/tamil-90s.mp3
web/         Next.js app (in progress)
```

---

## Setup

### 1. Prerequisites

| Tool | Version | Install |
|---|---|---|
| Node.js | 20 or newer | https://nodejs.org (or `nvm install 20`) |
| pnpm | 10.x | `corepack enable && corepack prepare pnpm@10.34.7 --activate` |
| Foundry | latest | `curl -L https://foundry.paradigm.xyz \| bash && foundryup` |
| Git | any | needed for the Foundry submodules |

The Supabase CLI is installed as a dev dependency (`pnpm exec supabase`); you only need it to apply migrations.

### 2. Clone with submodules

```bash
git clone --recurse-submodules git@github.com:krisha-9/NightShift.git
cd NightShift
# already cloned without submodules?
git submodule update --init --recursive
```

### 3. Install

```bash
pnpm install
```

### 4. Environment

All server, script and contract config lives in **one `.env` at the repo root**:

```bash
cp .env.example .env
```

Get the real values from Jash over a private channel. Never commit `.env` (it is gitignored) and never paste keys into issues or chat. What each group is for:

| Group | Needed for | Notes |
|---|---|---|
| `SECRETS_MASTER_KEY` | server | 32-byte hex; encrypts per-agent keys in Supabase. **Must match the one used when agents were created**, or their stored keys can't be decrypted. |
| `ZG_*` | 0G inference | `sk-` key calls the Router (spends credits), `mk-` key reads the balance |
| `HEDERA_*`, `TREASURY_*`, `X402_FACILITATOR_URL` | payments, HCS | testnet operator account pays account creation and HCS fees |
| `BUYER_*` | test buyer scripts | testnet account holding test USDC |
| `SEPOLIA_RPC_URL`, `ENS_OPERATOR_PRIVATE_KEY` | ENS reads/writes | operator is the registrar's hot key |
| `SEPOLIA_LOGS_RPC_URL` | indexer event scans | optional; a public node, because Alchemy's free tier caps `eth_getLogs` ranges |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | database | service-role key is server only |
| `PRIVY_*` | owner login | our own Privy app |

For the web app, create `web/.env.local` with only the `NEXT_PUBLIC_*` values from `.env.example`. Nothing secret ever goes into `web/`.

Want your own fresh setup instead of shared keys? You need: a 0G account at https://pc.0g.ai with credits and `sk-`/`mk-` keys; Hedera testnet accounts from https://portal.hedera.com (ECDSA) and test USDC from https://faucet.circle.com; a Sepolia RPC URL (Alchemy/Infura); a Supabase project with the migrations applied (step 6). The ENS registrar is already deployed; only its operator key can register agents.

### 5. Check everything is wired up

```bash
pnpm typecheck                 # all packages
pnpm lint
pnpm -C server test            # vitest: pricing, budget guard, crypto, records, reputation, directory
pnpm -C buyer test             # vitest: buyer decision rules, quote and payment-policy checks, spending
pnpm -C contracts test         # forge: unit + fuzz + invariant + Sepolia fork tests (needs SEPOLIA_RPC_URL)
pnpm -C contracts test:unit    # same without the fork tests (no RPC needed)
```

### 6. Database (only for a new Supabase project)

The shared project already has the schema. For your own project:

```bash
pnpm exec supabase link --project-ref <your-ref>
pnpm db:push                   # applies supabase/migrations/*
```

---

## Run it

### Start the server

```bash
pnpm -C server dev             # http://localhost:8787, restarts on file changes
curl localhost:8787/health     # {"ok":true,"zg":{...},"hedera":{...},"sepolia":{...},"supabase":{...}}
```

### API

| Method | Path | What it does |
|---|---|---|
| GET | `/health` | Checks 0G, Hedera mirror node, Sepolia RPC, Supabase |
| GET | `/directory?skill=&maxPrice=&minSuccess=&search=&status=&sort=&page=&limit=` | Agent search. Default lists runnable agents (`active`, `paused_budget`) cheapest first. Returns `{agents, total, page, limit}` |
| GET | `/directory/:name` | One directory entry (`kural` or `kural.nightshift.eth`) |
| GET | `/agents/:label` | Agent profile: database row + live ENS records + today's earnings |
| GET | `/a/:label/quote?units=2` | Free price quote `{amount, asset, network, payTo, unit}` |
| POST | `/a/:label/run` | **x402-paid.** Multipart `file` + header `X-Nightshift-Units: <minutes>`. Returns `{job_id, output, zg:{request_id, provider}}` and a `PAYMENT-RESPONSE` header with the Hedera tx |
| GET | `/stats` | Active agents, jobs, USDC earned and 0G credits used today |
| GET | `/buyer-console/run?skill=transcribe:ta` | **Spends funds.** Runs the buyer once on the sample clip and streams its steps as server-sent events. One run at a time, at most one per 20 s |
| GET | `/buyer-console/budget` | The buyer's spending rules and today's spend |

Errors before payment (nobody pays for these): `404 not_found`, `409 agent_paused`, `422 invalid_input` / `units_mismatch`, `503 over_budget` / `no_credits`.

### Pay an agent end to end (costs ~0.06 test USDC + ~$0.0125 of 0G credits)

With the server running, in a second terminal:

```bash
pnpm -C scripts exec tsx pay-run.ts tamil-scribe ../buyer/samples/tamil-90s.mp3 2
```

Expected: a quote, `/run -> 200`, the Tamil transcript, a `settled` line with a HashScan link, and the agent's USDC balance going up. The server log shows `verified → transcribed → job done → settled → HCS message`.

### Run the buyer agent (costs ~0.06 test USDC + ~$0.0125 of 0G credits)

With the server running, in a second terminal:

```bash
pnpm -C buyer start                                    # defaults: --skill transcribe:ta --file buyer/samples/tamil-90s.mp3
pnpm -C buyer start -- --skill transcribe:ta --file ./samples/tamil-90s.mp3
curl -N localhost:8787/buyer-console/run               # the same run, streamed as server-sent events
```

Expected: `PLAN` (2 min), `DISCOVER` 3 candidates, `VERIFY` ✅ ×3, `DECIDE kural` → `REFUSED` (503 over budget, not charged) → `DECIDE tamil-scribe` → `QUOTE` 0.06 USDC (matches ENS) → `PAID` with a HashScan link → `RESULT` with the Tamil transcript, job id and 0G request id. Spending rules live in `buyer/rules.json`; today's spend in `buyer/.state.json` (resets each UTC day).

To reset the three demo agents (caps, directory) at any time: `pnpm -C scripts exec tsx seed-agents.ts` (add `--dry-run` to preview).

### Write reputation to ENS now (instead of waiting for the 10-minute cron)

```bash
pnpm -C scripts exec tsx reputation-now.ts
pnpm -C scripts exec tsx ens-read.ts tamil-scribe.nightshift.eth   # nightshift.reputation = {"jobs":N,...}
```

### Launch a new agent (no UI yet)

Registers `<label>.nightshift.eth` on Sepolia, creates the agent's Hedera account, stores encrypted keys. Keys are read from env var **names**, never typed on the command line. Always dry-run first:

```bash
pnpm -C scripts exec tsx create-agent-cli.ts \
  --label my-agent --skill transcribe:hi \
  --price 30000 --cap 500000 \
  --owner-privy did:privy:<user id> --owner-evm 0x<owner wallet> \
  --zg-key-env ZG_TEAM_SK_KEY --zg-mgmt-env ZG_TEAM_MK_KEY \
  --dry-run
```

`--price` is USDC atomic units per minute (30000 = 0.03 USDC). `--cap` is the daily 0G budget in micro-USD (500000 = $0.50). Skills: `transcribe:ta`, `transcribe:hi`, `transcribe:en`. Remove `--dry-run` to launch for real. ENS names can't be reused, so pick labels carefully.

### Web app

```bash
pnpm -C web dev                # must be http://localhost:3000 (Privy allowed origin)
```

---

## Conventions

- **Money is never a float.** USDC is in atomic units (6 decimals). 0G costs and caps are micro-USD (1,000,000 = $1), as the Router bills. 0G unit prices are pico-USD.
- **Secrets stay on the server.** 0G keys, Hedera keys, the Supabase service-role key and the operator key never go to `web/` or into logs. Per-agent secrets are AES-256-GCM encrypted in the `agent_secrets` table, which has no public access.
- **Hedera SDK** is pinned to exactly `@hiero-ledger/sdk@2.85.0` (the version `@x402/hedera@2.28.0` uses). Two copies cause `t.startsWith is not a function`; `pnpm-workspace.yaml` forces one.
- Every external call has a timeout and logs with a prefix: `[0g]`, `[hedera]`, `[ens]`, `[x402]`, `[db]`.
- Conventional Commits (`feat(server): …`), one logical change per commit.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `[config] invalid environment: …` | A `.env` value is missing or malformed; the message names the variable |
| `fetch failed` / `ETIMEDOUT` to Alchemy on WSL | Already handled in code (`setDefaultAutoSelectFamilyAttemptTimeout`); check the RPC URL |
| `Node.js detected but native WebSocket not found` | Already handled (server passes `ws` to supabase-js); update to the latest `main` |
| `t.startsWith is not a function` | Duplicate Hedera SDK: `pnpm why @hiero-ledger/sdk`, then reinstall |
| `forge` can't find `@ensdomains/...` | Submodules missing: `git submodule update --init --recursive` |
| Paid run returns `503 over_budget` | The agent hit its daily 0G cap; it resets at 00:00 UTC |

## Deployed addresses (Sepolia / Hedera testnet)

| What | Address |
|---|---|
| NightshiftRegistrar | [`0x9564fFd96FBaA1bF10836966990aCc88a9865705`](https://sepolia.etherscan.io/address/0x9564fFd96FBaA1bF10836966990aCc88a9865705#code) |
| UserRegistry for `nightshift.eth` | [`0x68177337D020e03815bE894450914d7C94682425`](https://sepolia.etherscan.io/address/0x68177337D020e03815bE894450914d7C94682425) |
| HCS job log topic | [`0.0.11129931`](https://hashscan.io/testnet/topic/0.0.11129931) |
| USDC (Hedera testnet) | `0.0.429274` |

More in [`PROOFS.md`](PROOFS.md). Sponsor developer-experience notes are in [`FEEDBACK.md`](FEEDBACK.md).
