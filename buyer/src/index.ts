// Buyer library entry point and CLI delegation
export { runBuyer, type BuyerOptions, type BuyerRunResult, type BuyerTask } from "./agent.js";
export { loadRules, loadState, recordSpend, validateSpend } from "./spending.js";

// When run directly: import CLI
if (process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js")) {
  await import("./cli.js");
}
