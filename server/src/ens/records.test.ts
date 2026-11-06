import { OWNER_KEYS } from "@nightshift/shared";
import { describe, expect, it } from "vitest";
import { buildInitialRecords, formatUsdc, titleFromLabel } from "./records.js";

describe("formatUsdc", () => {
  it("formats atomic USDC exactly", () => {
    expect(formatUsdc(30_000n)).toBe("0.03");
    expect(formatUsdc(1_000_000n)).toBe("1");
    expect(formatUsdc(1_234_567n)).toBe("1.234567");
    expect(formatUsdc(1n)).toBe("0.000001");
    expect(formatUsdc(0n)).toBe("0");
  });
});

describe("buildInitialRecords", () => {
  const recs = buildInitialRecords({
    label: "tamil-scribe",
    ensName: "tamil-scribe.nightshift.eth",
    skill: "transcribe:ta",
    model: "whisper-large-v3",
    priceAtomic: 30_000n,
    priceUnit: "minute",
    payTo: "0.0.123",
    usdcTokenId: "0.0.429274",
    serverUrl: "http://localhost:8787",
    webUrl: "http://localhost:3000",
  });
  const get = (k: string) => recs.find((r) => r.key === k)?.value;

  it("only uses owner keys (registrar reverts otherwise)", () => {
    for (const r of recs) expect(OWNER_KEYS).toContain(r.key);
  });
  it("fills the agent records", () => {
    expect(titleFromLabel("tamil-scribe")).toBe("Tamil Scribe");
    expect(get("agent-context")).toMatch(/^# Tamil Scribe\nTranscribes Tamil audio/);
    expect(get("agent-context")).toContain("0.03 USDC per minute");
    expect(get("agent-endpoint[x402]")).toBe("http://localhost:8787/a/tamil-scribe/run");
    expect(JSON.parse(get("nightshift.price")!)).toEqual({
      amount: "30000",
      asset: "0.0.429274",
      network: "hedera:testnet",
      unit: "minute",
    });
    expect(get("nightshift.payto")).toBe("0.0.123");
    expect(get("description")).toMatch(/^Transcribes Tamil audio to text\./);
  });
  it("uses the owner's description when one is given, ignoring blank input", () => {
    const base = {
      label: "tamil-scribe",
      ensName: "tamil-scribe.nightshift.eth",
      skill: "transcribe:ta",
      model: "whisper-large-v3",
      priceAtomic: 30_000n,
      priceUnit: "minute",
      payTo: "0.0.123",
      usdcTokenId: "0.0.429274",
      serverUrl: "http://localhost:8787",
      webUrl: "http://localhost:3000",
    };
    const custom = buildInitialRecords({ ...base, description: "  Podcast-grade Tamil.  " });
    expect(custom.find((r) => r.key === "description")?.value).toBe("Podcast-grade Tamil.");
    const blank = buildInitialRecords({ ...base, description: "   " });
    expect(blank.find((r) => r.key === "description")?.value).toMatch(/^Transcribes Tamil/);
  });
});

describe("owner record edits", () => {
  const current = {
    label: "tamil-scribe",
    ensName: "tamil-scribe.nightshift.eth",
    skill: "transcribe:ta",
    model: "whisper-large-v3",
    priceAtomic: 30_000n,
    priceUnit: "minute",
    payTo: "0.0.123",
    usdcTokenId: "0.0.429274",
    serverUrl: "http://localhost:8787",
    webUrl: "http://localhost:3000",
  };
  it("a price edit rewrites price and context together", async () => {
    const { draftRecordEdits } = await import("./records.js");
    const recs = draftRecordEdits(current, { priceAtomic: 25_000n });
    expect(recs.map((r) => r.key).sort()).toEqual(["agent-context", "nightshift.price"]);
    expect(JSON.parse(recs.find((r) => r.key === "nightshift.price")!.value).amount).toBe("25000");
    expect(recs.find((r) => r.key === "agent-context")!.value).toContain("0.025 USDC per minute");
  });
  it("a description edit writes only the description", async () => {
    const { draftRecordEdits } = await import("./records.js");
    expect(draftRecordEdits(current, { description: "New text" })).toEqual([
      { key: "description", value: "New text" },
    ]);
  });
  it("parses a price record strictly", async () => {
    const { parsePriceRecord } = await import("./records.js");
    const exp = { asset: "0.0.429274", unit: "minute" };
    const good = JSON.stringify({
      amount: "25000",
      asset: "0.0.429274",
      network: "hedera:testnet",
      unit: "minute",
    });
    expect(parsePriceRecord(good, exp)).toEqual({ ok: true, amount: 25_000n });
    for (const bad of [
      undefined,
      "nope",
      good.replace('"25000"', '"0"'),
      good.replace('"25000"', "25000"),
      good.replace("0.0.429274", "0.0.1"),
      good.replace("hedera:testnet", "hedera:mainnet"),
      good.replace('"minute"', '"page"'),
    ])
      expect(parsePriceRecord(bad, exp).ok).toBe(false);
  });
});
