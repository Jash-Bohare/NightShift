// Supabase service-role client. Server only: this key bypasses RLS.
import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import { env } from "../config.js";
import { UpstreamError } from "../errors.js";

export const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  // supabase-js 2.119 builds a Realtime client eagerly and Node 20 has no native
  // WebSocket. The server never subscribes; this only satisfies the constructor.
  realtime: { transport: WebSocket as never },
  global: {
    fetch: (input, init) =>
      fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(10_000) }),
  },
});

/** Unwrap a supabase-js result, throwing a typed error on failure. */
export function must<T>(what: string, r: { data: T | null; error: { message: string } | null }): T {
  if (r.error) throw new UpstreamError("db", `${what}: ${r.error.message}`);
  if (r.data === null) throw new UpstreamError("db", `${what}: no data`);
  return r.data;
}

/** PostgREST returns bigint/numeric as JSON numbers or strings; normalise to bigint. */
export function big(v: string | number | null | undefined): bigint {
  if (v === null || v === undefined) return 0n;
  return typeof v === "number" ? BigInt(Math.trunc(v)) : BigInt(v);
}
