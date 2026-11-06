import { z } from "zod";
import type { BuyerPublicConfig } from "./config.js";
import type { BuyerRules } from "@nightshift/shared";
import type { RankedAgent } from "./decide.js";
import { verifyQuoteToken } from "./quote-signature.js";

const QuoteResponse = z.object({
  amount: z.string().regex(/^\d+$/),
  asset: z.string().min(1),
  network: z.string().min(1),
  payTo: z.string().regex(/^0\.0\.\d+$/),
  unit: z.string().min(1),
  units: z.number().int().positive(),
  status: z.string().min(1),
  expiresAt: z.string().datetime({ offset: true }),
  issuedAt: z.string().datetime({ offset: true }),
  nonce: z.string().uuid(),
  signedQuote: z.string().min(1),
});

export interface WorkerQuote {
  amount: string;
  asset: string;
  network: string;
  payTo: string;
  unit: string;
  units: number;
  status: string;
  issuedAt: number;
  receivedAt: number;
  expiresAt: number;
  nonce: string;
  signedQuote: string;
  ensName: string;
  expirySource: "server-signed";
}

export async function fetchWorkerQuote(
  config: BuyerPublicConfig,
  label: string,
  units: number,
  options: { fetcher?: typeof fetch; now?: () => number } = {},
): Promise<WorkerQuote> {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const url = new URL(`/a/${encodeURIComponent(label)}/quote`, config.serverUrl);
  url.searchParams.set("units", String(units));
  const response = await fetcher(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`quote returned HTTP ${response.status}`);
  const parsed = QuoteResponse.safeParse(await response.json());
  if (!parsed.success) throw new Error("quote response is malformed");
  const receivedAt = now();
  const claims = verifyQuoteToken(
    parsed.data.signedQuote,
    config.quoteVerifyPublicKey,
    Math.floor(receivedAt / 1000),
  );
  const issuedAt = Date.parse(parsed.data.issuedAt);
  const expiresAt = Date.parse(parsed.data.expiresAt);
  if (
    claims.label !== label ||
    claims.units !== units ||
    claims.amount !== parsed.data.amount ||
    claims.asset !== parsed.data.asset ||
    claims.network !== parsed.data.network ||
    claims.payTo !== parsed.data.payTo ||
    claims.unit !== parsed.data.unit ||
    claims.status !== parsed.data.status ||
    claims.nonce !== parsed.data.nonce ||
    claims.iat * 1000 !== issuedAt ||
    claims.exp * 1000 !== expiresAt
  )
    throw new Error("signed quote fields do not match the quote response");
  return {
    ...parsed.data,
    ensName: claims.ensName,
    issuedAt,
    receivedAt,
    expiresAt,
    expirySource: "server-signed",
  };
}

export function validateQuote(
  quote: WorkerQuote,
  agent: RankedAgent,
  units: number,
  rules: BuyerRules,
  now = Date.now(),
): string | null {
  if (quote.expiresAt <= now) return "quote has expired";
  if (quote.receivedAt < quote.issuedAt - 30_000)
    return "quote was received before its signed issue time";
  if (!/^\d+$/.test(quote.amount) || BigInt(quote.amount) <= 0n) return "quote amount is invalid";
  if (
    quote.signedQuote.length === 0 ||
    quote.expirySource !== "server-signed" ||
    quote.nonce.length === 0
  )
    return "quote signature or nonce is missing";
  if (quote.issuedAt > now + 30_000) return "quote issue time is in the future";
  if (quote.amount !== agent.totalAtomic.toString())
    return `quote ${quote.amount} != ENS price × units ${agent.totalAtomic}`;
  if (quote.payTo !== agent.payTo) return "quote pay-to does not match the verified ENS pay-to";
  if (quote.ensName !== agent.ensName)
    return "quote identity does not match the verified ENS worker";
  if (quote.asset !== agent.price.asset || !rules.allowedAssets.includes(quote.asset))
    return "quote asset does not match ENS or buyer policy";
  if (quote.network !== agent.price.network || !rules.allowedNetworks.includes(quote.network))
    return "quote network does not match ENS or buyer policy";
  if (quote.units !== units || quote.unit !== agent.price.unit)
    return "quote units or unit does not match the verified ENS price";
  if (!["active", "paused_budget"].includes(quote.status))
    return `worker is not runnable (status ${quote.status})`;
  if (quote.expiresAt <= quote.receivedAt) return "quote expiry is not in the future";
  return null;
}
