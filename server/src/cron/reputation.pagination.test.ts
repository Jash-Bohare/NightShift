import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pages: [] as { status: string; latency_ms: number | null }[][],
  error: null as { message: string } | null,
  from: vi.fn(),
}));

vi.mock("../db/client.js", () => ({ db: { from: mocks.from } }));
vi.mock("../ens/registrar.js", () => ({
  sepoliaClient: { getEnsText: vi.fn() },
  setReputation: vi.fn(),
  etherscanTx: vi.fn(),
}));

import { UpstreamError } from "../errors.js";
import { loadAgentReputationJobs } from "./reputation.js";

describe("reputation job pagination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pages = [];
    mocks.error = null;
    mocks.from.mockImplementation(() => {
      const query = {
        select: () => query,
        eq: () => query,
        order: () => query,
        range: async () => {
          if (mocks.error) return { data: null, error: mocks.error };
          return { data: mocks.pages.shift() ?? [], error: null };
        },
      };
      return query;
    });
  });

  it("reads every page in stable order", async () => {
    mocks.pages = [
      [
        { status: "settled", latency_ms: 10 },
        { status: "failed_internal", latency_ms: 20 },
      ],
      [{ status: "settled", latency_ms: 30 }],
    ];

    await expect(loadAgentReputationJobs("agent-1", 2)).resolves.toEqual([
      { status: "settled", latency_ms: 10 },
      { status: "failed_internal", latency_ms: 20 },
      { status: "settled", latency_ms: 30 },
    ]);
  });

  it("surfaces database errors instead of returning partial reputation inputs", async () => {
    mocks.error = { message: "database offline" };
    await expect(loadAgentReputationJobs("agent-1", 2)).rejects.toBeInstanceOf(UpstreamError);
  });
});
