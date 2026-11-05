// P0.4 spike server: two USDC-priced routes on Hedera testnet.
//   GET /paid       handler succeeds -> expect settle + PAYMENT-RESPONSE
//   GET /paid-fail  handler returns 502 -> expect NO settle (buyer not charged)
// Run: pnpm -C scripts exec tsx spikes/x402-server.ts
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { need } from "../env.js";

const PORT = 4021;
const FACILITATOR = need("X402_FACILITATOR_URL");
const PAY_TO = need("SPIKE_SELLER_ACCOUNT_ID");
const t = () => new Date().toISOString().slice(11, 23);

// No defaultAssets override: testnet USDC 0.0.429274 is the package default, so "$0.01" -> 10000 units.
const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR }))
  .register("hedera:testnet", new ExactHederaScheme())
  .onAfterVerify(async (ctx) => {
    console.log(
      `${t()} [x402] verified payer=${ctx.result.payer} amount=${ctx.requirements.amount} asset=${ctx.requirements.asset}`,
    );
  })
  .onAfterSettle(async (ctx) => {
    console.log(`${t()} [x402] settled tx=${ctx.result.transaction} success=${ctx.result.success}`);
  })
  .onSettleFailure(async (ctx) => {
    console.log(`${t()} [x402] settle FAILED: ${ctx.error.message}`);
  })
  .onVerifiedPaymentCanceled(async (ctx) => {
    console.log(
      `${t()} [x402] settlement cancelled reason=${ctx.reason} status=${ctx.responseStatus}`,
    );
  });

const accepts = {
  scheme: "exact",
  network: "hedera:testnet",
  payTo: PAY_TO,
  price: "$0.01",
  maxTimeoutSeconds: 180,
} as const;

const app = express();
app.use(
  paymentMiddleware(
    {
      "GET /paid": { accepts: [accepts], description: "Nightshift x402 spike" },
      "GET /paid-fail": {
        accepts: [accepts],
        description: "Nightshift x402 spike (failing handler)",
      },
    },
    resourceServer,
  ),
);

app.get("/paid", (_req, res) => {
  console.log(`${t()} [x402] handler /paid ran`);
  res.json({ ok: true, work: "pretend transcript" });
});

app.get("/paid-fail", (_req, res) => {
  console.log(`${t()} [x402] handler /paid-fail ran -> 502`);
  res.status(502).json({ error: "zg_unavailable" });
});

app.listen(PORT, () =>
  console.log(`[x402] spike server on :${PORT}, facilitator ${FACILITATOR}, payTo ${PAY_TO}`),
);
