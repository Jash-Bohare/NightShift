// P0.4 spike client: pays the spike server via x402 from the buyer account.
// Run: pnpm -C scripts exec tsx spikes/x402-client.ts [/paid | /paid-fail]
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { createClientHederaSigner, HEDERA_TESTNET_USDC, PrivateKey } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { need } from "../env.js";
import { hashscan, tokenBalance, txIdForUrl } from "../hedera-util.js";

const path = process.argv[2] ?? "/paid";
const BUYER = need("BUYER_HEDERA_ACCOUNT_ID");
const SELLER = need("SPIKE_SELLER_ACCOUNT_ID");

const signer = createClientHederaSigner(
  BUYER,
  PrivateKey.fromStringECDSA(need("BUYER_HEDERA_PRIVATE_KEY")),
  {
    network: "hedera:testnet",
  },
);
const client = new x402Client()
  .register("hedera:*", new ExactHederaScheme(signer))
  .setSpendControls({ maxAmountPerPayment: "$0.05" });
const payFetch = wrapFetchWithPayment(fetch, client);

const fmt = (v: bigint | null) => (v === null ? "not associated" : `${Number(v) / 1e6} USDC`);

async function balances(label: string) {
  const [b, s] = await Promise.all([
    tokenBalance(BUYER, HEDERA_TESTNET_USDC),
    tokenBalance(SELLER, HEDERA_TESTNET_USDC),
  ]);
  console.log(`[x402] ${label}: buyer ${BUYER} ${fmt(b)} | seller ${SELLER} ${fmt(s)}`);
}

async function main() {
  await balances("before");
  const res = await payFetch(`http://localhost:4021${path}`, {
    signal: AbortSignal.timeout(180_000),
  });
  console.log(`[x402] ${path} -> ${res.status} ${await res.text()}`);

  const header = res.headers.get("PAYMENT-RESPONSE");
  if (header) {
    const settle = decodePaymentResponseHeader(header);
    console.log(`[x402] PAYMENT-RESPONSE ${JSON.stringify(settle)}`);
    console.log(`[x402] HashScan: ${hashscan("transaction", txIdForUrl(settle.transaction))}`);
  } else {
    console.log("[x402] no PAYMENT-RESPONSE header (not settled)");
  }

  // Mirror node lags consensus by a few seconds.
  await new Promise((r) => setTimeout(r, 6_000));
  await balances("after");
}

main().catch((err) => {
  console.error("[x402] client failed:", err);
  process.exit(1);
});
