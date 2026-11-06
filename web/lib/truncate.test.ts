import { describe, expect, it } from "vitest";
import { truncateMiddle } from "./truncate";

describe("truncateMiddle", () => {
  it("keeps short values intact", () => {
    expect(truncateMiddle("0x123456")).toBe("0x123456");
  });

  it("preserves the requested prefix and suffix", () => {
    expect(truncateMiddle("0x1234567890abcdef")).toBe("0x1234…cdef");
  });

  it("rejects invalid truncation lengths", () => {
    expect(() => truncateMiddle("value", 0)).toThrow(RangeError);
    expect(() => truncateMiddle("value", 2, 1.5)).toThrow(RangeError);
  });
});
