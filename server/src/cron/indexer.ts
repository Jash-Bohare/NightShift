// Indexer cron (runs every 30 s): syncs new registrations & record changes from Sepolia to directory.
import { runIndexer } from "../ens/indexer.js";
import { log, logError } from "../log.js";

let running = false;

export async function runIndexerCron(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const res = await runIndexer();
    if (res.indexed > 0) {
      log("cron", `indexer synced ${res.indexed} agent(s)`, {
        labels: res.labels,
        lastBlock: res.toBlock.toString(),
      });
    }
  } catch (err) {
    logError("cron", "indexer error", err);
  } finally {
    running = false;
  }
}
