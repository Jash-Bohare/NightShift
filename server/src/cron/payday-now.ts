// Manual payday trigger (roadmap P5.1, for the demo video). Moves real test USDC on Hedera:
// 90% of each worker's settled, unpaid earnings to its owner's payout account, 10% to the
// treasury, then logs each payout to HCS. Idempotent: jobs are claimed into one payout batch per
// worker per date, and uncertain transfers are never resent.
//
//   pnpm -C server payday --yes                 # jobs settled before today's 00:00 UTC
//   pnpm -C server payday --yes --through-now   # also include jobs settled today
import { env } from "../config.js";
import { PAYOUT_FEE_BPS, payoutDate, runDailyPayouts } from "./payouts.js";

const args = new Set(process.argv.slice(2));
const throughNow = args.has("--through-now");
const date = payoutDate(new Date(), throughNow);

console.log(`[payday] batch date ${date} (jobs settled before ${date}T00:00:00Z)`);
console.log(
  `[payday] split ${100 - PAYOUT_FEE_BPS / 100}% owner / ${PAYOUT_FEE_BPS / 100}% treasury ${env.TREASURY_ACCOUNT_ID}; USDC ${env.HEDERA_USDC_TOKEN_ID}`,
);
if (!args.has("--yes")) {
  console.log("[payday] dry stop: re-run with --yes to send transfers.");
  process.exit(0);
}
const result = await runDailyPayouts({ manual: true, throughNow });
console.log("[payday] result", result);
// Leave the process to the SDK/db clients' own shutdown, but never hang a terminal.
setTimeout(() => process.exit(result.failed || result.uncertain ? 1 : 0), 1_000).unref();
