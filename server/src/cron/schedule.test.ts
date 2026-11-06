import { describe, expect, it, vi } from "vitest";
import { scheduleCrons, type CronJobs } from "./schedule.js";

const jobs = () => {
  const j = {
    indexer: vi.fn(async (): Promise<void> => {}),
    reputation: vi.fn(async (): Promise<unknown> => undefined),
    settlementRecovery: vi.fn(async (): Promise<unknown> => undefined),
    payouts: vi.fn(async (): Promise<unknown> => undefined),
    renewals: vi.fn(async (): Promise<unknown> => undefined),
  };
  return j satisfies CronJobs;
};

describe("scheduled jobs", () => {
  it("registers and runs nothing when CRONS_ENABLED is false (even if payouts are requested)", () => {
    const schedule = vi.fn();
    const j = jobs();
    const status = scheduleCrons({ cronsEnabled: false, payoutsEnabled: true }, j, schedule);
    expect(schedule).not.toHaveBeenCalled();
    expect(status).toEqual({ cronsEnabled: false, payoutsEnabled: false, scheduled: [] });
    for (const fn of Object.values(j)) expect(fn).not.toHaveBeenCalled();
  });

  it("registers payouts only when both flags are explicitly enabled", () => {
    const schedule = vi.fn();
    expect(
      scheduleCrons({ cronsEnabled: true, payoutsEnabled: false }, jobs(), schedule).scheduled,
    ).toEqual(["indexer", "reputation", "settlement-recovery", "renewals"]);
    const withPayouts = scheduleCrons(
      { cronsEnabled: true, payoutsEnabled: true },
      jobs(),
      vi.fn(),
    );
    expect(withPayouts.scheduled).toContain("payouts");
  });

  it("scheduled tasks run in UTC and swallow job errors into logs", async () => {
    const tasks: (() => void)[] = [];
    const j = jobs();
    j.reputation.mockRejectedValueOnce(new Error("boom"));
    scheduleCrons({ cronsEnabled: true, payoutsEnabled: false }, j, (_expr, task, options) => {
      expect(options.timezone).toBe("UTC");
      tasks.push(task);
    });
    for (const task of tasks) task();
    await Promise.resolve();
    expect(j.reputation).toHaveBeenCalledTimes(1);
    expect(j.payouts).not.toHaveBeenCalled();
  });
});
