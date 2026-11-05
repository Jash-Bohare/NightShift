# Starter prompt for building `web/`

Paste everything below the line into Claude Code, opened at the repo root.

---

You are building the Nightshift web app (`web/`) and the owner API (`server/src/routes/me.ts`). The design is approved and final.

Read these first, fully, before writing any code:
1. `design/HANDOFF.md`: the complete brief (stack, hard rules, design tokens, components, every page with its data sources and states, the `/me/*` API, the build order and the test plan).
2. `design/mockup/*.dc.html`: the approved mockup, one file per page. It is the visual source of truth: match colours, type, spacing, copy, states and interactions exactly. These files use a canvas runtime (`<x-dc>`, `<sc-if>`, `<sc-for>`, `{{holes}}`, a `renderVals()` class) that will not run here; translate them into React components.
3. `README.md` (setup, API, conventions) and `PROOFS.md` (real ids, useful for fixtures).

How to work:
- Follow the build order in HANDOFF section 6. After each step: run `pnpm typecheck`, `pnpm lint` and the tests, then make one local commit with a Conventional Commits message. Never `git push`.
- Never guess an SDK API. Check the package's types in `node_modules` (or existing usage in `server/`, `buyer/`, `scripts/spikes/`) before using it.
- Every value on screen comes from the server, Supabase, ENS or the chain. No hard-coded demo values. Money only through `formatUsdc` / a bigint micro-USD formatter, never floats.
- Secrets never go into `web/`; it reads only `NEXT_PUBLIC_*` from `web/.env.local`.
- Never call `GET /buyer-console/run` from tests or loops: it spends real test USDC. Use the recorded-run fixture described in HANDOFF section 7.
- `web/` must run on port 3000.
- If something in the handoff is wrong in practice or you need a decision, a key or an account, stop and ask me instead of working around it.

Start with step 1 (app shell and shared components). Show me the plan for it before writing code.
