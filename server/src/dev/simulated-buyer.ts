// SIMULATED BUYER RUN against the simulated stack (pnpm -C server dev:simulated must be running).
// Real: directory discovery, ENS/registry verification on live Sepolia (read-only), signed quote
// checks, spending rules, x402 client + payment policy, execution, digest and job-status checks.
// Simulated: the payment payload (non-signing scheme), USDC balance and Mirror Node confirmation.
// No Hedera transaction is created and no wallet key is read.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SAMPLE_FILE,
  createX402Fetch,
  loadBuyerConfig,
  runBuyer,
  verifySettlement,
} from "@nightshift/buyer";
import { SIMULATED_TX_PREFIX, simulatedPaymentScheme } from "../e2e/harness.js";
import { STACK_INFO_PATH } from "./stack-info.js";

let info: { serverUrl: string; quoteVerifyPublicKey: string; sepoliaRpcUrl: string };
try {
  info = JSON.parse(readFileSync(STACK_INFO_PATH, "utf8")) as typeof info;
} catch {
  console.error("Start the simulated stack first: pnpm -C server dev:simulated");
  process.exit(2);
}

const simulatedMirror = {
  verifyPayment: async (expected: { transactionId: string }) => ({
    verified: expected.transactionId.startsWith(SIMULATED_TX_PREFIX),
    transactionId: expected.transactionId,
    reason: "SIMULATED mirror confirmation (no Hedera lookup)",
  }),
};

const config = loadBuyerConfig({
  serverUrl: info.serverUrl,
  quoteVerifyPublicKey: info.quoteVerifyPublicKey,
  sepoliaRpcUrl: info.sepoliaRpcUrl,
  mirrorUrl: "http://127.0.0.1:9/simulated-mirror",
  buyerAccountId: "0.0.7000001",
  buyerPrivateKey: "1".repeat(64), // placeholder; the simulated scheme never signs
});
// HCS is not submitted by the simulated stack, so the HCS check is reported as not configured.
delete (config as { hcsTopicId?: string }).hcsTopicId;

let spent = 0n;
console.log("=== SIMULATED BUYER RUN — no real payment ===");
const result = await runBuyer(
  { skill: "transcribe:ta", file: process.argv[2] ?? DEFAULT_SAMPLE_FILE },
  {
    config,
    executionLockPath: join(mkdtempSync(join(tmpdir(), "ns-sim-buyer-")), "buyer.lock"),
    onEvent: (event) => console.log(`[${event.kind}]`, JSON.stringify(event).slice(0, 220)),
    dependencies: {
      usdcBalance: async () => 10_000_000n,
      createPaymentFetch: (c, rules, expected) =>
        createX402Fetch(c, rules, expected, simulatedPaymentScheme),
      verifyPayment: (_c, expected) => simulatedMirror.verifyPayment(expected),
      verifySettlement: (c, expected) =>
        verifySettlement(c, expected, { mirror: simulatedMirror as never }),
      dailySpentAtomic: () => spent,
      recordSpend: (amount) => {
        spent += amount;
      },
      recordCompletedJob: () => {},
    },
  },
);
console.log("\n=== RESULT (SIMULATED PAYMENT) ===");
console.log(
  JSON.stringify(
    {
      success: result.success,
      chosenAgent: result.chosenAgent,
      jobId: result.jobId,
      simulatedSettlementId: result.txId,
      jobVerified: result.jobVerified,
      paymentConfirmed: `${result.paymentConfirmed} (SIMULATED mirror)`,
      settlementVerified: result.settlementVerified,
      error: result.error,
    },
    null,
    2,
  ),
);
process.exit(result.success ? 0 : 1);
