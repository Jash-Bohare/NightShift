import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type ErrorRequestHandler } from "express";
import type { AddressInfo } from "node:net";

const mocks = vi.hoisted(() => {
  return {
    publicKey: "",
    privateKey: "",
    maybeSingle: vi.fn(),
    from: vi.fn(),
  };
});

vi.mock("../config.js", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const pair = generateKeyPairSync("ed25519");
  mocks.publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  mocks.privateKey = pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  return {
    env: {
      NIGHTSHIFT_QUOTE_VERIFY_PUBLIC_KEY: mocks.publicKey,
      HEDERA_USDC_TOKEN_ID: "0.0.429274",
    },
  };
});
vi.mock("../db/client.js", () => ({
  db: {
    from: mocks.from,
  },
}));

import { createJobStatusToken } from "../quote-signing.js";
import { parseStatusCapability, safeJobStatus, jobsRouter } from "./jobs.js";
import { ApiError } from "../errors.js";

const jobId = "50baf702-1284-4d60-8ce6-39b905598d98";
const app = express();
app.use(jobsRouter);
const onError: ErrorRequestHandler = (error, _req, res, next) => {
  if (!(error instanceof ApiError)) return next(error);
  res.status(error.status).json(error.toJSON());
};
app.use(onError);
let server: ReturnType<typeof app.listen>;
let baseUrl = "";

beforeAll(() => {
  server = app.listen(0);
  baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe("restricted job status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.from.mockReturnValue({
      select: () => ({ eq: () => ({ maybeSingle: mocks.maybeSingle }) }),
    });
  });

  it("rejects malformed ids and missing or mismatched capabilities", () => {
    expect(() => parseStatusCapability("not-a-uuid", undefined)).toThrow(/UUID/);
    expect(() => parseStatusCapability(jobId, undefined)).toThrow(/capability is required/);
    const otherJobToken = createJobStatusToken(
      "77d434ed-8a69-4f2c-9e90-f0e9ce76c028",
      mocks.privateKey,
    );
    expect(() => parseStatusCapability(jobId, `Bearer ${otherJobToken}`)).toThrow(/invalid/);
  });

  it("returns no record for unknown ids", () => {
    expect(safeJobStatus(jobId, null)).toBeNull();
  });

  it("enforces API access boundaries for malformed, unauthorized, and unknown jobs", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: null, error: null });
    const malformed = await fetch(`${baseUrl}/jobs/not-a-uuid/status`);
    const unauthorized = await fetch(`${baseUrl}/jobs/${jobId}/status`);
    const token = createJobStatusToken(jobId, mocks.privateKey);
    const unknown = await fetch(`${baseUrl}/jobs/${jobId}/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(malformed.status).toBe(422);
    expect(unauthorized.status).toBe(401);
    expect(unknown.status).toBe(404);
  });

  it("returns only allow-listed fields for a valid capability and job", () => {
    const token = createJobStatusToken(jobId, mocks.privateKey);
    expect(parseStatusCapability(jobId, `Bearer ${token}`)).toBe(jobId);
    const result = safeJobStatus(jobId, {
      id: jobId,
      status: "settled",
      units: "1",
      price_atomic: "30000",
      hedera_tx_id: "0.0.100@123456789.000000001",
      hcs_sequence: "19",
      output_sha256: "a".repeat(64),
      created_at: "2025-01-01T00:00:00.000Z",
      agents: { label: "worker", ens_name: "worker.nightshift.eth" },
      buyer_account: "private",
      error: "private",
      output: "private",
      input: "private",
    });
    expect(result).toMatchObject({
      id: jobId,
      status: "settled",
      agent: { label: "worker", ensName: "worker.nightshift.eth" },
      asset: "0.0.429274",
    });
    expect(result).not.toHaveProperty("buyer_account");
    expect(result).not.toHaveProperty("error");
    expect(result).not.toHaveProperty("output");
    expect(result).not.toHaveProperty("input");
  });

  it("rejects a database record that does not match the requested id", () => {
    expect(() =>
      safeJobStatus(jobId, {
        id: "77d434ed-8a69-4f2c-9e90-f0e9ce76c028",
        status: "done",
        units: 1,
        price_atomic: "30000",
        hedera_tx_id: null,
        hcs_sequence: null,
        output_sha256: "a".repeat(64),
        created_at: "2025-01-01T00:00:00.000Z",
        agents: { label: "worker", ens_name: "worker.nightshift.eth" },
      }),
    ).toThrow(/mismatched/);
  });

  it("serves a valid status through a matching capability", async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: {
        id: jobId,
        status: "settled",
        units: 1,
        price_atomic: "30000",
        hedera_tx_id: "0.0.100@123456789.000000001",
        hcs_sequence: "19",
        output_sha256: "a".repeat(64),
        created_at: "2025-01-01T00:00:00.000Z",
        agents: { label: "worker", ens_name: "worker.nightshift.eth" },
      },
      error: null,
    });
    const token = createJobStatusToken(jobId, mocks.privateKey);
    const response = await fetch(`${baseUrl}/jobs/${jobId}/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: jobId,
      status: "settled",
      agent: { label: "worker", ensName: "worker.nightshift.eth" },
    });
  });
});
