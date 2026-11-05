// 0G Compute Router client (OpenAI-compatible HTTP). Plain fetch, same calls as the
// verified spike (scripts/spikes/zg.ts). Every call has a timeout and throws UpstreamError.
import { env } from "../config.js";
import { UpstreamError } from "../errors.js";
import { log } from "../log.js";

export interface ZgTrace {
  request_id: string;
  provider: string;
  billing?: { currency?: string; total_cost?: string; total_cost_usd_micro?: string };
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
  const micro = trace.billing?.total_cost_usd_micro;
  return {
    output,
    requestId: trace.request_id,
    provider: trace.provider,
    costUsdMicro: micro && /^\d+$/.test(micro) ? BigInt(micro) : 0n,
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
