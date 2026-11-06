import { describe, expect, it } from "vitest";
import {
  initialConsoleState,
  interpretSseFrame,
  parseBuyerEvent,
  parseSseFrame,
  reduceConsole,
} from "./console";

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

describe("interpretSseFrame (the live /buyer-console/run stream)", () => {
  const ts = "2030-11-06T14:29:17.149Z";
  const tamil = {
    label: "tamil-scribe",
    ensName: "tamil-scribe.nightshift.eth",
    payTo: "0.0.11323621",
  };
  const kural = { label: "kural", ensName: "kural.nightshift.eth", payTo: "0.0.11325237" };
  const frame = (event: string, data: unknown) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  // Same frames, in the same order, as the server wrote for run-1793975357081.
  const stream =
    ": run-1793975357081\n\n" +
    frame("plan", {
      kind: "plan",
      task: { file: "tamil-90s.mp3", skill: "transcribe:ta", units: 2 },
      rules: { minSuccess: 0.9 },
      timestamp: ts,
    }) +
    frame("discover", {
      kind: "discover",
      timestamp: ts,
      candidates: [
        {
          label: "kural",
          skill: "transcribe:ta",
          ensName: kural.ensName,
          reputation: { jobs: 0, success: 1 },
          priceAtomic: "20000",
        },
        {
          label: "tamil-scribe",
          skill: "transcribe:ta",
          ensName: tamil.ensName,
          reputation: { jobs: 5, success: 1 },
          priceAtomic: "30000",
        },
      ],
    }) +
    ": ping\n\n" +
    frame("verify", { kind: "verify", ok: true, ...tamil, resolver: "0xD", timestamp: ts }) +
    frame("verify", { kind: "verify", ok: true, ...kural, resolver: "0xd", timestamp: ts }) +
    frame("decide", {
      kind: "decide",
      chosen: { ...kural, priceAtomic: "20000" },
      rejected: [],
      rationale: "cheapest",
      timestamp: ts,
    }) +
    frame("quote", {
      kind: "quote",
      asset: "0.0.429274",
      label: "kural",
      payTo: kural.payTo,
      units: 2,
      amount: "40000",
      timestamp: ts,
    }) +
    frame("refused", {
      kind: "refused",
      label: "kural",
      reason: "over_budget",
      status: 503,
      timestamp: ts,
    }) +
    frame("decide", {
      kind: "decide",
      chosen: { ...tamil, priceAtomic: "30000" },
      rejected: [{ label: "kural", reason: "over_budget" }],
      rationale: "next",
      timestamp: ts,
    }) +
    frame("quote", {
      kind: "quote",
      asset: "0.0.429274",
      label: "tamil-scribe",
      payTo: tamil.payTo,
      units: 2,
      amount: "60000",
      timestamp: ts,
    }) +
    frame("paid", {
      kind: "paid",
      txId: "0.0.9185802@1793975366.813205525",
      label: "tamil-scribe",
      amount: "60000",
      hashscanUrl: "https://hashscan.io/testnet/transaction/x",
      timestamp: ts,
    }) +
    frame("result", {
      kind: "result",
      text: "வணக்கம்",
      jobId: "6b04",
      label: "tamil-scribe",
      latencyMs: 29199,
      timestamp: ts,
    }) +
    frame("complete", {
      success: true,
      chosen: tamil.ensName,
      tx: "0.0.9185802@1793975366.813205525",
      error: null,
    });

  function play(text: string) {
    let state = reduceConsole(initialConsoleState, { type: "start", runId: "" });
    for (const raw of text.split("\n\n").filter(Boolean)) {
      const outcome = interpretSseFrame(raw);
      if (!outcome) continue;
      if (outcome.kind === "run-id")
        state = reduceConsole(state, { type: "set-run-id", runId: outcome.runId });
      else if (outcome.kind === "event")
        state = reduceConsole(state, { type: "event", event: outcome.event });
      else
        state = reduceConsole(state, {
          type: "complete",
          success: outcome.result.success,
          message: outcome.result.error ?? undefined,
        });
    }
    return state;
  }

  it("renders a full live run: run id, every event, wire states and completion", () => {
    const state = play(stream);
    expect(state.runId).toBe("run-1793975357081");
    expect(state.phase).toBe("complete");
    expect(state.error).toBeNull();
    expect(state.events.map((e) => e.kind)).toEqual([
      "plan",
      "discover",
      "verify",
      "verify",
      "decide",
      "quote",
      "refused",
      "decide",
      "quote",
      "paid",
      "result",
    ]);
    expect(state.wire).toEqual({ kural: "refused", "tamil-scribe": "done" });
  });

  it("ignores comment-only frames (run id handled separately, pings dropped)", () => {
    expect(interpretSseFrame(": ping")).toBeNull();
    expect(interpretSseFrame(": run-17")).toEqual({ kind: "run-id", runId: "run-17" });
  });

  it("reports a failed run's error from the complete frame", () => {
    expect(
      interpretSseFrame('event: complete\ndata: {"success":false,"error":"no worker fits"}'),
    ).toEqual({ kind: "complete", result: { success: false, error: "no worker fits" } });
    expect(() => interpretSseFrame('event: complete\ndata: {"ok":true}')).toThrow(/Malformed/);
  });
});
