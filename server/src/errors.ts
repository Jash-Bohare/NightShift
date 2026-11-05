// Typed errors for external calls and API responses (docs/04 § API error codes).
export type ApiErrorCode =
  | "unauthorized"
  | "label_taken"
  | "invalid_label"
  | "invalid_zg_key"
  | "invalid_input"
  | "not_found"
  | "over_budget"
  | "no_credits"
  | "units_mismatch"
  | "agent_paused"
  | "zg_unavailable"
  | "rate_limited"
  | "internal";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }

  toJSON() {
    return {
      error: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export type Upstream = "0g" | "hedera" | "ens" | "x402" | "db";

/** An external dependency failed or timed out. */
export class UpstreamError extends Error {
  constructor(
    readonly upstream: Upstream,
    message: string,
    readonly status?: number,
  ) {
    super(`[${upstream}] ${message}`);
    this.name = "UpstreamError";
  }
}

/** Race a promise against a timeout; rejects with UpstreamError on expiry. */
export async function withTimeout<T>(
  upstream: Upstream,
  what: string,
  ms: number,
  p: Promise<T>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new UpstreamError(upstream, `${what} timed out after ${ms} ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
