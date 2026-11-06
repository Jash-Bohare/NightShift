import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("../db/client.js", () => ({ db: { from: mocks.from } }));
vi.mock("../db/queries.js", () => ({ updateJob: vi.fn() }));
vi.mock("../quote-redemptions.js", () => ({
  failQuoteJob: vi.fn(),
  settleQuoteJob: vi.fn(),
}));

import {
  runSettlementRecoveries,
  type SettlementRecovery,
  type SettlementRecoveryStore,
} from "./settlements.js";

const recovery: SettlementRecovery = {
  id: "recovery-1",
  job_id: "job-1",
  desired_status: "settled",
  transaction_id: "0.0.100@1770000000.000000001",
  payer_account: "0.0.200",
  amount_atomic: "30000",
  asset: "0.0.429274",
  attempts: 2,
};

function createStore() {
  const store: SettlementRecoveryStore = {
    due: vi.fn(async () => [recovery]),
    apply: vi.fn(async () => {}),
    resolved: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
  };
  return store;
}

describe("settlement recovery", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reconciles database settlement updates idempotently and resolves the queue row", async () => {
    const store = createStore();
    const result = await runSettlementRecoveries({
      store,
      now: new Date("2030-03-02T00:00:00Z"),
    });
    expect(result).toEqual({ resolved: 1, retried: 0 });
    expect(store.apply).toHaveBeenCalledWith(recovery);
    expect(store.resolved).toHaveBeenCalledWith(recovery);
  });

  it("backs off and persists retry state when reconciliation fails", async () => {
    const store = createStore();
    store.apply = vi.fn(async () => {
      throw new Error("temporary database failure");
    });

    const result = await runSettlementRecoveries({
      store,
      now: new Date("2030-03-02T00:00:00Z"),
    });
    expect(result).toEqual({ resolved: 0, retried: 1 });
    expect(store.retry).toHaveBeenCalledWith(recovery, "2030-03-02T00:04:00.000Z");
    expect(store.resolved).not.toHaveBeenCalled();
  });
});
