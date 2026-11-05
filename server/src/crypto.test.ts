import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "./crypto.js";

const key = randomBytes(32).toString("hex");

describe("crypto", () => {
  it("round-trips", () => {
    const blob = encrypt("sk-secret-value", key);
    expect(blob.startsWith("v1.")).toBe(true);
    expect(blob).not.toContain("sk-secret-value");
    expect(decrypt(blob, key)).toBe("sk-secret-value");
  });

  it("uses a fresh IV each time", () => {
    expect(encrypt("x", key)).not.toBe(encrypt("x", key));
  });

  it("rejects a tampered ciphertext", () => {
    const [v, iv, tag, ct] = encrypt("hello world", key).split(".");
    const flipped = Buffer.from(ct!, "base64");
    flipped[0]! ^= 1;
    expect(() => decrypt([v, iv, tag, flipped.toString("base64")].join("."), key)).toThrow();
  });

  it("rejects the wrong key", () => {
    expect(() => decrypt(encrypt("x", key), randomBytes(32).toString("hex"))).toThrow();
  });
});
