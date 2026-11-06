import { describe, expect, it } from "vitest";
import { UploadLimiter } from "./upload-limits.js";

describe("multipart upload admission", () => {
  it("limits simultaneous uploads globally and per client", () => {
    const limiter = new UploadLimiter({
      maxConcurrentTotal: 2,
      maxConcurrentPerClient: 1,
      now: () => 1,
    });
    const first = limiter.acquire("client-a");
    expect(first).toBeTypeOf("function");
    expect(limiter.acquire("client-a")).toBeNull();
    const second = limiter.acquire("client-b");
    expect(second).toBeTypeOf("function");
    expect(limiter.acquire("client-c")).toBeNull();
    first?.();
    expect(limiter.acquire("client-c")).toBeTypeOf("function");
  });

  it("enforces request windows and resets them without dropping active leases", () => {
    let now = 0;
    const limiter = new UploadLimiter({
      maxRequestsPerWindow: 1,
      windowMs: 100,
      maxConcurrentPerClient: 2,
      maxConcurrentTotal: 2,
      now: () => now,
    });
    const release = limiter.acquire("client-a");
    expect(limiter.acquire("client-a")).toBeNull();
    now = 101;
    expect(limiter.acquire("client-a")).toBeTypeOf("function");
    release?.();
  });

  it("releases capacity only once", () => {
    const limiter = new UploadLimiter({ maxConcurrentTotal: 1, now: () => 1 });
    const release = limiter.acquire("client-a");
    release?.();
    release?.();
    expect(limiter.acquire("client-b")).toBeTypeOf("function");
  });
});
