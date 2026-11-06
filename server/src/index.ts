// Nightshift server entry point: listen, then (only if explicitly enabled) schedule crons.
import cron from "node-cron";
import { createApp } from "./app.js";
import { env } from "./config.js";
import { runIndexerCron } from "./cron/indexer.js";
import { runDailyPayouts } from "./cron/payouts.js";
import { runReputationBatch } from "./cron/reputation.js";
import { scheduleCrons } from "./cron/schedule.js";
import { runSettlementRecoveries } from "./cron/settlements.js";
import { log, logError } from "./log.js";

const app = createApp();

// Express 5 passes listen errors (e.g. EADDRINUSE) to this callback: fail loudly, start nothing.
app.listen(env.PORT, (err?: Error) => {
  if (err) {
    logError("server", `cannot listen on :${env.PORT}`, err);
    process.exit(1);
  }
  log("server", `listening on :${env.PORT}`, {
    env: env.NODE_ENV,
    facilitator: env.X402_FACILITATOR_URL,
    buyerConsole: env.BUYER_CONSOLE_ENABLED ? "enabled" : "disabled",
  });
  scheduleCrons(
    { cronsEnabled: env.CRONS_ENABLED, payoutsEnabled: env.PAYOUTS_ENABLED },
    {
      indexer: runIndexerCron,
      reputation: runReputationBatch,
      settlementRecovery: runSettlementRecoveries,
      payouts: runDailyPayouts,
    },
    (expression, task, options) => void cron.schedule(expression, task, options),
  );
});
