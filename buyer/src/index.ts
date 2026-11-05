// Buyer library entry point. Side-effect free: importing it never runs the CLI (that is src/cli.ts).
export {
  hashscanTxUrl,
  runBuyer,
  type BuyerOptions,
  type BuyerRunResult,
  type BuyerTask,
} from "./agent.js";
export { DEFAULT_SAMPLE_FILE, loadBuyerConfig, type BuyerConfig } from "./config.js";
export { loadRules, loadState, recordSpend, validateSpend } from "./spending.js";
