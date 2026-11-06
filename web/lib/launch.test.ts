import { describe, expect, it } from "vitest";
import {
  atomicFromDecimal,
  capFromCredits,
  decimalFromAtomic,
  parseLaunchLine,
  readLaunchStream,
  stepStates,
  type LaunchLine,
} from "./launch";

describe("money conversion", () => {
  it("converts decimals to atomic units exactly and rejects bad input", () => {
    expect(atomicFromDecimal("0.03")).toBe(30_000n);
    expect(atomicFromDecimal(" 1 ")).toBe(1_000_000n);
    expect(atomicFromDecimal("0.000001")).toBe(1n);
    for (const bad of ["", "-1", "1e3", "0.0000001", "1,5", "abc"])
      expect(atomicFromDecimal(bad)).toBeNull();
  });
  it("formats atomic units back without float error", () => {
    expect(decimalFromAtomic(31_200n)).toBe("0.0312");
    expect(decimalFromAtomic(2_000_000n)).toBe("2");
    expect(decimalFromAtomic(1n)).toBe("0.000001");
  });
  it("defaults the cap to 80% of credits, rounded down", () => {
    expect(capFromCredits(5_000_000n)).toBe(4_000_000n);
    expect(capFromCredits(1n)).toBe(0n);
    expect(() => capFromCredits(1n, 0)).toThrow();
  });
});

describe("launch stream", () => {
  it("accepts well-formed lines and rejects malformed ones", () => {
    expect(parseLaunchLine('{"type":"progress","step":"zg_key","status":"done"}')).toEqual({
      type: "progress",
      step: "zg_key",
      status: "done",
    });
    expect(parseLaunchLine('{"type":"progress","step":"mint","status":"done"}')).toBeNull();
    expect(
      parseLaunchLine('{"type":"progress","step":"drip","status":"done","txHash":1}'),
    ).toBeNull();
    expect(parseLaunchLine('{"type":"done","result":{"ensName":"x"}}')).toBeNull();
    expect(parseLaunchLine("not json")).toBeNull();
    expect(parseLaunchLine('{"type":"error","error":"label_taken","message":"taken"}')).toEqual({
      type: "error",
      error: "label_taken",
      message: "taken",
    });
  });

  it("folds progress into ordered step rows, keeping tx hashes and notes", () => {
    const lines: LaunchLine[] = [
      { type: "progress", step: "validate", status: "done" },
      { type: "progress", step: "hedera_account", status: "done", account: "0.0.9" },
      { type: "progress", step: "ens_register", status: "sent", txHash: "0xabc" },
      {
        type: "progress",
        step: "drip",
        status: "skipped",
        reason: "owner already has Sepolia ETH",
      },
    ];
    const rows = stepStates(lines);
    expect(rows.map((r) => r.step)).toEqual([
      "validate",
      "zg_key",
      "hedera_account",
      "ens_register",
      "drip",
    ]);
    expect(rows[1]!.status).toBe("waiting");
    expect(rows[2]).toMatchObject({ status: "done", account: "0.0.9" });
    expect(rows[3]).toMatchObject({ status: "sent", txHash: "0xabc" });
    expect(rows[4]).toMatchObject({ status: "skipped", note: "owner already has Sepolia ETH" });
  });

  it("reads lines split across chunks and a final line without a newline", async () => {
    const enc = new TextEncoder();
    const chunks = [
      '{"type":"progress","step":"validate",',
      '"status":"running"}\n{"type":"progress","step":"validate","status":"done"}\n',
      '{"type":"error","error":"internal","message":"boom"}',
    ];
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const chunk of chunks) c.enqueue(enc.encode(chunk));
        c.close();
      },
    });
    const seen: LaunchLine[] = [];
    await readLaunchStream(body, (line) => seen.push(line));
    expect(seen.map((l) => l.type)).toEqual(["progress", "progress", "error"]);
  });

  it("throws on a malformed line", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("{bad}\n"));
        c.close();
      },
    });
    await expect(readLaunchStream(body, () => {})).rejects.toThrow(/malformed/);
  });
});
