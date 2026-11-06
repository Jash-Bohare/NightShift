// Buyer console (docs/05 run modes): POST /buyer-console/run streams one real buyer run as SSE;
// authenticated GET routes expose spending rules and the allow-listed event history.
// Each run spends real testnet USDC and 0G credits: one run at a time, at most one per 20 s.
import { DEFAULT_SAMPLE_FILE, loadRules, loadState, runBuyer } from "@nightshift/buyer";
import type { BuyerEvent } from "@nightshift/shared";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { db } from "../db/client.js";
import { env } from "../config.js";
import { ApiError, UpstreamError } from "../errors.js";
import { log, logError } from "../log.js";
import { authorizeBuyerConsole } from "../buyer-console-auth.js";
import { usdcBalance } from "../hedera/mirror.js";

export const buyerConsoleRouter = Router();

export const RATE_LIMIT_MS = 20_000;
let lastRunAt = 0;
let running = false;

const RunQuery = z.object({
  skill: z
    .string()
    .regex(/^[a-z]+:[a-z]{2}$/)
    .default("transcribe:ta"),
});
const RunId = z.string().regex(/^run-\d{10,16}$/);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, max = 500): string | undefined {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

function safeRunEvent(kind: string, raw: unknown, runId: string): Record<string, unknown> | null {
  const event = record(raw);
  if (!event || event.kind !== kind || typeof event.timestamp !== "string") return null;
  const safe: Record<string, unknown> = {
    runId,
    kind,
    timestamp: event.timestamp,
  };
  const task = record(event.task);
  const rules = record(event.rules);
  const chosen = record(event.chosen);
  switch (kind) {
    case "plan":
      if (!task || !rules || typeof task.skill !== "string" || typeof task.units !== "number")
        return null;
      safe.task = { skill: task.skill, units: task.units };
      safe.rules = rules;
      break;
    case "discover":
      if (!Array.isArray(event.candidates)) return null;
      safe.candidates = event.candidates.flatMap((item) => {
        const candidate = record(item);
        if (
          !candidate ||
          typeof candidate.label !== "string" ||
          typeof candidate.ensName !== "string" ||
          typeof candidate.skill !== "string" ||
          typeof candidate.priceAtomic !== "string"
        )
          return [];
        return [
          {
            label: candidate.label,
            ensName: candidate.ensName,
            skill: candidate.skill,
            priceAtomic: candidate.priceAtomic,
            reputation: record(candidate.reputation),
          },
        ];
      });
      break;
    case "verify":
      if (
        typeof event.label !== "string" ||
        typeof event.ensName !== "string" ||
        typeof event.ok !== "boolean"
      )
        return null;
      Object.assign(safe, {
        label: event.label,
        ensName: event.ensName,
        ok: event.ok,
        reason: text(event.reason),
        resolver: text(event.resolver, 128),
        payTo: text(event.payTo, 32),
      });
      break;
    case "decide":
      if (
        !chosen ||
        typeof chosen.label !== "string" ||
        typeof chosen.ensName !== "string" ||
        typeof chosen.priceAtomic !== "string" ||
        typeof chosen.payTo !== "string" ||
        !Array.isArray(event.rejected)
      )
        return null;
      safe.chosen = {
        label: chosen.label,
        ensName: chosen.ensName,
        priceAtomic: chosen.priceAtomic,
        payTo: chosen.payTo,
      };
      safe.rationale = text(event.rationale) ?? "Selected by buyer policy.";
      safe.rejected = event.rejected.flatMap((item) => {
        const rejected = record(item);
        return rejected && typeof rejected.label === "string"
          ? [{ label: rejected.label, reason: text(rejected.reason) ?? "" }]
          : [];
      });
      break;
    case "quote":
      if (
        typeof event.label !== "string" ||
        typeof event.units !== "number" ||
        typeof event.amount !== "string" ||
        typeof event.asset !== "string" ||
        typeof event.payTo !== "string"
      )
        return null;
      Object.assign(safe, {
        label: event.label,
        units: event.units,
        amount: event.amount,
        asset: event.asset,
        payTo: event.payTo,
      });
      break;
    case "refused":
      if (typeof event.label !== "string" || typeof event.status !== "number") return null;
      Object.assign(safe, {
        label: event.label,
        status: event.status,
        reason: text(event.reason) ?? "",
      });
      break;
    case "payment_failed":
      if (typeof event.label !== "string") return null;
      Object.assign(safe, { label: event.label, error: text(event.error) ?? "Payment failed." });
      break;
    case "paid":
      if (
        typeof event.label !== "string" ||
        typeof event.txId !== "string" ||
        typeof event.hashscanUrl !== "string" ||
        typeof event.amount !== "string"
      )
        return null;
      Object.assign(safe, {
        label: event.label,
        txId: event.txId,
        hashscanUrl: event.hashscanUrl,
        amount: event.amount,
      });
      break;
    case "result":
      if (typeof event.label !== "string" || typeof event.text !== "string") return null;
      Object.assign(safe, {
        label: event.label,
        text: event.text.slice(0, 1000),
        jobId: text(event.jobId, 64),
        zgRequestId: text(event.zgRequestId, 128),
        latencyMs: typeof event.latencyMs === "number" ? event.latencyMs : undefined,
      });
      break;
    case "error":
      if (typeof event.message !== "string") return null;
      Object.assign(safe, {
        message: text(event.message) ?? "Buyer run failed.",
        step: text(event.step, 64),
      });
      break;
    default:
      return null;
  }
  for (const key of Object.keys(safe)) if (safe[key] === undefined) delete safe[key];
  return safe;
}

buyerConsoleRouter.get("/buyer-console/budget", async (req, res) => {
  await authorizeBuyerConsole(req.header("authorization"));
  res.setHeader("Cache-Control", "no-store");
  // The buyer wallet balance is public on the mirror node; a lookup failure is reported, not
  // hidden, and never blocks the rules/spend view.
  const accountId = process.env.BUYER_HEDERA_ACCOUNT_ID;
  let wallet: { accountId: string; usdcAtomic: string | null; error?: string } | null = null;
  if (accountId && /^0\.0\.\d+$/.test(accountId)) {
    try {
      wallet = { accountId, usdcAtomic: (await usdcBalance(accountId)).toString() };
    } catch (error) {
      logError("hedera", "buyer wallet balance", error);
      wallet = { accountId, usdcAtomic: null, error: "mirror node unavailable" };
    }
  }
  res.json({ rules: loadRules(), state: loadState(), wallet });
});

buyerConsoleRouter.get("/buyer-console/events/:runId", async (req, res) => {
  await authorizeBuyerConsole(req.header("authorization"));
  const parsed = RunId.safeParse(req.params.runId);
  if (!parsed.success) throw new ApiError(422, "invalid_input", "invalid run id");
  const result = await db
    .from("buyer_events")
    .select("event_type,payload,created_at")
    .eq("payload->>runId", parsed.data)
    .order("created_at", { ascending: true })
    .limit(500);
  if (result.error) throw new UpstreamError("db", `buyer event recovery: ${result.error.message}`);
  const events = (
    (result.data ?? []) as {
      event_type: string;
      payload: unknown;
      created_at: string;
    }[]
  ).flatMap((row) => {
    const payload = safeRunEvent(row.event_type, row.payload, parsed.data);
    return payload ? [{ event_type: row.event_type, payload, created_at: row.created_at }] : [];
  });
  res.setHeader("Cache-Control", "no-store");
  res.json({ events });
});

function persist(event: BuyerEvent, runId: string): void {
  void db
    .from("buyer_events")
    .insert({ event_type: event.kind, payload: { runId, ...event } })
    .then(({ error }) => {
      if (error) logError("db", `buyer_events insert (${event.kind})`, error.message);
    });
}

buyerConsoleRouter.post("/buyer-console/run", async (req: Request, res: Response) => {
  const q = RunQuery.safeParse(req.query);
  if (!q.success) throw new ApiError(422, "invalid_input", "skill must look like transcribe:ta");
  if (!env.BUYER_CONSOLE_ENABLED)
    throw new ApiError(
      503,
      "feature_disabled",
      "the paid buyer console is disabled on this server",
    );
  await authorizeBuyerConsole(req.header("authorization"));
  if (running) throw new ApiError(429, "rate_limited", "a buyer run is already in progress");
  const wait = lastRunAt + RATE_LIMIT_MS - Date.now();
  if (wait > 0)
    throw new ApiError(
      429,
      "rate_limited",
      `one run per 20 s; retry in ${Math.ceil(wait / 1000)} s`,
    );
  running = true;
  lastRunAt = Date.now();

  const runId = `run-${lastRunAt}`;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`: ${runId}\n\n`);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
  let closed = false;
  res.on("close", () => {
    closed = true;
    clearInterval(heartbeat);
  });
  const send = (event: string, data: unknown) => {
    if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  log("server", "buyer console run started", { runId, skill: q.data.skill });
  try {
    // The run continues if the viewer disconnects: a payment may already be in flight.
    const result = await runBuyer(
      { skill: q.data.skill, file: DEFAULT_SAMPLE_FILE },
      {
        onEvent: (e) => {
          send(e.kind, e);
          persist(e, runId);
        },
      },
    );
    send("complete", {
      success: result.success,
      chosen: result.chosenAgent ?? null,
      tx: result.txId ?? null,
      error: result.error ?? null,
    });
    log("server", "buyer console run finished", {
      runId,
      success: result.success,
      tx: result.txId,
    });
  } catch (err) {
    logError("server", `buyer console run ${runId} crashed`, err);
    send("complete", { success: false, chosen: null, tx: null, error: "internal error" });
  } finally {
    running = false;
    clearInterval(heartbeat);
    if (!closed) res.end();
  }
});
