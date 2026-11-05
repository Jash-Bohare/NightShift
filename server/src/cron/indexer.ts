// Indexer cron (every 30 s). Overlapping runs are skipped.
import { runIndexer } from "../ens/indexer.js";
import { logError } from "../log.js";

let running = false;

export async function runIndexerCron(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await runIndexer();
  } catch (err) {
    logError("cron", "indexer run failed", err);
  } finally {
    running = false;
  }
}
