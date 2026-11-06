import { publicEnv } from "./public-env";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function serverGet<T>(
  path: string,
  signal?: AbortSignal,
  bearerToken?: string,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });

  try {
    const response = await fetch(`${publicEnv.serverUrl}${path}`, {
      headers: {
        accept: "application/json",
        ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
      },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) {
      let detail = `Request failed (${response.status})`;
      try {
        const body: unknown = await response.json();
        if (typeof body === "object" && body !== null && "message" in body) {
          const message = (body as { message?: unknown }).message;
          if (typeof message === "string") detail = message;
        }
      } catch {
        // Keep the HTTP status when the server does not return JSON.
      }
      throw new ApiError(detail, response.status);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (controller.signal.aborted) {
      throw new ApiError(
        signal?.aborted
          ? "Request was cancelled."
          : "The server did not respond within 12 seconds.",
      );
    }
    throw new ApiError(
      error instanceof Error ? error.message : "Could not reach the Nightshift server.",
    );
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

/** Authenticated JSON write (PATCH/POST) to the owner API, with the same error handling as GET. */
export async function serverSend<T>(
  path: string,
  init: { method: "POST" | "PATCH"; body: unknown; bearerToken: string; timeoutMs?: number },
): Promise<T> {
  const controller = new AbortController();
  const ms = init.timeoutMs ?? 20_000;
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    const response = await fetch(`${publicEnv.serverUrl}${path}`, {
      method: init.method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${init.bearerToken}`,
      },
      body: JSON.stringify(init.body),
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) throw new ApiError(await errorMessage(response), response.status);
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (controller.signal.aborted)
      throw new ApiError(`The server did not respond within ${Math.round(ms / 1000)} seconds.`);
    throw new ApiError(
      error instanceof Error ? error.message : "Could not reach the Nightshift server.",
    );
  } finally {
    clearTimeout(timeout);
  }
}

/** The server's `{message}` for a failed response, else the HTTP status. */
export async function errorMessage(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "message" in body) {
      const message = (body as { message?: unknown }).message;
      if (typeof message === "string" && message) return message;
    }
  } catch {
    // Not JSON: fall back to the status.
  }
  return `Request failed (${response.status})`;
}

export interface NightshiftStats {
  agents: number;
  jobsToday: number;
  failedJobsToday?: number;
  settlementFailuresToday?: number;
  usdcToday: string;
  creditsUsedToday: string | null;
  payouts?: { pending: number; failed: number; uncertain: number };
}

export interface PublicJob {
  id: string;
  status: string;
  price_atomic: string | number;
  zg_cost_usd_micro: string | number | null;
  zg_request_id: string | null;
  hedera_tx_id: string | null;
  hcs_sequence: string | null;
  latency_ms: number | null;
  created_at: string;
  agents?: { label: string; ens_name: string } | null;
}

export interface DirectoryAgent {
  label: string;
  ensName: string;
  owner: string;
  resolver: string;
  skill: string | null;
  price: { amount: string | null; asset: string; unit: string | null };
  payTo: string | null;
  endpoint: string | null;
  model: string | null;
  description: string | null;
  reputation: { jobs?: number; success?: number; p50_ms?: number; updated?: string } | null;
  status: string;
  expiry: string | null;
  updatedAt: string;
}

export interface DirectoryResponse {
  agents: DirectoryAgent[];
  total: number;
  page: number;
  limit: number;
}

export interface AgentProfile extends DirectoryAgent {
  registerTx: string | null;
  today: { jobsSettled: number; earnedAtomic: string };
  ens: Record<string, string | null> | null;
  ensError?: string;
}

export interface AgentQuote {
  amount: string;
  asset: string;
  network: string;
  payTo: string | null;
  unit: string;
  units: number;
  status: string;
}

export interface BuyerBudget {
  rules: {
    maxPerJobAtomic: string;
    dailyBudgetAtomic: string;
    allowedAssets: string[];
    allowedNetworks: string[];
    allowParentNames: string[];
    minSuccess: number;
    humanApprovalAboveAtomic: string;
  };
  state: {
    date: string;
    dailySpentAtomic: string;
    totalSpentAtomic: string;
    jobsCompleted: number;
    lastUpdated: string;
  };
  /** Buyer wallet read live from the Hedera mirror node; null when the server has no buyer. */
  wallet?: { accountId: string; usdcAtomic: string | null; error?: string } | null;
}
