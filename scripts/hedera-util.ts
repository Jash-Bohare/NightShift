// Small Hedera helpers shared by spikes: HashScan links and mirror-node reads.
import { need } from "./env.js";

export const hashscan = (kind: "transaction" | "account" | "topic", id: string) =>
  `https://hashscan.io/testnet/${kind}/${id}`;

// SDK ids look like 0.0.1@1700000000.123456789; mirror/HashScan use 0.0.1-1700000000-123456789.
export const txIdForUrl = (txId: string) => txId.replace("@", "-").replace(/\.(\d+)$/, "-$1");

export async function mirror<T>(path: string): Promise<T> {
  const res = await fetch(`${need("HEDERA_MIRROR_URL")}/api/v1${path}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`[hedera] mirror ${path} -> ${res.status}`);
  return (await res.json()) as T;
}

export async function mirrorRetry<T>(path: string, tries = 10): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await mirror<T>(path);
    } catch (err) {
      if (i >= tries) throw err;
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
}

// Token balance in smallest units, or null when the account isn't associated.
export async function tokenBalance(accountId: string, tokenId: string): Promise<bigint | null> {
  const { tokens } = await mirror<{ tokens: { token_id: string; balance: number }[] }>(
    `/accounts/${accountId}/tokens?token.id=${tokenId}`,
  );
  const entry = tokens.find((t) => t.token_id === tokenId);
  return entry ? BigInt(entry.balance) : null;
}
