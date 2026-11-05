// P2.4 end-to-end check: quote, then pay an agent's /run via x402 (USDC, Hedera testnet) from the
// buyer account and print the transcript, job id, 0G request id and HashScan link.
// Run (server on :8787): pnpm -C scripts exec tsx pay-run.ts [label] [file] [units]
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { createClientHederaSigner, HEDERA_TESTNET_USDC, PrivateKey } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { need } from "./env.js";
import { hashscan, tokenBalance, txIdForUrl } from "./hedera-util.js";

const label = process.argv[2] ?? "tamil-scribe";
const file =
  process.argv[3] ?? fileURLToPath(new URL("../buyer/samples/tamil-90s.mp3", import.meta.url));
const units = process.argv[4] ?? "2";
const SERVER = need("BUYER_SERVER_URL");
const BUYER = need("BUYER_HEDERA_ACCOUNT_ID");

const signer = createClientHederaSigner(
  BUYER,
  PrivateKey.fromStringECDSA(need("BUYER_HEDERA_PRIVATE_KEY")),
  {
    network: "hedera:testnet",
  },
);
const payFetch = wrapFetchWithPayment(
  fetch,
  new x402Client()
    .register("hedera:*", new ExactHederaScheme(signer))
    .setSpendControls({ maxAmountPerPayment: "$0.10" }),
);

const usdc = (v: bigint | null) => (v === null ? "n/a" : `${v} atomic`);

async function main() {
  const quote = await (await fetch(`${SERVER}/a/${label}/quote?units=${units}`)).json();
  console.log(`[x402] quote ${JSON.stringify(quote)}`);
  const payTo = (quote as { payTo: string }).payTo;
  const [b0, s0] = await Promise.all([
    tokenBalance(BUYER, HEDERA_TESTNET_USDC),
    tokenBalance(payTo, HEDERA_TESTNET_USDC),
  ]);
  console.log(`[x402] before: buyer ${usdc(b0)} | agent ${payTo} ${usdc(s0)}`);

  const form = new FormData();
  form.append("file", new Blob([readFileSync(file)], { type: "audio/mpeg" }), basename(file));
  const t0 = performance.now();
  const res = await payFetch(`${SERVER}/a/${label}/run`, {
    method: "POST",
    headers: { "X-Nightshift-Units": units },
    body: form,
    signal: AbortSignal.timeout(240_000),
  });
  const body = await res.text();
  console.log(
    `[x402] /run -> ${res.status} in ${Math.round(performance.now() - t0)} ms, job ${res.headers.get("X-Nightshift-Job")}`,
  );
  console.log(`[x402] body ${body.slice(0, 600)}`);
  const header = res.headers.get("PAYMENT-RESPONSE");
  if (header) {
    const settle = decodePaymentResponseHeader(header);
    console.log(`[x402] settled ${JSON.stringify(settle)}`);
    console.log(`[x402] HashScan ${hashscan("transaction", txIdForUrl(settle.transaction))}`);
  } else console.log("[x402] no PAYMENT-RESPONSE (not settled)");

  await new Promise((r) => setTimeout(r, 6_000)); // mirror node lag
  const [b1, s1] = await Promise.all([
    tokenBalance(BUYER, HEDERA_TESTNET_USDC),
    tokenBalance(payTo, HEDERA_TESTNET_USDC),
  ]);
  console.log(`[x402] after:  buyer ${usdc(b1)} | agent ${payTo} ${usdc(s1)}`);
}

main().catch((err) => {
  console.error("[x402] pay-run failed:", err);
  process.exit(1);
});
