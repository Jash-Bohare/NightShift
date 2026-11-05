// Nightshift server. Middleware order follows docs/04 § Middleware order.
import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import { paymentMiddleware } from "@x402/express";
import cron from "node-cron";
import { env } from "./config.js";
import { runIndexerCron } from "./cron/indexer.js";
import { runReputationBatch } from "./cron/reputation.js";
import { ApiError } from "./errors.js";
import { log, logError } from "./log.js";
import { buyerConsoleRouter } from "./routes/buyerConsole.js";
import { directoryRouter } from "./routes/directory.js";
import { publicRouter } from "./routes/public.js";
import { runHandler, runPrecheck } from "./routes/run.js";
import { JOB_HEADER, resourceServer, routes } from "./x402/server.js";

const app = express();
app.disable("x-powered-by");
app.use(
  cors({
    origin: [env.WEB_ORIGIN, "http://localhost:3000"],
    exposedHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", JOB_HEADER],
  }),
);
app.use(publicRouter);
app.use(directoryRouter);
app.use(buyerConsoleRouter);
app.post("/a/:label/run", runPrecheck); // 404 / 409 / 422 / 503 before any 402
app.use(paymentMiddleware(routes, resourceServer));
app.post("/a/:label/run", runHandler);

const onError: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ApiError) {
    res.status(err.status).json(err.toJSON());
    return;
  }
  logError("server", "unhandled", err);
  res.status(500).json({ error: "internal", message: "internal error" });
};
app.use(onError);

app.listen(env.PORT, () =>
  log("server", `listening on :${env.PORT}`, { facilitator: env.X402_FACILITATOR_URL }),
);

// Crons (UTC). Reputation: batch Sepolia writes every 10 min (docs/04 § Crons).
cron.schedule(
  "*/10 * * * *",
  () => void runReputationBatch().catch((e: unknown) => logError("cron", "reputation", e)),
  {
    timezone: "UTC",
  },
);

// Indexer: sync new registrations & ENS updates every 30 s
cron.schedule(
  "*/30 * * * * *",
  () => void runIndexerCron().catch((e: unknown) => logError("cron", "indexer", e)),
  {
    timezone: "UTC",
  },
);
