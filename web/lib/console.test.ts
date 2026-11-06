import { describe, expect, it } from "vitest";
import { initialConsoleState, parseBuyerEvent, parseSseFrame, reduceConsole } from "./console";

const timestamp = "2030-11-06T00:00:00.000Z";

describe("buyer console SSE handling", () => {
  it("parses named events, multi-line data and the server run id comment", () => {
    expect(parseSseFrame(": run-123\n\n")).toEqual({
      event: "message",
      data: "",
      comment: "run-123",
    });
    expect(
      parseSseFrame('event: verify\r\ndata: {"kind":"verify",\r\ndata: "ok":true}\r\n\r\n'),
    ).toEqual({
      event: "verify",
      data: '{"kind":"verify",\n"ok":true}',
    });
  });

  it("rejects malformed or mismatched named events", () => {
    expect(() => parseBuyerEvent("verify", '{"kind":"paid","timestamp":"now"}')).toThrow(
      "Malformed verify event",
    );
    expect(() =>
      parseBuyerEvent("verify", '{"kind":"verify","timestamp":"now","label":4,"ok":true}'),
    ).toThrow("Malformed verify event");
  });

  it("maps real buyer events into wire states and ignores duplicate recovered events", () => {
    const discovered = {
      kind: "discover" as const,
      timestamp,
      candidates: [
        {
          label: "kural",
          ensName: "kural.nightshift.eth",
          skill: "transcribe:ta",
          priceAtomic: "20000",
          reputation: null,
        },
        {
          label: "scribe",
          ensName: "scribe.nightshift.eth",
          skill: "transcribe:ta",
          priceAtomic: "30000",
          reputation: null,
        },
      ],
    };
    const verified = {
      kind: "verify" as const,
      label: "scribe",
      ensName: "scribe.nightshift.eth",
      ok: true,
      timestamp,
    };
    const paid = {
      kind: "paid" as const,
      label: "scribe",
      txId: "0.0.123@10.20",
      hashscanUrl: "https://hashscan.io/testnet/transaction/0.0.123-10-20",
      amount: "60000",
      timestamp,
    };
    const result = { kind: "result" as const, label: "scribe", text: "வணக்கம்", timestamp };
    let state = reduceConsole(initialConsoleState, { type: "start", runId: "run-123" });
    state = reduceConsole(state, { type: "event", event: discovered });
    state = reduceConsole(state, { type: "event", event: verified });
    state = reduceConsole(state, { type: "event", event: paid });
    state = reduceConsole(state, { type: "event", event: result });

    expect(state.wire).toEqual({ kural: "found", scribe: "done" });
    expect(state.events).toHaveLength(4);
    expect(reduceConsole(state, { type: "event", event: result })).toBe(state);
  });

  it("keeps the run recoverable without starting a second paid request", () => {
    const running = reduceConsole(initialConsoleState, { type: "start", runId: "run-123" });
    const disconnected = reduceConsole(running, { type: "connection-error", message: "lost" });
    const resumed = reduceConsole(disconnected, { type: "resume" });
    expect(resumed.phase).toBe("resuming");
    expect(resumed.runId).toBe("run-123");
    expect(resumed.error).toBeNull();
  });
});

describe("amount validation (values later passed to BigInt)", () => {
  const paid = (amount: unknown) =>
    JSON.stringify({
      kind: "paid",
      timestamp: "now",
      label: "tamil-scribe",
      amount,
      txId: "0.0.1@1.2",
      hashscanUrl: "https://hashscan.io/testnet/transaction/x",
    });
  it("accepts integer-string amounts and rejects anything BigInt would throw on", () => {
    expect(() => parseBuyerEvent("paid", paid("60000"))).not.toThrow();
    for (const bad of ["0.06", "", "abc", 60000])
      expect(() => parseBuyerEvent("paid", paid(bad)), String(bad)).toThrow();
  });
});

describe("parseBuyerBudget", () => {
  const budget = {
    rules: {
      maxPerJobAtomic: "100000",
      dailyBudgetAtomic: "1000000",
      allowedAssets: ["0.0.429274"],
      allowedNetworks: ["hedera:testnet"],
      allowParentNames: ["nightshift.eth"],
      minSuccess: 0.9,
      humanApprovalAboveAtomic: "500000",
    },
    state: {
      date: "2030-11-06",
      dailySpentAtomic: "120000",
      totalSpentAtomic: "800000",
      jobsCompleted: 9,
      lastUpdated: "x",
    },
    wallet: { accountId: "0.0.11129925", usdcAtomic: "19130000" },
  };
  it("accepts the real server shape, with or without a wallet balance", async () => {
    const { parseBuyerBudget } = await import("./console");
    expect(parseBuyerBudget(budget)).toEqual(budget);
    expect(() => parseBuyerBudget({ ...budget, wallet: null })).not.toThrow();
    expect(() => parseBuyerBudget({ rules: budget.rules, state: budget.state })).not.toThrow();
    expect(() =>
      parseBuyerBudget({
        ...budget,
        wallet: { accountId: "0.0.1", usdcAtomic: null, error: "mirror node unavailable" },
      }),
    ).not.toThrow();
  });
  it("rejects malformed amounts with a readable error instead of crashing the page", async () => {
    const { parseBuyerBudget } = await import("./console");
    for (const bad of [
      { ...budget, rules: { ...budget.rules, dailyBudgetAtomic: 1000000 } },
      { ...budget, state: { ...budget.state, dailySpentAtomic: undefined } },
      { ...budget, wallet: { accountId: "0.0.1", usdcAtomic: "19.13" } },
      { rules: budget.rules },
      null,
    ])
      expect(() => parseBuyerBudget(bad)).toThrow(/malformed/);
  });
});
