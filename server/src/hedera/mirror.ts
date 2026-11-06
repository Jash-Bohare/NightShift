// Hedera Mirror Node reads (docs/07 § Hedera). Read-only, unauthenticated, 10 s timeout each.
import { z } from "zod";
import { env } from "../config.js";
import { UpstreamError } from "../errors.js";

const AccountResponse = z.object({
  account: z.string(),
  deleted: z.boolean().optional(),
  max_automatic_token_associations: z.number().int(),
});

const TokenRelationships = z.object({
  tokens: z.array(z.object({ token_id: z.string() })),
});

export type PayoutAccountCheck =
  { ok: true } | { ok: false; reason: "not_found" | "deleted" | "not_associated" };

async function getJson(path: string, fetcher: typeof fetch): Promise<unknown | null> {
  let response: Response;
  try {
    response = await fetcher(`${env.HEDERA_MIRROR_URL}${path}`, {
      signal: AbortSignal.timeout(10_000),
      headers: { accept: "application/json" },
    });
  } catch (error) {
    throw new UpstreamError(
      "hedera",
      `mirror ${path}: ${error instanceof Error ? error.message : "request failed"}`,
    );
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new UpstreamError("hedera", `mirror ${path}: HTTP ${response.status}`);
  return response.json();
}

/**
 * Can `accountId` receive USDC? It must exist, not be deleted, and either already hold a USDC
 * token relationship or accept unlimited automatic associations (-1). A limited positive
 * auto-association budget may already be used up, so it is not accepted.
 */
export async function checkPayoutAccount(
  accountId: string,
  tokenId = env.HEDERA_USDC_TOKEN_ID,
  fetcher: typeof fetch = fetch,
): Promise<PayoutAccountCheck> {
  const account = await getJson(`/api/v1/accounts/${encodeURIComponent(accountId)}`, fetcher);
  if (account === null) return { ok: false, reason: "not_found" };
  const parsed = AccountResponse.safeParse(account);
  if (!parsed.success || parsed.data.account !== accountId)
    throw new UpstreamError("hedera", `mirror returned a malformed account for ${accountId}`);
  if (parsed.data.deleted) return { ok: false, reason: "deleted" };
  if (parsed.data.max_automatic_token_associations === -1) return { ok: true };
  const relationships = await getJson(
    `/api/v1/accounts/${encodeURIComponent(accountId)}/tokens?token.id=${encodeURIComponent(tokenId)}`,
    fetcher,
  );
  const tokens = TokenRelationships.safeParse(relationships);
  if (!tokens.success)
    throw new UpstreamError("hedera", `mirror returned malformed tokens for ${accountId}`);
  return tokens.data.tokens.some((token) => token.token_id === tokenId)
    ? { ok: true }
    : { ok: false, reason: "not_associated" };
}
