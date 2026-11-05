// Nightshift server. Middleware order follows docs/04 § Middleware order.
import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import { paymentMiddleware } from "@x402/express";
import { env } from "./config.js";
import { ApiError } from "./errors.js";
import { log, logError } from "./log.js";
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

