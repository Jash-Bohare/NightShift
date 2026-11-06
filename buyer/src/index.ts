// Buyer library entry point. Side-effect free: importing it never runs the CLI (that is src/cli.ts).
export {
  hashscanTxUrl,
  runBuyer,
  type BuyerDependencies,
  type BuyerOptions,
  type BuyerRunResult,
  type BuyerTask,
} from "./agent.js";
export {
  DEFAULT_SAMPLE_FILE,
  loadBuyerConfig,
  loadBuyerPublicConfig,
  type BuyerConfig,
  type BuyerPublicConfig,
} from "./config.js";
export { runPreflight, type PreflightReport, type PreflightCheck } from "./preflight.js";
export {
  loadRules,
  loadState,
  recordCompletedJob,
  recordSpend,
  validateRules,
  validateSpend,
} from "./spending.js";
export type { BuyerExecutionReport, PaymentState } from "./report.js";
export {
  createEnsReader,
  discoverDirectory,
  validateWorkerEndpoint,
  type EnsReader,
  verifyDirectoryCandidates,
} from "./discovery.js";
export { fetchWorkerQuote, validateQuote } from "./quote.js";
export { createX402Fetch, paymentReadinessError } from "./payment.js";
export { executePaidJob, type PaidJobResponse } from "./execution.js";
export {
  HederaMirrorClient,
  transactionIdForMirror,
  verifyTransactionTransfers,
} from "./hedera.js";
export { verifyHcsJob, verifyPublicJob, verifySettlement } from "./settlement.js";
