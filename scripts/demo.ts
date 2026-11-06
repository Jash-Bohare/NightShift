import { createHash } from "node:crypto";

const worker = "demo-transcriber.nightshift.eth";
const units = 2;
const unitPriceAtomic = 30_000n;
const quoteAmountAtomic = unitPriceAtomic * BigInt(units);
const simulatedOutput = "This transcript is a deterministic demo fixture, not provider output.";
const digest = createHash("sha256").update(simulatedOutput, "utf8").digest("hex");
const payoutGross = 120_000n;
const payoutFee = 0n;

console.log("NIGHTSHIFT DETERMINISTIC DEMO - SIMULATED ONLY");
console.log("No RPC, Supabase, facilitator, wallet, 0G, HCS, or transaction was called.\n");
console.log(`[SIMULATED] DISCOVER worker=${worker} skill=transcribe:ta`);
console.log(`[SIMULATED] ENS identity verified=true (fixture; not a chain read)`);
console.log(
  `[SIMULATED] QUOTE units=${units} amount=${quoteAmountAtomic} USDC atomic expires=2030-01-01T00:02:00Z`,
);
console.log("[SIMULATED] x402 challenge and payment acceptance (no signature or transfer)");
console.log(`[SIMULATED] JOB complete output_sha256=${digest}`);
console.log("[SIMULATED] HEDERA receipt=SUCCESS; HCS evidence=present (fixtures, not proofs)");
console.log(
  `[SIMULATED] PAYOUT gross=${payoutGross} fee=${payoutFee} owner=${payoutGross - payoutFee} atomic; no payout batch created`,
);
