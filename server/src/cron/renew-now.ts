// Manual renew run (roadmap P5.2). Without --yes it only lists what the cron would do.
//   pnpm -C server renew          # dry: list renewals and lapsed names
//   pnpm -C server renew --yes    # renew on Sepolia (operator gas) and mark lapsed names expired
import { db } from "../db/client.js";
import type { AgentRow } from "../db/types.js";
import { ACTIVITY_WINDOW_MS, runRenewals, selectLapsed, selectRenewals } from "./renew.js";

const now = new Date();
if (!process.argv.includes("--yes")) {
  const agents = await db.from("agents").select("id,label,status,expiry");
  const jobs = await db
    .from("jobs")
    .select("agent_id")
    .eq("status", "settled")
    .gte("created_at", new Date(now.getTime() - ACTIVITY_WINDOW_MS).toISOString());
  if (agents.error || jobs.error) throw new Error(agents.error?.message ?? jobs.error?.message);
  const rows = (agents.data ?? []) as Pick<AgentRow, "id" | "label" | "status" | "expiry">[];
  const active = new Set(((jobs.data ?? []) as { agent_id: string }[]).map((j) => j.agent_id));
  for (const a of rows)
    console.log(`[renew] ${a.label.padEnd(24)} ${a.status.padEnd(14)} expires ${a.expiry ?? "?"}`);
  console.log(
    "[renew] would renew:",
    selectRenewals(rows, active, now.getTime()).map((a) => a.label),
  );
  console.log(
    "[renew] would mark expired:",
    selectLapsed(rows, now.getTime()).map((a) => a.label),
  );
  console.log("[renew] dry stop: re-run with --yes to send Sepolia transactions.");
  process.exit(0);
}
const result = await runRenewals(now);
console.log("[renew] result", result);
setTimeout(() => process.exit(result.failed.length ? 1 : 0), 1_000).unref();
