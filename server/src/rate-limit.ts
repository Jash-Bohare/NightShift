// Fixed-window, process-local rate limiter. It bounds abuse of a single instance; a
// multi-instance deployment still needs a shared limiter (documented in STAGING_SETUP.md).
import type { RequestHandler } from "express";
import { ApiError } from "./errors.js";

export class WindowCounter {
  private readonly windows = new Map<string, { startsAt: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns the seconds to wait, or 0 when the request is allowed. */
  hit(key: string): number {
    const now = this.now();
    if (this.windows.size >= this.maxKeys)
      for (const [id, w] of this.windows)
        if (now - w.startsAt >= this.windowMs) this.windows.delete(id);
    let window = this.windows.get(key);
    if (!window || now - window.startsAt >= this.windowMs) {
      if (!window && this.windows.size >= this.maxKeys) return Math.ceil(this.windowMs / 1000);
      window = { startsAt: now, count: 0 };
      this.windows.set(key, window);
    }
    if (window.count >= this.limit)
      return Math.max(1, Math.ceil((window.startsAt + this.windowMs - now) / 1000));
    window.count++;
    return 0;
  }
}

export function rateLimit(name: string, limit: number, windowMs: number): RequestHandler {
  const counter = new WindowCounter(limit, windowMs);
  return (req, res, next) => {
    const wait = counter.hit(req.ip || req.socket.remoteAddress || "unknown");
    if (wait === 0) return next();
    res.setHeader("Retry-After", String(wait));
    next(new ApiError(429, "rate_limited", `too many ${name} requests; retry in ${wait} s`));
  };
}
