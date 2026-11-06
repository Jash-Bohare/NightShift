import type { QuoteClaims } from "./quote-signing.js";
import { UpstreamError } from "./errors.js";
import { db } from "./db/client.js";
import { quoteTokenDigest } from "./quote-signing.js";

export async function claimVerifiedQuote(
  claims: QuoteClaims,
  token: string,
  agentId: string,
): Promise<boolean> {
  const cleanup = await db
    .from("quote_redemptions")
    .delete()
    .lt("expires_at", new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString());
  if (cleanup.error)
    throw new UpstreamError("db", `clean expired quote redemptions: ${cleanup.error.message}`);
  const result = await db.from("quote_redemptions").insert({
    nonce: claims.nonce,
    quote_digest: quoteTokenDigest(token),
    agent_id: agentId,
    state: "verified",
    expires_at: new Date(claims.exp * 1000).toISOString(),
  });
  if (!result.error) return true;
  if (result.error.code === "23505") return false;
  throw new UpstreamError("db", `claim signed quote nonce: ${result.error.message}`);
}

export async function attachQuoteJob(nonce: string, jobId: string): Promise<void> {
  const result = await db
    .from("quote_redemptions")
    .update({ state: "executing", job_id: jobId })
    .eq("nonce", nonce)
    .eq("state", "verified")
    .select("nonce")
    .maybeSingle();
  if (result.error) throw new UpstreamError("db", `attach quote job: ${result.error.message}`);
  if (!result.data) throw new UpstreamError("db", "quote nonce was already consumed");
}

export async function settleQuoteJob(jobId: string): Promise<void> {
  const result = await db
    .from("quote_redemptions")
    .update({ state: "settled" })
    .eq("job_id", jobId)
    .eq("state", "executing")
    .select("nonce")
    .maybeSingle();
  if (result.error)
    throw new UpstreamError("db", `settle quote redemption: ${result.error.message}`);
  if (!result.data) {
    const existing = await db
      .from("quote_redemptions")
      .select("state")
      .eq("job_id", jobId)
      .maybeSingle();
    if (existing.error)
      throw new UpstreamError("db", `read settled quote redemption: ${existing.error.message}`);
    if ((existing.data as { state: string } | null)?.state === "settled") return;
    throw new UpstreamError("db", "settled job has no active signed quote redemption");
  }
}

export async function failQuoteNonce(nonce: string): Promise<void> {
  const result = await db
    .from("quote_redemptions")
    .update({ state: "failed" })
    .eq("nonce", nonce)
    .in("state", ["verified", "executing"])
    .select("nonce")
    .maybeSingle();
  if (result.error) throw new UpstreamError("db", `fail quote redemption: ${result.error.message}`);
}

export async function failQuoteJob(jobId: string): Promise<void> {
  const result = await db
    .from("quote_redemptions")
    .update({ state: "failed" })
    .eq("job_id", jobId)
    .eq("state", "executing")
    .select("nonce")
    .maybeSingle();
  if (result.error) throw new UpstreamError("db", `fail quote job: ${result.error.message}`);
}
