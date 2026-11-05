// Buyer console (docs/05 run modes): GET /buyer-console/run streams one real buyer run as SSE;
// GET /buyer-console/budget shows the buyer's spending rules and today's spend.
// Each run spends real testnet USDC and 0G credits: one run at a time, at most one per 20 s.
import { DEFAULT_SAMPLE_FILE, loadRules, loadState, runBuyer } from "@nightshift/buyer";
import type { BuyerEvent } from "@nightshift/shared";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { db } from "../db/client.js";
import { ApiError } from "../errors.js";
import { log, logError } from "../log.js";

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

buyerConsoleRouter.get("/buyer-console/budget", (_req, res) => {
  res.json({ rules: loadRules(), state: loadState() });
});

function persist(event: BuyerEvent, runId: string): void {
  void db
    .from("buyer_events")
    .insert({ event_type: event.kind, payload: { runId, ...event } })
    .then(({ error }) => {
      if (error) logError("db", `buyer_events insert (${event.kind})`, error.message);
    });
}

buyerConsoleRouter.get("/buyer-console/run", async (req: Request, res: Response) => {
  const q = RunQuery.safeParse(req.query);
  if (!q.success) throw new ApiError(422, "invalid_input", "skill must look like transcribe:ta");
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
