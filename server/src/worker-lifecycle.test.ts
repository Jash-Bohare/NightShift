import { describe, expect, it, vi } from "vitest";
import type { AgentRow } from "./db/types.js";
import { assertWorkerRunnable } from "./worker-lifecycle.js";

const agent = {
  id: "50baf702-1284-4d60-8ce6-39b905598d98",
  label: "worker",
  status: "active",
  expiry: "2030-01-01T00:00:00.000Z",
} as AgentRow;

describe("worker execution lifecycle guard", () => {
  it("allows only registered, unexpired workers", async () => {
    const reader = { status: vi.fn(async () => 2), expiry: vi.fn(async () => 1_900_000_000n) };
    await expect(assertWorkerRunnable(agent, reader, 1_800_000_000n)).resolves.toBeUndefined();
  });

  it("rejects database and on-chain expiry, revocation, and unavailable states", async () => {
    const reader = { status: vi.fn(async () => 2), expiry: vi.fn(async () => 1_700_000_000n) };
    await expect(assertWorkerRunnable(agent, reader, 1_800_000_000n)).rejects.toThrow(
      /expired on Sepolia/,
    );
    await expect(
      assertWorkerRunnable({ ...agent, expiry: "2020-01-01T00:00:00Z" }, reader, 1_800_000_000n),
    ).rejects.toThrow(/expired/);
    await expect(
      assertWorkerRunnable(agent, { ...reader, status: async () => 3 }, 1_800_000_000n),
    ).rejects.toThrow(/not registered/);
    await expect(
      assertWorkerRunnable({ ...agent, status: "revoked" }, reader, 1_800_000_000n),
    ).rejects.toThrow(/revoked/);
  });
});
