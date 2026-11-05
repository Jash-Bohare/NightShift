// P2.7 manual trigger for the reputation batch (same code as the 10-minute cron).
// Run: pnpm -C scripts exec tsx reputation-now.ts
export {};
const { runReputationBatch } = await import("@nightshift/server/cron");

for (const o of await runReputationBatch()) {
  console.log(`[ens] ${o.label}: ${o.written ? `wrote ${o.json} ${o.tx}` : `unchanged ${o.json}`}`);
}
process.exit(0);
