import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  calculatePayout,
  payoutDate,
  PayoutTransferError,
  runDailyPayouts,
  type PayoutRecord,
  type PayoutStore,
} from "./payouts.js";

const row: PayoutRecord = {
  id: "payout-1",
  agent_id: "agent-1",
  payout_date: "2026-03-01",
  gross_atomic: "100000",
  owner_atomic: "90000",
  fee_atomic: "10000",
  status: "pending",
  hedera_tx_id: null,
  destination_account: "0.0.200",
};

function createStore(initial: PayoutRecord[] = [row]) {
  const rows = new Map(initial.map((item) => [item.id, { ...item }]));
  const store: PayoutStore = {
    claimEligible: vi.fn(async () =>
      [...rows.values()].filter((item) => item.status === "pending"),
    ),
    listRetryable: vi.fn(async () =>
      [...rows.values()].filter((item) => item.status === "pending" || item.status === "failed"),
    ),
    listSubmitted: vi.fn(async () =>
      [...rows.values()].filter((item) => item.status === "submitted"),
    ),
    claimSubmission: vi.fn(async (id: string) => {
      const item = rows.get(id);
      if (!item || (item.status !== "pending" && item.status !== "failed")) return false;
      item.status = "submitted";
      return true;
    }),
    mark: vi.fn(async (id, status, fields = {}) => {
      const item = rows.get(id);
      if (!item) throw new Error("missing payout");
      item.status = status;
      if (fields.hedera_tx_id) item.hedera_tx_id = fields.hedera_tx_id;
    }),
    sourceFor: vi.fn(async () => ({
      accountId: "0.0.100",
      privateKey: "mock-private-key",
      destinationAccount: "0.0.200",
      grossAtomic: 100_000n,
      ownerAtomic: 90_000n,
      feeAtomic: 10_000n,
    })),
  };
  return { store, rows };
}

describe("daily payout processing", () => {
  it("does not consult the database or submit transfers while payouts are disabled", async () => {
    const result = await runDailyPayouts();
    expect(result).toEqual({ confirmed: 0, failed: 0, uncertain: 0, skipped: 0 });
  });

  it("does not let a sender override bypass the disabled guard without a mocked store", async () => {
    const sender = vi.fn();
    const result = await runDailyPayouts({ sender });
    expect(result).toEqual({ confirmed: 0, failed: 0, uncertain: 0, skipped: 0 });
    expect(sender).not.toHaveBeenCalled();
  });

  beforeEach(() => vi.clearAllMocks());

  it("calculates payout fees with integer atomic units", () => {
    // Default policy is the 90/10 split from docs/01.
    expect(calculatePayout(100_000n)).toEqual({ ownerAtomic: 90_000n, feeAtomic: 10_000n });
    expect(calculatePayout(100_001n, 1_000)).toEqual({
      ownerAtomic: 90_001n,
      feeAtomic: 10_000n,
    });
    expect(calculatePayout(5n, 1_000)).toEqual({ ownerAtomic: 4n, feeAtomic: 1n });
    expect(calculatePayout(1n, 0)).toEqual({ ownerAtomic: 1n, feeAtomic: 0n });
  });

  it("records a successful mocked payout and never sends it twice", async () => {
    const { store, rows } = createStore();
    const sender = vi.fn(async () => ({ transactionId: "0.0.100@1770000000.000000001" }));
    const first = await runDailyPayouts({ store, sender, now: new Date("2026-03-02T00:15:00Z") });
    const second = await runDailyPayouts({ store, sender, now: new Date("2026-03-02T00:15:00Z") });

    expect(first.confirmed).toBe(1);
    expect(second.confirmed).toBe(0);
    expect(sender).toHaveBeenCalledTimes(1);
    expect(rows.get(row.id)?.status).toBe("confirmed");
  });

  it("allows retry only after a definite transfer failure", async () => {
    const { store, rows } = createStore();
    const sender = vi
      .fn()
      .mockRejectedValueOnce(new PayoutTransferError("receipt reverted", false))
      .mockResolvedValueOnce({ transactionId: "0.0.100@1770000000.000000001" });
    const options = { store, sender, now: new Date("2026-03-02T00:15:00Z") };

    expect((await runDailyPayouts(options)).failed).toBe(1);
    expect(rows.get(row.id)?.status).toBe("failed");
    expect((await runDailyPayouts(options)).confirmed).toBe(1);
    expect(sender).toHaveBeenCalledTimes(2);
  });

  it("does not automatically retry an uncertain transfer", async () => {
    const { store, rows } = createStore();
    const sender = vi.fn(async () => {
      throw new PayoutTransferError("network outcome unknown", true);
    });

    expect((await runDailyPayouts({ store, sender })).uncertain).toBe(1);
    expect((await runDailyPayouts({ store, sender })).confirmed).toBe(0);
    expect(sender).toHaveBeenCalledTimes(1);
    expect(rows.get(row.id)?.status).toBe("uncertain");
  });

  it("marks interrupted submissions uncertain instead of resending", async () => {
    const interrupted = { ...row, status: "submitted" as const };
    const { store, rows } = createStore([interrupted]);
    const sender = vi.fn();

    const result = await runDailyPayouts({ store, sender });
    expect(result.uncertain).toBe(1);
    expect(sender).not.toHaveBeenCalled();
    expect(rows.get(row.id)?.status).toBe("uncertain");
  });

  it("does not make a confirmed transfer retryable when recording confirmation fails", async () => {
    const { store, rows } = createStore();
    const mark = store.mark;
    store.mark = vi.fn(async (id, status, fields) => {
      if (status === "confirmed") throw new Error("database unavailable");
      return mark(id, status, fields);
    });
    const sender = vi.fn(async () => ({ transactionId: "0.0.100@1770000000.000000001" }));

    expect((await runDailyPayouts({ store, sender })).uncertain).toBe(1);
    expect(rows.get(row.id)?.status).toBe("uncertain");
    expect((await runDailyPayouts({ store, sender })).confirmed).toBe(0);
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it("prevents concurrent processors from claiming the same payout", async () => {
    const { store } = createStore();
    const sender = vi.fn(async () => ({ transactionId: "0.0.100@1770000000.000000001" }));

    await Promise.all([runDailyPayouts({ store, sender }), runDailyPayouts({ store, sender })]);

    expect(sender).toHaveBeenCalledTimes(1);
  });

  it("announces only confirmed payouts, and an announcement failure changes nothing", async () => {
    const { store, rows } = createStore();
    const sender = vi.fn(async () => ({ transactionId: "0.0.100@1770000000.000000001" }));
    const announce = vi.fn(async () => {
      throw new Error("HCS down");
    });
    const result = await runDailyPayouts({ store, sender, announce });
    expect(result.confirmed).toBe(1);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(
      expect.objectContaining({ id: row.id }),
      "0.0.100@1770000000.000000001",
    );
    expect(rows.get(row.id)?.status).toBe("confirmed");

    const failing = createStore();
    const announce2 = vi.fn(async () => {});
    await runDailyPayouts({
      store: failing.store,
      sender: vi.fn(async () => {
        throw new PayoutTransferError("receipt reverted", false);
      }),
      announce: announce2,
    });
    expect(announce2).not.toHaveBeenCalled();
  });

  it("dates batches by UTC day, or the next midnight when paying through now", () => {
    const evening = new Date("2026-11-06T21:30:00Z");
    expect(payoutDate(evening)).toBe("2026-11-06");
    expect(payoutDate(evening, true)).toBe("2026-11-07");
    expect(payoutDate(new Date("2026-12-31T23:59:59Z"), true)).toBe("2027-01-01");
  });

  it("claims with the through-now date on a manual run", async () => {
    const { store } = createStore();
    const sender = vi.fn(async () => ({ transactionId: "0.0.100@1770000000.000000001" }));
    await runDailyPayouts({
      store,
      sender,
      manual: true,
      throughNow: true,
      now: new Date("2026-11-06T21:30:00Z"),
    });
    expect(store.claimEligible).toHaveBeenCalledWith("2026-11-07");
  });
});
