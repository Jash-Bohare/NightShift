// Express application factory. index.ts listens and starts scheduled jobs; tests import this
// module directly so the real middleware order is exercised without opening network listeners
// or registering crons. Middleware order follows docs/04 § Middleware order.
import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import { paymentMiddleware } from "@x402/express";
import { env } from "./config.js";
import { ApiError } from "./errors.js";
import { logError } from "./log.js";
import { buyerConsoleRouter } from "./routes/buyerConsole.js";
import { directoryRouter } from "./routes/directory.js";
import { jobsRouter } from "./routes/jobs.js";
import { meRouter } from "./routes/me.js";
import { meAgentsRouter } from "./routes/meAgents.js";
import { meLaunchRouter } from "./routes/meLaunch.js";
import { skillsRouter } from "./routes/skills.js";
import { capabilitiesRouter } from "./routes/capabilities.js";
import { publicRouter } from "./routes/public.js";
import { payoutsRouter } from "./routes/payouts.js";
import { runHandler, runPrecheck } from "./routes/run.js";
import { JOB_HEADER, resourceServer, routes } from "./x402/server.js";
import { rateLimit } from "./rate-limit.js";

export function corsOrigins(): string[] {
  // The local web origin is only implicitly trusted outside production.
  return env.NODE_ENV === "production"
    ? env.WEB_ORIGIN
    : [...new Set([...env.WEB_ORIGIN, "http://localhost:3000"])];
}

export function createApp(): express.Express {
  const app = express();
  app.disable("x-powered-by");
  if (env.TRUST_PROXY_HOPS > 0) app.set("trust proxy", env.TRUST_PROXY_HOPS);
  app.use(
    cors({
      origin: corsOrigins(),
      exposedHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", JOB_HEADER],
    }),
  );
  // Per-client limits for unauthenticated endpoints that touch the database or upstream RPCs.
  app.use(
    ["/a/:label/quote", "/a/:label/run"],
    rateLimit("worker", env.WORKER_REQUESTS_PER_MINUTE, 60_000),
  );
  app.use(["/health", "/ready"], rateLimit("health", 30, 60_000));
  app.use(
    ["/directory", "/agents", "/jobs", "/stats", "/skills", "/capabilities"],
    rateLimit("public", 240, 60_000),
  );
  app.use(["/me", "/buyer-console"], rateLimit("private", 120, 60_000));
  app.use(publicRouter);
  app.use(skillsRouter);
  app.use(capabilitiesRouter);
  app.use(directoryRouter);
  app.use(payoutsRouter);
  app.use(jobsRouter);
  app.use(meRouter);
  app.use(meAgentsRouter);
  app.use(meLaunchRouter);
  app.use(buyerConsoleRouter);
  app.post("/a/:label/run", runPrecheck); // 404 / 409 / 422 / 503 before any 402
  app.use(paymentMiddleware(routes, resourceServer));
  app.post("/a/:label/run", runHandler);

  const onError: ErrorRequestHandler = (err, _req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof ApiError) {
      res.status(err.status).json(err.toJSON());
      return;
    }
    logError("server", "unhandled", err);
    res.status(500).json({ error: "internal", message: "internal error" });
  };
  app.use(onError);
  return app;
}
