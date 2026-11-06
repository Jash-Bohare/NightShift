// 0G Compute Router client (OpenAI-compatible HTTP). Plain fetch, same calls as the
// verified spike (scripts/spikes/zg.ts). Every call has a timeout and throws UpstreamError.
import { env } from "../config.js";
import { UpstreamError } from "../errors.js";
import { log } from "../log.js";

export interface ZgBilling {
  currency?: unknown;
  input_cost?: unknown;
  output_cost?: unknown;
  total_cost?: unknown;
  total_cost_usd_micro?: unknown;
}

export interface ZgTrace {
  request_id: string;
  provider: string;
  billing?: ZgBilling;
}

/**
 * 0G executed (a request id exists) but its cost could not be established. Carries the ids an
 * operator needs to reconcile against GET /v1/account/usage/history.
 */
export class BillingUnavailableError extends UpstreamError {
  constructor(
    readonly requestId: string,
    readonly provider: string | null,
    reason: string,
  ) {
    super("0g", `request ${requestId}: ${reason}`);
    this.name = "BillingUnavailableError";
  }
}

/** What every skill executor returns (docs/04). */
export interface ZgResult {
  output: string;
  requestId: string;
  provider: string;
  costUsdMicro: bigint;
}

export interface ZgModel {
  id: string;
  type?: string;
  pricing_usd?: { prompt?: string; completion?: string };
}

export interface ZgBalance {
  address: string;
  currency: string;
  credit_balance: string;
  total_balance: string;
}

/** Parses a non-negative integer amount; JSON strings are canonical, safe integers tolerated. */
function microAmount(value: unknown): bigint | null {
  if (typeof value === "string" && /^(0|[1-9]\d{0,30})$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return null;
}

/**
 * Cost of one 0G Router request in micro-USD, per the Router API contract
 * (https://0gfoundation.github.io/0g-router/, x_0g_trace.billing):
 *   1. `total_cost_usd_micro` — the request's cost in micro-USD whatever the account settles in.
 *   2. otherwise, when `currency === "usd"`, `total_cost` is a micro-USD integer string
 *      (and `input_cost + output_cost == total_cost` when both parts are present).
 * `currency: "0g"` costs are wei and are never converted. Missing, malformed or negative
 * values throw BillingUnavailableError; zero is never substituted.
 */
export function billedCostUsdMicro(trace: ZgTrace | undefined): bigint {
  if (!trace?.request_id) throw new UpstreamError("0g", "response missing x_0g_trace.request_id");
  const unavailable = (reason: string) =>
    new BillingUnavailableError(trace.request_id, trace.provider ?? null, reason);
  const billing = trace.billing;
  if (!billing || typeof billing !== "object") throw unavailable("x_0g_trace.billing is missing");
  if (billing.total_cost_usd_micro !== undefined) {
    const micro = microAmount(billing.total_cost_usd_micro);
    if (micro === null) throw unavailable("billing.total_cost_usd_micro is malformed");
    return micro;
  }
  if (billing.currency !== "usd")
    throw unavailable(
      `billing has no total_cost_usd_micro and currency ${JSON.stringify(billing.currency ?? null)} is not usd`,
    );
  const total = microAmount(billing.total_cost);
  if (total === null) throw unavailable("billing.total_cost is missing or malformed");
  if (billing.input_cost !== undefined || billing.output_cost !== undefined) {
    const input = microAmount(billing.input_cost);
    const output = microAmount(billing.output_cost);
    if (input === null || output === null || input + output !== total)
      throw unavailable("billing input_cost + output_cost does not equal total_cost");
  }
  return total;
}

async function zg<T>(path: string, key: string, init: RequestInit, ms: number): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${env.ZG_ROUTER_URL}${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(ms),
    });
  } catch (err) {
    const why =
      err instanceof Error && err.name === "TimeoutError"
        ? `timed out after ${ms} ms`
        : String(err);
    throw new UpstreamError("0g", `${path}: ${why}`);
  }
  const body = await res.text();
  if (!res.ok)
    throw new UpstreamError(
      "0g",
      `${path} -> HTTP ${res.status}: ${body.slice(0, 300)}`,
      res.status,
    );
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new UpstreamError("0g", `${path}: non-JSON response`);
  }
}

function toResult(output: string, trace: ZgTrace | undefined): ZgResult {
  if (!trace?.request_id) throw new UpstreamError("0g", "response missing x_0g_trace.request_id");
  return {
    output,
    requestId: trace.request_id,
    provider: trace.provider,
    costUsdMicro: billedCostUsdMicro(trace),
  };
}

export async function transcribe(args: {
  key: string;
  model: string;
  audio: Buffer;
  filename: string;
  mime: string;
  language: string;
}): Promise<ZgResult> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(args.audio)], { type: args.mime }), args.filename);
  form.append("model", args.model);
  form.append("language", args.language);
  form.append("response_format", "json");
  const t0 = performance.now();
  const r = await zg<{ text?: string; x_0g_trace?: ZgTrace }>(
    "/audio/transcriptions",
    args.key,
    { method: "POST", body: form },
    90_000,
  );
  if (typeof r.text !== "string")
    throw new UpstreamError("0g", "transcription response missing text");
  const out = toResult(r.text, r.x_0g_trace);
  log("0g", "transcribed", {
    model: args.model,
    lang: args.language,
    chars: out.output.length,
    request_id: out.requestId,
    cost_usd_micro: out.costUsdMicro.toString(),
    ms: Math.round(performance.now() - t0),
  });
  return out;
}

export async function chat(args: {
  key: string;
  model: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  maxTokens: number;
}): Promise<ZgResult> {
  const r = await zg<{ choices?: { message?: { content?: string } }[]; x_0g_trace?: ZgTrace }>(
    "/chat/completions",
    args.key,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: args.model,
        messages: args.messages,
        max_tokens: args.maxTokens,
      }),
    },
    30_000,
  );
  return toResult(r.choices?.[0]?.message?.content ?? "", r.x_0g_trace);
}

let modelsCache: { at: number; models: ZgModel[] } | undefined;

/** GET /v1/models, cached for an hour. */
export async function listModels(key = env.ZG_TEAM_SK_KEY): Promise<ZgModel[]> {
  if (modelsCache && performance.now() - modelsCache.at < 3_600_000) return modelsCache.models;
  const r = await zg<{ data: ZgModel[] }>("/models", key, {}, 15_000);
  modelsCache = { at: performance.now(), models: r.data };
  return r.data;
}

/** GET /v1/account/balance with an mk- key (account:read). Amounts are micro-USD. */
export function balance(mgmtKey: string): Promise<ZgBalance> {
  return zg<ZgBalance>("/account/balance", mgmtKey, {}, 10_000);
}
