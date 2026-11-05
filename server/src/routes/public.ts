// Public, unauthenticated routes: /health (more in P2.6).
import { Router } from "express";
import { health } from "../health.js";

export const publicRouter = Router();

publicRouter.get("/health", async (_req, res) => {
  const h = await health();
  res.status(h.ok ? 200 : 503).json(h);
});
