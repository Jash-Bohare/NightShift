// Buyer Console SSE stream route: /buyer-console/run and /buyer/stream (docs/05-buyer-agent.md § Run modes)
import { resolve } from "node:path";
import { runBuyer, loadRules, loadState } from "@nightshift/buyer";
import type { BuyerEvent } from "@nightshift/shared";
import { Router } from "express";
import { db } from "../db/client.js";
import { ApiError } from "../errors.js";
import { log, logError } from "../log.js";

export const buyerConsoleRouter = Router();

// Rate limiting: 1 run per 20 seconds (docs/08-roadmap.md § P3.5)
let lastRunAt = 0;
const RATE_LIMIT_MS = 20_000;

buyerConsoleRouter.get("/buyer/budget", (_req, res) => {
  try {
    const rules = loadRules();
    const state = loadState();
    res.json({ success: true, rules, state });
  } catch (err) {
    res.status(500).json({ error: "failed_to_load_budget", message: String(err) });
  }
});

buyerConsoleRouter.get("/buyer/spending", (_req, res) => {
  try {
    const state = loadState();
    res.json({ success: true, state });
  } catch (err) {
    res.status(500).json({ error: "failed_to_load_state", message: String(err) });
  }
});

async function handleBuyerStream(req: any, res: any) {
  const now = Date.now();
  const timeSinceLastRun = now - lastRunAt;
  if (timeSinceLastRun < RATE_LIMIT_MS) {
    const waitSec = Math.ceil((RATE_LIMIT_MS - timeSinceLastRun) / 1000);
    throw new ApiError(429, "rate_limited", `Rate limited: please wait ${waitSec}s (1 run per 20s)`);
  }
  lastRunAt = now;

  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  // Send initial connection event
  const streamId = req.query.streamId || `stream-${Date.now()}`;
  res.write(`: connected stream=${streamId}\n\n`);

  // Periodic heartbeat every 15 s
  const heartbeat = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      clearInterval(heartbeat);
    }
  }, 15_000);

  let aborted = false;
  req.on("close", () => {
    aborted = true;
    clearInterval(heartbeat);
  });

  const skill = (req.query.skill as string) || "transcribe:ta";
  // Default to repo sample audio file
  const samplePath = resolve(process.cwd(), "buyer/samples/tamil-90s.mp3");

  log("server", "buyer stream started", { streamId, skill });

  const onEvent = (event: BuyerEvent) => {
    if (aborted) return;
    const eventId = `evt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const sseMessage = `id: ${eventId}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
    try {
      res.write(sseMessage);
    } catch {}

    // Persist event to Supabase buyer_events for durability & audit
    void db
      .from("buyer_events")
      .insert({
        event_type: event.kind,
        payload: event as any,
      })
      .then();
  };

  try {
    const result = await runBuyer(
      {
        skill,
        file: samplePath,
      },
      {
        onEvent,
      },
    );

    if (!aborted) {
      res.write(
        `event: complete\ndata: ${JSON.stringify({ success: result.success, chosen: result.chosenAgent, tx: result.txId })}\n\n`,
      );
      res.end();
    }
  } catch (err) {
    if (!aborted) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: String(err) })}\n\n`);
      res.end();
    }
  } finally {
    clearInterval(heartbeat);
  }
}

// Mount both GET /buyer-console/run and GET /buyer/stream
buyerConsoleRouter.get("/buyer-console/run", handleBuyerStream);
buyerConsoleRouter.get("/buyer/stream", handleBuyerStream);
