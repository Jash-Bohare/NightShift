// Scheduled-job registration. Nothing is scheduled unless CRONS_ENABLED=true; payouts additionally
// require PAYOUTS_ENABLED=true (config rejects PAYOUTS_ENABLED without CRONS_ENABLED).
import { log, logError } from "../log.js";

export interface CronJobs {
  indexer: () => Promise<void>;
  reputation: () => Promise<unknown>;
  settlementRecovery: () => Promise<unknown>;
  payouts: () => Promise<unknown>;
  renewals: () => Promise<unknown>;
}

export type Scheduler = (
  expression: string,
  task: () => void,
  options: { timezone: string },
) => void;

export interface ScheduleStatus {
  cronsEnabled: boolean;
  payoutsEnabled: boolean;
  scheduled: string[];
}

export function scheduleCrons(
  flags: { cronsEnabled: boolean; payoutsEnabled: boolean },
  jobs: CronJobs,
  schedule: Scheduler,
): ScheduleStatus {
  const scheduled: string[] = [];
  if (!flags.cronsEnabled) {
    log(
      "cron",
      "scheduled jobs disabled (CRONS_ENABLED=false); no indexer, reputation, recovery or payout runs",
    );
    return { cronsEnabled: false, payoutsEnabled: false, scheduled };
  }
  const register = (name: string, expression: string, run: () => Promise<unknown>) => {
    schedule(expression, () => void run().catch((e: unknown) => logError("cron", name, e)), {
      timezone: "UTC",
    });
    scheduled.push(name);
  };
  register("indexer", "*/30 * * * * *", jobs.indexer);
  register("reputation", "*/10 * * * *", jobs.reputation);
  register("settlement-recovery", "* * * * *", jobs.settlementRecovery);
  register("renewals", "0 1 * * *", jobs.renewals);
  if (flags.payoutsEnabled) register("payouts", "15 0 * * *", jobs.payouts);
  log("cron", "scheduled jobs enabled", {
    jobs: scheduled.join(","),
    payouts: flags.payoutsEnabled ? "enabled" : "disabled",
  });
  return { cronsEnabled: true, payoutsEnabled: flags.payoutsEnabled, scheduled };
}
