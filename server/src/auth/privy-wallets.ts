// Ethereum wallets linked to a Privy user, read server-side from the Privy API. The launch route
// uses this so the ENS owner address is never taken on the browser's word alone.
import { PrivyClient } from "@privy-io/node";
import { getAddress, isAddress, type Address } from "viem";
import { env } from "../config.js";
import { ApiError, UpstreamError, withTimeout } from "../errors.js";

let client: PrivyClient | undefined;

function privy(): PrivyClient {
  if (!env.PRIVY_APP_ID || !env.PRIVY_APP_SECRET)
    throw new ApiError(503, "feature_disabled", "Privy authorization is not configured");
  client ??= new PrivyClient({ appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET });
  return client;
}

/** Checksummed addresses of the user's linked Ethereum wallets (embedded and external). */
export function ethereumWalletsFrom(linkedAccounts: readonly unknown[]): Address[] {
  const out: Address[] = [];
  for (const account of linkedAccounts) {
    if (typeof account !== "object" || account === null) continue;
    const a = account as { type?: unknown; chain_type?: unknown; address?: unknown };
    if (a.type !== "wallet" || a.chain_type !== "ethereum" || typeof a.address !== "string")
      continue;
    if (isAddress(a.address, { strict: false })) out.push(getAddress(a.address));
  }
  return [...new Set(out)];
}

export async function linkedEthereumWallets(privyUserId: string): Promise<Address[]> {
  try {
    const user = await withTimeout(
      "privy",
      "privy user lookup",
      10_000,
      privy().users()._get(privyUserId),
    );
    return ethereumWalletsFrom(user.linked_accounts);
  } catch (error) {
    if (error instanceof ApiError || error instanceof UpstreamError) throw error;
    throw new UpstreamError(
      "privy",
      `privy user lookup: ${error instanceof Error ? error.message : "request failed"}`,
    );
  }
}
