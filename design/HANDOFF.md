# Nightshift web: design handoff

This is the full brief for building `web/` (Phase 4). The approved visual direction is **"Chanda Mama, paper night"**: a light, printed-paper look with a moon mascot. It is self-contained: you do not need any file outside this repo.

- `design/mockup/*.dc.html`: the approved mockup, one file per page. Read these as the **visual source of truth**: exact colours, sizes, spacing, copy, states and interactions. They are written for a design-canvas runtime (`<x-dc>`, `<sc-if>`, `<sc-for>`, `{{holes}}`, a `renderVals()` logic class), so they will not run on their own. Translate them into React components, don't copy the runtime.
- Live clickable version: ask Jash for the canvas link (each page has a small **MOCKUP** dock at the bottom to switch states: loading, empty, error and so on). The dock is a review tool only; do not build it.
- Every number, id and transcript in the mockup is real data captured from the live system on one day. In the app **every value must come from the server, Supabase, ENS or the chain**. No hard-coded demo values in product code.

---

## 1. Stack (already decided)

- Next.js App Router (already in `web/`, Next 16, React 19), **must run on port 3000** (`pnpm -C web dev`); Privy login only works on localhost:3000.
- Tailwind CSS v4, shadcn/ui (Radix primitives, restyled to this theme), lucide-react icons (sparingly; the look is mostly custom SVG), Motion for the few animations, TanStack Query for server data, `@supabase/supabase-js` (anon key, read-only + Realtime), viem (Sepolia ENS reads in the browser), `@privy-io/react-auth` (already installed).
- TypeScript strict. Shared types/constants from `@nightshift/shared` (`formatUsdc`, `BuyerEvent` types, `OWNER_KEYS`, `REPUTATION_KEY`, `nightshiftRegistrarAbi`, `HEDERA_USDC_TOKEN_ID`).

## 2. Hard rules

1. **Secrets never reach the browser.** `web/` uses only `NEXT_PUBLIC_*` vars from `.env.example` (server URL, Supabase URL + anon key, Privy app id, Sepolia RPC, ENS parent name, demo-mode flag). Put them in `web/.env.local` (gitignored).
2. **Money is never a float.** USDC amounts are atomic integer strings (6 decimals). Display with `formatUsdc` from `@nightshift/shared`. 0G costs/caps are micro-USD integers (1,000,000 = $1); write a matching `formatUsdMicro` helper (bigint math) and unit-test it.
3. **No hard-coded demo values** in product paths. Empty states say what to do ("No jobs yet: run the buyer console").
4. Every external call has a loading state, an error state and a timeout. Sepolia writes take about 12 s: show progress with the tx link.
5. Every hash, id and ENS name is shown in mono, middle-truncated (`0xDfb0…8740`, `87c3b7be…fc54f878`), with copy and an explorer link where one exists:
   - Hedera tx: `https://hashscan.io/testnet/transaction/<payer>-<secs>-<nanos>` (from `0.0.x@secs.nanos`)
   - Hedera account / HCS topic: `https://hashscan.io/testnet/account/<id>`, `/topic/<id>`
   - Sepolia tx / address: `https://sepolia.etherscan.io/tx/<hash>`, `/address/<addr>`
   - ENS name: `https://app.ens.dev/<name>`
   - 0G request id: copy only (no explorer)
6. **Do not call `POST /buyer-console/run` in automated tests.** It spends real test USDC and 0G credits. Tests use recorded events (see section 7).
7. Never `git push` without Jash saying so. Conventional Commits, one task per commit. Do not commit anything with a date in it.

## 3. Design system

### Tokens (put these in the Tailwind theme / CSS variables)

| Token | Hex | Use |
|---|---|---|
| paper | `#F4ECDA` | page background |
| card | `#FBF6EA` | cards, buttons |
| white | `#FFFDF6` | receipts, tables, form sheets |
| ink | `#1F2547` | text, all borders, hard shadows |
| muted | `#575C7C` | secondary text (passes 4.5:1 on paper) |
| orange | `#FF6B3D` | **money / Hedera** fills; large text `#D9481A`, small text `#A8380C` |
| blue | `#3D63DD` | **ENS** / identity / links; also the riso print shadow |
| green | `#2FA36B` | **0G credits** fills; text `#177A4E` |
| red | `#C42A3A` | refused / over budget / errors |
| yellow | `#FFC93C` | moon, hover highlight, sticky notes `#FFF2B8` |
| moon shade | `#2B3160` | dark part of moon-phase avatars |

Tints used for state rows: refused `#F9DCD8`, paying/paid `#FFE2CF` / `#FFE9DC`, done `#DDEFD9`, ENS `#E6EBFA`.

### Type

- **Bricolage Grotesque** (Google Fonts, opsz 12..96, weights 400 to 800) for everything textual. Display headings weight 800, letter-spacing about -0.05em, line-height 0.9 to 1.
- **IBM Plex Mono** 400/500/600 for every number, id, label "kicker" (uppercase, letter-spacing .12em, 11 to 12 px) and the receipt/ledger text. Numbers use `font-variant-numeric: tabular-nums`.
- **Noto Sans Tamil** for transcripts (`lang="ta"`).
- Use `next/font/google` for all three.

### Texture and depth

- Halftone grain over the whole page: `radial-gradient(rgba(31,37,71,.08) .8px, transparent 1.1px)` at `5px 5px`, pointer-events none.
- Borders are **2px solid ink**, radius 4 to 6 px. Elevation is a **hard offset shadow** (`5px 5px 0 ink`; receipts use `6px 6px 0 blue`). No blur shadows, no gradients, no glass.
- Display headings get the misregistered print shadow `text-shadow: 3px 3px 0 rgba(61,99,221,.3)` (class `riso`).
- Slight rotations (-1.2° to +1.2°) only on "paper objects": receipts, ID card, sticky notes, stamps.

### Components to build (all visible in the mockup files)

| Component | Notes |
|---|---|
| `Masthead/Nav` | sticky, paper bg, 2px bottom rule; moon logo + "nightshift" wordmark; links Console, Directory, Dashboard, Launch; active link = ink fill; right side "payday in HH:MM:SS" chip and Sign in / wallet chip |
| `Button` | variants: default (card bg), `ink` (ink fill, orange hard shadow), `orange` (for HashScan), `sm`; hover nudges -1px with a 3px ink shadow |
| `Chip` / `ReceiptChip` | mono 12 px, 1.5px ink border, small coloured dot by rail (orange Hedera, blue ENS, green 0G), copy + external link |
| `Stamp` | rubber stamp: 2.5px border in currentColor, mono bold uppercase, rotated ±3 to 6°. States: ON SHIFT (green), OUT OF CREDITS / REFUSED / VOID (red), PAID (orange), ENS VERIFIED / LIVE (blue), APPROVED. Animated "stamp in" (scale 1.8 to 1, 350 ms) when it appears live |
| `MoonAvatar` | yellow circle with ink border; a `#2B3160` circle slides over it: `translateX(litFraction * 100%)`. **lit fraction = credits left today / daily cap** (0 = new moon = out of budget). Sizes 24 / 34 / 44 / 132 px |
| `ChandaMama` | the mascot SVG (crescent moon via mask, orange nightcap with pom-pom, closed eye, cheek, smile, chai glass with animated steam). Variants: `sipping` (hero, dashboard), `peeking` (console), `sleeping` (empty states, floating "z z"), `cloudy` (errors: cloud over the moon), `cheering` (launch success). Copy the SVG paths from the mockups. Gentle sway animation; respect `prefers-reduced-motion` |
| `TicketCountdown` | ink stub "SHIFT ENDS 00:00 UTC" + perforated edge + big mono countdown to next 00:00 UTC (updates every second) |
| `Receipt` | white paper, dashed rules, dotted leader rows (`label ······ value`), title in mono caps |
| `Ledger` table | mono, 2px ink header rule, dashed row rules |
| `IdCard` | blue header band, typed fields, reputation seal, machine-readable bottom line |
| `StickyNote` | `#FFF2B8`, tape strip, rotated |
| `ShiftStrip` | 24 h bar (00 to 24 UTC): orange ticks = paid jobs, short red ticks = refusals, yellow area = rest of tonight from "now" |

## 4. Pages, data and states

Server: `NEXT_PUBLIC_SERVER_URL` (default `http://localhost:8787`). Existing endpoints:

| Method | Path | Returns |
|---|---|---|
| GET | `/health` | status of 0G, Hedera, Sepolia, Supabase |
| GET | `/stats` | active agents, jobs, USDC earned, 0G credits used today |
| GET | `/directory?skill=&maxPrice=&minSuccess=&search=&status=&sort=&page=&limit=` | `{agents,total,page,limit}` |
| GET | `/directory/:name` | one entry |
| GET | `/agents/:label` | db row + live ENS records + today's earnings |
| GET | `/a/:label/quote?units=n` | `{amount, asset, network, payTo, unit}` |
| POST | `/buyer-console/run?skill=transcribe:ta` | **SSE**, spends funds; requires an allow-listed Privy bearer token. Events `plan, discover, verify, decide, quote, refused, payment_failed, paid, result, error`, then `complete`. One run at a time, 20 s apart (429 otherwise). Event shapes: `BuyerEvent` in `@nightshift/shared` |
| GET | `/buyer-console/budget` | buyer's spending rules and today's spend |

Supabase (anon, read-only): tables `agents`, `jobs` (status `settled` / `refused_budget` / …, `price_atomic`, `zg_cost_usd_micro`, `hedera_tx_id`, `zg_request_id`, `hcs_sequence`, `latency_ms`, `created_at`), `payouts`. Realtime is enabled on `jobs`, `payouts`, `agents`.

### `/` landing ("The Night Shift Gazette"): `Main.dc.html`
Masthead strip, hero headline "Your credits clock in when you clock out.", Chanda Mama sipping, `TicketCountdown`; stats band from `/stats` (refetch every 10 s, each number with a receipt chip); three numbered panels (0G / Hedera / ENS); "latest shift" receipt built from the most recent settled job (Supabase) with links to HashScan, 0G request id, HCS seq and the latest ENS reputation tx. If there are no jobs yet, show the receipt section with Chanda Mama sleeping and "No shifts worked yet tonight".

### `/console`: `Console.dc.html` (the demo centrepiece)
- Controls: skill select, sample file chip, Run button (disabled + spinner + elapsed while running). Note under it that it spends real test USDC.
- **The Wire**: buyer index card (wallet balance from the Hedera mirror node, spent today vs daily budget from `/buyer-console/budget`) → three dashed curves → worker index cards (with `MoonAvatar`). Each worker's state is derived from the event stream: `found` → `verified` (blue) → `chosen` (blue animated dash) → `refused` (red) or `paying` (orange animated dash) → `paid` → `done` (green). Workers not chosen end as "verified · not needed tonight".
- **The tape**: one row per SSE event (relative time, TAG, title, detail). Special rows: `decide` shows the 0G rationale as a quoted blue note; `refused` shows a red REFUSED · 503 stamp + "nothing was charged"; `paid` shows the big amount, PAID stamp and an orange "View on HashScan" button; `result` shows the Tamil transcript on lined paper (collapsed to 2 sentences with "Show full transcript") plus 0G request id and HCS seq. While waiting for payment/result show a "PAYING" row with spinner. Finish with a green "SHIFT COMPLETE" stamp and a summary line.
- Side: spending rules as a sticky note (from `/buyer-console/budget`).
- States: idle (Chanda Mama sleeping, "Quiet night so far"), running, finished, error (429 busy stamp, `error` event, network failure).

### `/agents/[label]`: `Agent.dc.html`
- **ID card**: name, skill, model, rate, payTo, owner, register tx, moon avatar (credits left), reputation seal, machine-readable line.
- **Registry entry**: every record in `OWNER_KEYS` + `nightshift.reputation`, **read in the browser with viem** (`getEnsText` on Sepolia; viem's built-in sepolia `ensUniversalResolver` already points at the ENSv2 Universal Resolver). Label it "Live from ENS · Sepolia". Each row stamped OWNER or REGISTRAR. Decode `nightshift.price` JSON into "= 0.03 USDC per minute". States: loading (dashed skeleton rows), error (Chanda Mama behind a cloud, "We show nothing rather than a cached copy", Retry).
- **Who holds the pen**: owner can edit / registrar only (link the reverted owner write from `PROOFS.md`) / nobody. Resolver address link.
- **Work log**: recent jobs for this agent (Supabase, Realtime).
- **Hire this worker**: curl and TypeScript tabs (the TS example uses `@x402/fetch` + `@x402/hedera`, see `buyer/src/agent.ts`), with the real endpoint from the `agent-endpoint[x402]` record.

### `/dashboard` (Privy login required): `Dashboard.dc.html`
- Headline sentence "Your workers earned X USDC." with "you keep 90%", credits used, refused count. Chanda Mama + payday ticket.
- Roster: per agent moon avatar, name, status stamp (ON SHIFT / OUT OF CREDITS / PAUSED), credits-vs-cap bar, earned, jobs, cap input + Save, Pause/Resume, "Records" (opens the edit drawer). Over-budget rows get a warning line.
- Ledger: live jobs via Supabase Realtime (new rows flash yellow), settled rows with HashScan / 0G / HCS chips, refused rows with "REFUSED · NOT CHARGED" stamp.
- Payday slip: earned − 10% = to you; payouts list (empty state until the payout cron exists).
- States: loading, empty (sleeping Chanda Mama, "Chanda Mama has nobody to watch over", CTA to Launch).
- **Edit records drawer (build last)**: description + price → `setText` on the agent's resolver **signed by the owner's Privy embedded wallet** (viem `custom(provider)` on Sepolia); show the tx link while confirming.

### `/launch` (login required): `Launch.dc.html`
Application form "NS-1" with folder tabs: 1 Connect (Privy, 0G balance, credits expire in), 2 Skill (Tamil/Hindi/English transcription; OCR shown disabled "SOON"), 3 Name & price (live availability check, suggested price = 4× credit cost), 4 Budget & keys (daily cap slider, `sk-` key, optional `mk-` key, optional Hedera payout account). Right side: the worker ID card preview filling in live. Submit → `POST /me/agents` → progress list: test 0G key → create Hedera account (link) → mint ENS name (Sepolia tx link, ~12 s) → encrypt keys → listed. Success: "APPROVED · ON SHIFT" stamp, Chanda Mama cheering, links, CTAs to dashboard and console.

### `/directory`: `Directory.dc.html`
Filters (skill segments, max price, sort, search) → `/directory`. Rows: moon avatar, name, rate, success + jobs, `ShiftStrip` for today, status stamp, ENS stamp. "✓ ENS VERIFIED" means the browser's own read of `registrar.resolverOf(label)` (Sepolia, `nightshiftRegistrarAbi`) matches the name's resolver; show "checking…" while reading. Empty state: sleeping moon "No Hindi workers on shift".

### Responsive
Must look right at **1440×900** (the demo video) and at **390 px** wide (judges on phones): rows stack, the Wire becomes a vertical list (curves hidden), tables scroll horizontally inside their card, nav scrolls.

## 5. Server work needed: owner API `/me/*`

Not built yet. Add `server/src/routes/me.ts` mounted as `app.use('/me', express.json(), privyAuth, meRouter)`.

- `privyAuth`: verify the `Authorization: Bearer <privy access token>` with `@privy-io/node` exactly as `scripts/spikes/privy-verify.ts` does (`new PrivyClient({appId, appSecret}).utils().auth().verifyAccessToken(token)`); 401 on failure. Uses `PRIVY_APP_ID` / `PRIVY_APP_SECRET` from the root `.env`.
- Endpoints (zod-validate every body):

| Method | Path | Body → result |
|---|---|---|
| GET | `/me` | owner + agents + today's usage |
| POST | `/me/agents` | `{label, skill, priceAtomic, dailyCapUsdMicro, zgApiKey, zgMgmtKey?, hederaPayoutAccount?}` → `{agentId, ensName, registerTx, hederaAccount, resolver}`. **Reuse `server/src/agents/launch.ts`** (`LaunchInput` / `LaunchResult`), the same code the CLI uses |
| PATCH | `/me/agents/:id` | `{status?: 'active' \| 'paused_owner', dailyCapUsdMicro?}`; only the owner's own agents |
| GET | `/me/agents/:id/jobs?limit=` | jobs list |
| GET | `/me/payouts` | payouts list |

Launch takes about 20 s (Sepolia); either stream progress (SSE) or return a job id and poll, so the progress list in the mockup is truthful. Add Vitest tests for auth rejection, validation and owner scoping.

## 6. Suggested order (commit after each)

1. App shell: fonts, tokens, grain, nav, Privy provider, TanStack Query, demo-mode flag, shared components (Button, Chip, Stamp, MoonAvatar, ChandaMama, TicketCountdown, Receipt).
2. `/console` with SSE (the demo centrepiece).
3. `/agents/[label]` with live ENS reads.
4. `/` landing with `/stats` and the latest receipt.
5. Server `/me/*` + Privy auth.
6. `/dashboard` with Realtime.
7. `/launch`.
8. `/directory`.
9. Edit-records drawer (owner-signed `setText`), only if everything else is done.

## 7. Testing

Run all of these green before each commit:

- `pnpm typecheck` and `pnpm lint` (whole repo).
- **Vitest unit tests** (`web/`): `formatUsdMicro`, countdown-to-00:00-UTC maths, moon lit fraction, middle truncation, HashScan/Etherscan URL builders, the console reducer that turns `BuyerEvent[]` into wire states and tape rows.
- **Recorded SSE fixture**: build the console against a fixture of a real run (Jash can export one run from Supabase `buyer_events`; the mockup's `Console.dc.html` contains the full real sequence). Add a dev-only switch to replay it so the UI can be developed and tested without spending funds.
- **Playwright smoke tests** (no paid calls): every page renders at 1440×900 and 390×844 without console errors; console replays the fixture to SHIFT COMPLETE; directory filter shows the empty state; agent page shows the registry loading, then records.
- `pnpm -C server test` stays green after adding `/me/*`.
- **Manual end-to-end (once, with Jash)**: from a fresh browser on localhost:3000 sign in, launch a worker, run the buyer console against it, watch the dashboard update live. This spends a little real test USDC and 0G credits.

Definition of done for the phase: that manual run works with no terminal, every number on screen links to its proof, every page has loading, empty and error states, and it looks like the mockup.
